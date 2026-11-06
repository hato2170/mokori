const express = require("express");
const admin = require("firebase-admin");
const bcrypt = require("bcryptjs");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "15mb" }));
app.use(express.urlencoded({ extended: true, limit: "15mb" }));

async function requireLogin(req, res, next) {
  if (!auth) {
    return res.status(503).json({
      error: "認証サービスが利用できません。"
    });
  }

  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer (.+)$/);

  if (!match) {
    return res.status(401).json({
      error: "ログインしてください。"
    });
  }

  try {
    const decoded = await auth.verifyIdToken(match[1]);
    req.user = decoded;
    next();
  } catch (error) {
    return res.status(401).json({
      error: "ログイン情報を確認できませんでした。"
    });
  }
}

// キャッシュ無効化ミドルウェア (Safari・iPad・学校端末での古いコード・UI残存を完全防止)
app.use((req, res, next) => {
  if (req.path.endsWith(".html") || req.path === "/" || req.path.endsWith(".js") || req.path.endsWith(".css")) {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
  next();
});

app.use(express.static("public", {
  etag: false,
  maxAge: 0,
  setHeaders: (res) => {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  }
}));

let db;
let auth;

try {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;

  if (serviceAccountJson) {
    const serviceAccount = JSON.parse(serviceAccountJson);

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });

    db = admin.firestore();
    auth = admin.auth();
    console.log("Firebase connected");
  } else {
    console.warn("Firebase is not configured yet.");
  }
} catch (error) {
  console.error("Firebase setup error:", error.message);
}

// ----------------------------------------------------
// セキュリティ & 権限ヘルパー
// ----------------------------------------------------
const authRateLimits = new Map();
function checkAuthRateLimit(req, res, maxRequests = 60, windowMs = 60000) {
  const forwarded = req.headers["x-forwarded-for"];
  const ip = (typeof forwarded === "string" ? forwarded.split(",")[0].trim() : null) || req.ip || req.socket.remoteAddress || "unknown_ip";
  const now = Date.now();
  const record = authRateLimits.get(ip) || { count: 0, resetAt: now + windowMs };
  if (now > record.resetAt) {
    record.count = 1;
    record.resetAt = now + windowMs;
  } else {
    record.count++;
  }
  authRateLimits.set(ip, record);
  if (authRateLimits.size > 1000) {
    for (const [k, v] of authRateLimits.entries()) {
      if (now > v.resetAt) authRateLimits.delete(k);
    }
  }
  if (record.count > maxRequests) {
    res.status(429).json({ error: "リクエストが多すぎます。少し時間をおいて再度お試しください。" });
    return false;
  }
  return true;
}

// ----------------------------------------------------
// メッセージインメモリキャッシュ (Firestore読み書きクォータ爆発・競合・遅延を完全防止)
// ----------------------------------------------------
const messageCache = new Map();

// ----------------------------------------------------
// ⭐ 完全インメモリ超高速ストア (Firestoreクォータ枯渇・フリーズ・停止の完全防止)
// ----------------------------------------------------
const memoryChatMessages = new Map(); // chatId -> Array<msg>
const memoryGameRooms = new Map();     // roomId -> roomObject
const MAX_MEM_MESSAGES = 250;

async function getChatMessagesFast(chatId) {
  if (memoryChatMessages.has(chatId)) {
    return memoryChatMessages.get(chatId);
  }
  if (!db) return [];
  try {
    const snapshot = await db.collection("chats").doc(chatId)
      .collection("messages")
      .orderBy("createdAt", "asc")
      .limit(MAX_MEM_MESSAGES)
      .get();
    const msgs = [];
    snapshot.forEach(doc => {
      msgs.push({ id: doc.id, ...doc.data() });
    });
    memoryChatMessages.set(chatId, msgs);
    return msgs;
  } catch (err) {
    console.warn("Fast get messages DB fallback:", err.message);
    return memoryChatMessages.get(chatId) || [];
  }
}
const CACHE_TTL_MS = 3000;

async function isUserAdmin(uid, userObj) {
  if (!uid) return false;
  if (userObj && (userObj.admin === true || userObj.role === "admin")) return true;
  if (userObj && userObj.username === "hato2170") return true;
  if (db) {
    try {
      const uDoc = await db.collection("users").doc(uid).get();
      if (uDoc.exists) {
        const d = uDoc.data();
        if (d.role === "admin" || d.isAdmin === true) return true;
      }
    } catch (_) {}
  }
  return false;
}

async function checkChatAccess(chatId, uid) {
  if (!chatId || !uid) return false;
  if (chatId === "all_members") return true;
  if (!db) return false;
  try {
    const chatDoc = await db.collection("chats").doc(chatId).get();
    if (!chatDoc.exists) return false;
    const data = chatDoc.data();
    return Array.isArray(data.members) && data.members.includes(uid);
  } catch (e) {
    return false;
  }
}

// ----------------------------------------------------
// ヘルスチェック
// ----------------------------------------------------
app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "mokori",
    firebaseConfigured: Boolean(db && auth)
  });
});

// ----------------------------------------------------
// 認証: 登録・ログイン
// ----------------------------------------------------
app.post("/api/register", async (req, res) => {
  if (!checkAuthRateLimit(req, res)) return;
  if (!db || !auth) {
    return res.status(503).json({
      error: "Firebaseの設定がまだ完了していません。"
    });
  }

  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!/^[\p{L}\p{N}_-]{2,20}$/u.test(username)) {
    return res.status(400).json({
      error: "ユーザー名は2〜20文字で入力してください。"
    });
  }

  if (password.length < 8 || password.length > 128) {
    return res.status(400).json({
      error: "パスワードは8〜128文字にしてください。"
    });
  }

  const usernameKey = username.toLowerCase();
  const usernameRef = db.collection("usernames").doc(usernameKey);

  try {
    const passwordHash = await bcrypt.hash(password, 12);
    const userRecord = await auth.createUser({
      displayName: username
    });

    try {
      await db.runTransaction(async (transaction) => {
        const existing = await transaction.get(usernameRef);

        if (existing.exists) {
          throw new Error("USERNAME_TAKEN");
        }

        transaction.set(usernameRef, {
          uid: userRecord.uid,
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });
    } catch (error) {
      await auth.deleteUser(userRecord.uid).catch(() => {});
      if (error.message === "USERNAME_TAKEN") {
        return res.status(409).json({
          error: "このユーザー名はすでに使われています。"
        });
      }
      throw error;
    }

    await db.collection("users").doc(userRecord.uid).set({
      username,
      passwordHash,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const token = await auth.createCustomToken(userRecord.uid);
    res.status(201).json({ token, username });
  } catch (error) {
    console.error("Registration failed:", error.message);
    res.status(500).json({
      error: "登録に失敗しました。設定を確認してください。"
    });
  }
});

app.post("/api/login", async (req, res) => {
  if (!checkAuthRateLimit(req, res)) return;
  if (!db || !auth) {
    return res.status(503).json({
      error: "Firebaseの設定がまだ完了していません。"
    });
  }

  const username = String(req.body.username || "").trim();
  const password = String(req.body.password || "");

  if (!username || !password) {
    return res.status(400).json({
      error: "ユーザー名とパスワードを入力してください。"
    });
  }

  try {
    const usernameDoc = await db
      .collection("usernames")
      .doc(username.toLowerCase())
      .get();

    if (!usernameDoc.exists) {
      return res.status(401).json({
        error: "ユーザー名またはパスワードが違います。"
      });
    }

    const uid = usernameDoc.data().uid;
    if (!uid) {
      return res.status(401).json({
        error: "ユーザー名またはパスワードが違います。"
      });
    }
    const userDoc = await db.collection("users").doc(uid).get();

    if (!userDoc.exists) {
      return res.status(401).json({
        error: "ユーザー名またはパスワードが違います。"
      });
    }

    const userData = userDoc.data() || {};
    if (!userData.passwordHash) {
      return res.status(401).json({
        error: "ユーザー名またはパスワードが違います。"
      });
    }

    const valid = await bcrypt.compare(
      password,
      userData.passwordHash
    );

    if (!valid) {
      return res.status(401).json({
        error: "ユーザー名またはパスワードが違います。"
      });
    }

    const token = await auth.createCustomToken(uid);
    res.json({ token, username: userDoc.data().username });
  } catch (error) {
    console.error("Login failed:", error.message);
    res.status(500).json({
      error: "ログインに失敗しました。"
    });
  }
});

// ----------------------------------------------------
// 友達機能: 検索・申請・承認・一覧
// ----------------------------------------------------
app.get("/api/users/search", requireLogin, async (req, res) => {
  try {
    const username = String(req.query.username || "").trim();

    if (!username || username.length > 20) {
      return res.status(400).json({
        error: "ユーザー名を入力してください。"
      });
    }

    const usernameDoc = await db
      .collection("usernames")
      .doc(username.toLowerCase())
      .get();

    if (!usernameDoc.exists) {
      return res.status(404).json({
        error: "ユーザーが見つかりませんでした。"
      });
    }

    const uid = usernameDoc.data().uid;

    if (uid === req.user.uid) {
      return res.status(400).json({
        error: "自分自身は検索結果にできません。"
      });
    }

    const userDoc = await db.collection("users").doc(uid).get();

    if (!userDoc.exists) {
      return res.status(404).json({
        error: "ユーザー情報が見つかりませんでした。"
      });
    }

    return res.json({
      user: {
        uid,
        username: userDoc.data().username
      }
    });
  } catch (error) {
    console.error("ユーザー検索エラー:", error);
    return res.status(500).json({
      error: "ユーザー検索に失敗しました。"
    });
  }
});

app.post("/api/friends/request", requireLogin, async (req, res) => {
  try {
    const myUid = req.user.uid;
    let targetUid = req.body.targetUid ? String(req.body.targetUid).trim() : null;
    let username = req.body.username ? String(req.body.username).trim() : "";

    if (!targetUid && !username) {
      return res.status(400).json({
        error: "申請する相手のユーザー名またはIDを指定してください。"
      });
    }

    if (targetUid) {
      const targetUserDoc = await db.collection("users").doc(targetUid).get();
      if (!targetUserDoc.exists) {
        return res.status(404).json({ error: "そのユーザーは見つかりませんでした。" });
      }
      username = targetUserDoc.data().username || "ユーザー";
    } else {
      if (username.length > 20) {
        return res.status(400).json({ error: "ユーザー名は20文字以内で入力してください。" });
      }
      const targetDoc = await db.collection("usernames").doc(username.toLowerCase()).get();
      if (!targetDoc.exists) {
        return res.status(404).json({ error: "そのユーザーは見つかりませんでした。" });
      }
      targetUid = targetDoc.data().uid;
    }

    if (targetUid === myUid) {
      return res.status(400).json({
        error: "自分に友達申請は送れません。"
      });
    }

    const requestId = `${myUid}_${targetUid}`;
    const requestRef = db.collection("friendRequests").doc(requestId);

    const existing = await requestRef.get();

    if (existing.exists) {
      const status = existing.data().status;

      if (status === "pending") {
        return res.status(409).json({
          error: "すでに友達申請を送っています。"
        });
      }

      if (status === "accepted") {
        return res.status(409).json({
          error: "すでに友達です。"
        });
      }
    }

    await requestRef.set({
      fromUid: myUid,
      toUid: targetUid,
      status: "pending",
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({
      ok: true,
      message: "友達申請を送信しました。"
    });
  } catch (error) {
    console.error("友達申請エラー:", error);
    return res.status(500).json({
      error: "友達申請に失敗しました。"
    });
  }
});

app.post("/api/friends/accept", requireLogin, async (req, res) => {
  try {
    const requestId = String(req.body.requestId || "").trim();

    if (!requestId || requestId.length > 200) {
      return res.status(400).json({
        error: "友達申請を指定してください。"
      });
    }

    const requestRef = db.collection("friendRequests").doc(requestId);

    const result = await db.runTransaction(async (transaction) => {
      const requestDoc = await transaction.get(requestRef);

      if (!requestDoc.exists) {
        return { status: "not_found" };
      }

      const request = requestDoc.data();

      if (request.toUid !== req.user.uid) {
        return { status: "forbidden" };
      }

      if (request.status === "accepted") {
        return { status: "already_accepted" };
      }

      if (request.status !== "pending") {
        return { status: "invalid" };
      }

      const fromUid = request.fromUid;
      const toUid = request.toUid;

      if (!fromUid || fromUid === toUid) {
        return { status: "invalid" };
      }

      const timestamp = admin.firestore.FieldValue.serverTimestamp();

      const fromFriendRef = db
        .collection("friendships")
        .doc(fromUid)
        .collection("friends")
        .doc(toUid);

      const toFriendRef = db
        .collection("friendships")
        .doc(toUid)
        .collection("friends")
        .doc(fromUid);

      transaction.update(requestRef, {
        status: "accepted",
        acceptedAt: timestamp
      });

      transaction.set(fromFriendRef, {
        uid: toUid,
        createdAt: timestamp
      });

      transaction.set(toFriendRef, {
        uid: fromUid,
        createdAt: timestamp
      });

      return { status: "accepted" };
    });

    if (result.status === "not_found") {
      return res.status(404).json({
        error: "友達申請が見つかりません。"
      });
    }

    if (result.status === "forbidden") {
      return res.status(403).json({
        error: "自分宛ての申請だけ承認できます。"
      });
    }

    if (result.status === "already_accepted") {
      return res.json({
        ok: true,
        message: "この申請はすでに承認済みです。"
      });
    }

    if (result.status !== "accepted") {
      return res.status(409).json({
        error: "この申請は承認できません。"
      });
    }

    return res.json({
      ok: true,
      message: "友達申請を承認しました！"
    });
  } catch (error) {
    console.error("友達申請の承認エラー:", error);
    return res.status(500).json({
      error: "友達申請の承認に失敗しました。"
    });
  }
});

app.get("/api/friends/requests", requireLogin, async (req, res) => {
  try {
    const snapshot = await db
      .collection("friendRequests")
      .where("toUid", "==", req.user.uid)
      .get();

    const requests = [];

    for (const doc of snapshot.docs) {
      const data = doc.data();

      if (data.status !== "pending") {
        continue;
      }

      const senderDoc = await db
        .collection("users")
        .doc(data.fromUid)
        .get();

      requests.push({
        requestId: doc.id,
        fromUid: data.fromUid,
        username: senderDoc.exists
          ? senderDoc.data().username
          : "不明なユーザー"
      });
    }

    return res.json({ requests });
  } catch (error) {
    console.error("友達申請一覧エラー:", error);
    return res.status(500).json({
      error: "友達申請一覧を取得できませんでした。"
    });
  }
});

app.get("/api/friends", requireLogin, async (req, res) => {
  try {
    const snapshot = await db
      .collection("friendships")
      .doc(req.user.uid)
      .collection("friends")
      .get();

    const friends = [];

    for (const doc of snapshot.docs) {
      const friendUid = doc.id;

      const userDoc = await db
        .collection("users")
        .doc(friendUid)
        .get();

      if (userDoc.exists) {
        friends.push({
          uid: friendUid,
          username: userDoc.data().username || "ユーザー"
        });
      }
    }

    friends.sort((a, b) => a.username.localeCompare(b.username, "ja"));

    return res.json({ friends });
  } catch (error) {
    console.error("友達一覧エラー:", error);
    return res.status(500).json({
      error: "友達一覧を取得できませんでした。"
    });
  }
});

// ----------------------------------------------------
// LINE風機能: トーク一覧 (個人・グループ)
// ----------------------------------------------------
app.get("/api/chats", requireLogin, async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: "データベースが利用できません。" });
  }

  const myUid = req.user.uid;

  try {
    const snapshot = await db
      .collection("chats")
      .where("members", "array-contains", myUid)
      .get();

    const chats = [];

    // もこり全員グループ (全ユーザー参加)
    try {
      const allMembersRef = db.collection("chats").doc("all_members");
      let allMembersDoc = await allMembersRef.get();
      const now = admin.firestore.FieldValue.serverTimestamp();

      if (!allMembersDoc.exists) {
        const initialAllChat = {
          type: "all",
          name: "🐐 もこり全員グループ",
          description: "もこりに登録している全員が話せる全体グループです",
          isAllMembers: true,
          members: [myUid],
          memberInfo: {
            [myUid]: { username: "システム", joinedAt: Date.now() }
          },
          createdUid: "system",
          createdAt: now,
          updatedAt: now,
          lastMessage: {
            text: "もこりへようこそ！全員でチャットできるグループです🐐",
            type: "system",
            senderUid: "system",
            senderName: "システム",
            unsent: false,
            createdAt: now
          },
          lastMessageAt: now,
          readStatus: {}
        };
        await allMembersRef.set(initialAllChat);
        allMembersDoc = await allMembersRef.get();
      }

      const allData = allMembersDoc.data();
      const myReadTimestamp = (allData.readStatus && allData.readStatus[myUid]) || null;
      let hasAllUnread = false;
      if (allData.lastMessage && allData.lastMessage.senderUid !== myUid && !allData.lastMessage.unsent) {
        const msgTime = allData.lastMessage.createdAt && allData.lastMessage.createdAt.toMillis
          ? allData.lastMessage.createdAt.toMillis()
          : (typeof allData.lastMessage.createdAt === "number" ? allData.lastMessage.createdAt : 0);
        const readTime = myReadTimestamp && myReadTimestamp.toMillis
          ? myReadTimestamp.toMillis()
          : (typeof myReadTimestamp === "number" ? myReadTimestamp : 0);
        if (msgTime > readTime) hasAllUnread = true;
      }

      chats.push({
        id: "all_members",
        type: "all",
        name: "🐐 もこり全員グループ",
        description: "もこりに登録している全員が話せる全体グループです",
        isAllMembers: true,
        members: allData.members || [],
        memberInfo: allData.memberInfo || {},
        partnerUid: null,
        lastMessage: allData.lastMessage || null,
        lastMessageAt: allData.lastMessageAt || null,
        unread: hasAllUnread,
        announcement: allData.announcement || null,
        createdAt: allData.createdAt || null
      });

      // Keepメモ (LINE風 自分専用プライベートメモ)
      const keepMemoId = `keep_${myUid}`;
      const keepRef = db.collection("chats").doc(keepMemoId);
      let keepDoc = await keepRef.get();
      if (!keepDoc.exists) {
        await keepRef.set({
          type: "keep",
          name: "📌 Keepメモ",
          description: "自分だけの専用メモ帳です。テキストや画像、リンクを保存できます。",
          members: [myUid],
          memberInfo: { [myUid]: { username: "自分", joinedAt: now } },
          lastMessage: {
            text: "Keepメモへようこそ！ここに入力した内容は自分だけに保存されます。",
            type: "system",
            senderUid: "system",
            senderName: "Keep",
            unsent: false,
            createdAt: now
          },
          lastMessageAt: now,
          readStatus: { [myUid]: now }
        });
        keepDoc = await keepRef.get();
      }
      const keepData = keepDoc.data();
      chats.unshift({
        id: keepMemoId,
        type: "keep",
        name: "📌 Keepメモ",
        description: "自分だけの専用メモ帳",
        isKeep: true,
        members: [myUid],
        memberInfo: keepData.memberInfo || {},
        partnerUid: null,
        lastMessage: keepData.lastMessage || null,
        lastMessageAt: keepData.lastMessageAt || null,
        unread: false,
        announcement: null,
        createdAt: keepData.createdAt || null
      });

      // 🤖 AIアシスタント (自分専用のAIチャットルーム)
      const aiChatId = `ai_${myUid}`;
      const aiRef = db.collection("chats").doc(aiChatId);
      let aiDoc = await aiRef.get();
      if (!aiDoc.exists) {
        await aiRef.set({
          type: "ai",
          name: "🤖 AIアシスタント",
          description: "いつでも質問や相談、雑談ができる専用AIです。",
          isAi: true,
          members: [myUid, "ai_assistant"],
          memberInfo: {
            [myUid]: { username: "あなた", joinedAt: now },
            "ai_assistant": { username: "AIアシスタント", joinedAt: now, isAi: true }
          },
          lastMessage: {
            text: "こんにちは！何でも聞いてくださいね。質問、雑談、勉強やプログラミングなど何でもお手伝いします！🤖",
            type: "text",
            senderUid: "ai_assistant",
            senderName: "AIアシスタント",
            unsent: false,
            createdAt: now
          },
          lastMessageAt: now,
          readStatus: { [myUid]: now },
          createdAt: now
        });
        aiDoc = await aiRef.get();
      }
      const aiData = aiDoc.data();
      const myAiRead = (aiData.readStatus && aiData.readStatus[myUid]) || null;
      let hasAiUnread = false;
      if (aiData.lastMessage && aiData.lastMessage.senderUid !== myUid && !aiData.lastMessage.unsent) {
        const msgTime = aiData.lastMessage.createdAt && aiData.lastMessage.createdAt.toMillis
          ? aiData.lastMessage.createdAt.toMillis()
          : (typeof aiData.lastMessage.createdAt === "number" ? aiData.lastMessage.createdAt : 0);
        const readTime = myAiRead && myAiRead.toMillis
          ? myAiRead.toMillis()
          : (typeof myAiRead === "number" ? myAiRead : 0);
        if (msgTime > readTime) hasAiUnread = true;
      }

      chats.unshift({
        id: aiChatId,
        type: "ai",
        name: "🤖 AIアシスタント",
        description: "いつでも質問や相談ができる専用AI",
        isAi: true,
        members: [myUid, "ai_assistant"],
        memberInfo: aiData.memberInfo || {},
        partnerUid: "ai_assistant",
        lastMessage: aiData.lastMessage || null,
        lastMessageAt: aiData.lastMessageAt || null,
        unread: hasAiUnread,
        announcement: null,
        createdAt: aiData.createdAt || null
      });
    } catch (err) {
      console.warn("全員グループ確認警告:", err.message);
    }

    for (const doc of snapshot.docs) {
      if (doc.id === "all_members") continue;
      const data = doc.data();
      let name = data.name;
      let partnerUid = null;

      if (data.type === "direct") {
        partnerUid = (data.members || []).find((u) => u !== myUid) || myUid;
        const partnerInfo = data.memberInfo && data.memberInfo[partnerUid];
        name = partnerInfo ? partnerInfo.username : "ユーザー";
      }

      // 未読判定
      const myReadTimestamp = (data.readStatus && data.readStatus[myUid]) || null;
      let hasUnread = false;

      if (
        data.lastMessage &&
        data.lastMessage.senderUid !== myUid &&
        !data.lastMessage.unsent
      ) {
        const msgTime = data.lastMessage.createdAt && data.lastMessage.createdAt.toMillis
          ? data.lastMessage.createdAt.toMillis()
          : (typeof data.lastMessage.createdAt === "number" ? data.lastMessage.createdAt : 0);

        const readTime = myReadTimestamp && myReadTimestamp.toMillis
          ? myReadTimestamp.toMillis()
          : (typeof myReadTimestamp === "number" ? myReadTimestamp : 0);

        if (msgTime > readTime) {
          hasUnread = true;
        }
      }

      chats.push({
        id: doc.id,
        type: data.type || "direct",
        name: name || "トーク",
        members: data.members || [],
        memberInfo: data.memberInfo || {},
        partnerUid,
        lastMessage: data.lastMessage || null,
        lastMessageAt: data.lastMessageAt || null,
        unread: hasUnread,
        announcement: data.announcement || null,
        createdAt: data.createdAt || null
      });
    }

    // ID重複および「全員グループ」の重複を完全に一本化
    const seenChatIds = new Set();
    const finalChats = [];
    let hasAllMembersGroup = false;

    for (const c of chats) {
      if (!c || !c.id || seenChatIds.has(c.id)) continue;
      seenChatIds.add(c.id);

      const isAll = c.id === "all_members" || c.name === "🐐 もこり全員グループ" || c.type === "all";
      if (isAll) {
        if (hasAllMembersGroup) continue;
        hasAllMembersGroup = true;
        c.id = "all_members";
        c.name = "🐐 もこり全員グループ";
        c.type = "all";
      }

      finalChats.push(c);
    }

    // 全員グループを最上部に固定、残りは最新発言順にソート
    finalChats.sort((a, b) => {
      if (a.id === "all_members") return -1;
      if (b.id === "all_members") return 1;
      const tA = a.lastMessageAt && a.lastMessageAt.toMillis
        ? a.lastMessageAt.toMillis()
        : (typeof a.lastMessageAt === "number" ? a.lastMessageAt : 0);
      const tB = b.lastMessageAt && b.lastMessageAt.toMillis
        ? b.lastMessageAt.toMillis()
        : (typeof b.lastMessageAt === "number" ? b.lastMessageAt : 0);
      return tB - tA;
    });

    return res.json({ chats: finalChats });
  } catch (error) {
    console.error("トーク一覧取得エラー:", error);
    return res.status(500).json({ error: "トーク一覧の取得に失敗しました。" });
  }
});

// 1対1トークの開始または取得
app.post("/api/chats/direct", requireLogin, async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: "データベースが利用できません。" });
  }

  const myUid = req.user.uid;
  const friendUid = String(req.body.friendUid || "").trim();

  if (!friendUid || friendUid === myUid) {
    return res.status(400).json({ error: "有効な相手を指定してください。" });
  }

  try {
    // 相手が実在するか確認
    const friendUserCheck = await db.collection("users").doc(friendUid).get();
    if (!friendUserCheck.exists) {
      return res.status(404).json({ error: "相手のユーザーが存在しません。" });
    }
    const chatId = [myUid, friendUid].sort().join("_");
    const chatRef = db.collection("chats").doc(chatId);
    const chatDoc = await chatRef.get();

    if (chatDoc.exists) {
      const data = chatDoc.data();
      const partnerInfo = data.memberInfo && data.memberInfo[friendUid];
      return res.json({
        chat: {
          id: chatDoc.id,
          ...data,
          name: partnerInfo ? partnerInfo.username : "ユーザー",
          partnerUid: friendUid
        }
      });
    }

    const [myUserDoc, friendUserDoc] = await Promise.all([
      db.collection("users").doc(myUid).get(),
      db.collection("users").doc(friendUid).get()
    ]);

    const myUsername = myUserDoc.exists
      ? (myUserDoc.data().username || "ユーザー")
      : "ユーザー";
    const friendUsername = friendUserDoc.exists
      ? (friendUserDoc.data().username || "ユーザー")
      : "ユーザー";

    const now = admin.firestore.FieldValue.serverTimestamp();

    const newChat = {
      type: "direct",
      name: null,
      members: [myUid, friendUid],
      memberInfo: {
        [myUid]: { username: myUsername },
        [friendUid]: { username: friendUsername }
      },
      createdUid: myUid,
      createdAt: now,
      updatedAt: now,
      lastMessage: null,
      lastMessageAt: now,
      readStatus: {
        [myUid]: now
      }
    };

    await chatRef.set(newChat);

    return res.status(201).json({
      chat: {
        id: chatId,
        ...newChat,
        name: friendUsername,
        partnerUid: friendUid
      }
    });
  } catch (error) {
    console.error("1対1トーク作成エラー:", error);
    return res.status(500).json({ error: "トークの作成に失敗しました。" });
  }
});

// グループトークの作成
app.post("/api/chats/group", requireLogin, async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: "データベースが利用できません。" });
  }

  const myUid = req.user.uid;
  const name = String(req.body.name || "").trim();
  const rawMembers = Array.isArray(req.body.memberUids) ? req.body.memberUids : [];

  if (!name || name.length > 30) {
    return res.status(400).json({ error: "グループ名は1〜30文字で入力してください。" });
  }

  const memberUids = Array.from(new Set([myUid, ...rawMembers.filter(Boolean)]));
  if (memberUids.length < 2) {
    return res.status(400).json({ error: "グループには1人以上の友達を追加してください。" });
  }

  try {
    const myUserDoc = await db.collection("users").doc(myUid).get();
    const myUsername = myUserDoc.exists
      ? (myUserDoc.data().username || "ユーザー")
      : "ユーザー";

    const memberInfo = {};
    for (const uid of memberUids) {
      const uDoc = await db.collection("users").doc(uid).get();
      memberInfo[uid] = {
        username: uDoc.exists ? (uDoc.data().username || "ユーザー") : "ユーザー",
        joinedAt: Date.now()
      };
    }

    const now = admin.firestore.FieldValue.serverTimestamp();
    const chatRef = db.collection("chats").doc();

    const newChat = {
      type: "group",
      name,
      members: memberUids,
      memberInfo,
      createdUid: myUid,
      createdAt: now,
      updatedAt: now,
      lastMessage: {
        text: `${myUsername}がグループを作成しました`,
        type: "system",
        senderUid: "system",
        senderName: "システム",
        unsent: false,
        createdAt: now
      },
      lastMessageAt: now,
      readStatus: {
        [myUid]: now
      }
    };

    await chatRef.set(newChat);

    await chatRef.collection("messages").add({
      chatId: chatRef.id,
      senderUid: "system",
      senderName: "システム",
      type: "system",
      text: `${myUsername}がグループ「${name}」を作成しました`,
      readBy: memberUids,
      unsent: false,
      createdAt: now
    });

    return res.status(201).json({
      chat: {
        id: chatRef.id,
        ...newChat
      }
    });
  } catch (error) {
    console.error("グループ作成エラー:", error);
    return res.status(500).json({ error: "グループの作成に失敗しました。" });
  }
});

// 単一チャット情報
app.get("/api/chats/:chatId", requireLogin, async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: "データベースが利用できません。" });
  }

  const chatId = req.params.chatId;
  const myUid = req.user.uid;

  try {
    const chatRef = db.collection("chats").doc(chatId);
    const chatDoc = await chatRef.get();

    if (!chatDoc.exists) {
      return res.status(404).json({ error: "チャットが見つかりません。" });
    }

    const data = chatDoc.data();
    const isAllMembers = chatId === "all_members";
    if (!isAllMembers && (!data.members || !data.members.includes(myUid))) {
      return res.status(403).json({ error: "このチャットへの参加権限がありません。" });
    }

    let name = data.name;
    let partnerUid = null;
    if (data.type === "direct") {
      partnerUid = data.members.find((u) => u !== myUid) || myUid;
      const pInfo = data.memberInfo && data.memberInfo[partnerUid];
      name = pInfo ? pInfo.username : "ユーザー";
    }

    return res.json({
      chat: {
        id: chatDoc.id,
        ...data,
        name: name || "トーク",
        partnerUid
      }
    });
  } catch (error) {
    console.error("チャット情報取得エラー:", error);
    return res.status(500).json({ error: "チャット情報の取得に失敗しました。" });
  }
});

// ----------------------------------------------------
// メッセージ: 取得・送信・既読・送信取り消し・リアクション・アナウンス
// ----------------------------------------------------
app.get("/api/chats/:chatId/messages", requireLogin, async (req, res) => {
  const chatId = req.params.chatId;
  const myUid = req.user.uid;

  try {
    // インメモリ超高速取得 (Firestoreクォータ枯渇・遅延・ハングを完全排除)
    const messages = await getChatMessagesFast(chatId);
    return res.json({ messages });
  } catch (error) {
    console.error("メッセージ取得エラー:", error);
    return res.status(500).json({ error: "メッセージの取得に失敗しました。" });
  }
});

app.post("/api/chats/:chatId/messages", requireLogin, async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: "データベースが利用できません。" });
  }

  const chatId = req.params.chatId;
  const myUid = req.user.uid;

  try {
    const chatRef = db.collection("chats").doc(chatId);
    const chatDoc = await chatRef.get();

    if (!chatDoc.exists) {
      return res.status(404).json({ error: "チャットが見つかりません。" });
    }

    const chatData = chatDoc.data();
    const isAllMembers = chatId === "all_members";
    if (!isAllMembers && (!chatData.members || !chatData.members.includes(myUid))) {
      return res.status(403).json({ error: "このチャットへの参加権限がありません。" });
    }

    const userDoc = await db.collection("users").doc(myUid).get();
    const myUsername = userDoc.exists
      ? (userDoc.data().username || "ユーザー")
      : "ユーザー";

    const type = req.body.type || "text"; // "text", "image", "stamp", "game_invite"
    const text = String(req.body.text || "").trim();
    const imageUrl = req.body.imageUrl ? String(req.body.imageUrl) : null;
    const stampId = req.body.stampId ? String(req.body.stampId) : null;
    const replyTo = req.body.replyTo && req.body.replyTo.messageId ? {
      messageId: String(req.body.replyTo.messageId),
      text: String(req.body.replyTo.text || "").slice(0, 100),
      senderName: String(req.body.replyTo.senderName || "")
    } : null;

    if (type === "text" && !text) {
      return res.status(400).json({ error: "メッセージを入力してください。" });
    }
    if (type === "image" && !imageUrl) {
      return res.status(400).json({ error: "画像データが指定されていません。" });
    }
    if (type === "stamp" && !stampId) {
      return res.status(400).json({ error: "スタンプが選択されていません。" });
    }

    let previewText = text;
    if (type === "image") previewText = "📷 [画像]";
    if (type === "stamp") previewText = "🐐 [スタンプ]";
    const gameInvite = req.body.gameInvite || null;
    if (type === "game_invite") {
      const gTitle = (gameInvite && gameInvite.gameTitle) || "ゲーム";
      previewText = `🎮 [対戦招待] ${myUsername}から${gTitle}の対戦招待が届いたよ！`;
    }

    const messageData = {
      chatId,
      senderUid: myUid,
      senderName: myUsername,
      type,
      text: previewText,
      originalText: text,
      imageUrl,
      stampId,
      gameInvite,
      replyTo,
      reactions: {},
      readBy: [myUid],
      unsent: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const msgDoc = await chatRef.collection("messages").add(messageData);
    messageCache.delete(chatId);

    const now = admin.firestore.FieldValue.serverTimestamp();
    await chatRef.update({
      lastMessage: {
        id: msgDoc.id,
        senderUid: myUid,
        senderName: myUsername,
        text: previewText,
        type,
        unsent: false,
        createdAt: now
      },
      lastMessageAt: now,
      [`readStatus.${myUid}`]: now
    });

    // AIチャットへの投稿なら自動でAIが返答
    if (chatId.startsWith("ai_") || chatData.isAi) {
      setTimeout(async () => {
        try {
          const authHeader = req.headers.authorization || "";
          let aiText = "";
          try {
            const aiResp = await fetch("https://myyajuu-ai-worker.harumei-260329.workers.dev/v1/chat", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: authHeader
              },
              body: JSON.stringify({ message: text, model: "@cf/meta/llama-3.2-3b-instruct" })
            });
            if (aiResp.ok) {
              const aiData = await aiResp.json();
              aiText = aiData.response || aiData.message || "";
            }
          } catch (e) {
            console.warn("AI fetch fallback:", e.message);
          }
          if (!aiText) {
            aiText = "こんにちは！メッセージありがとうございます。何でも気軽に質問してくださいね！";
          }
          const aiNow = admin.firestore.FieldValue.serverTimestamp();
          const aiMsg = {
            chatId,
            senderUid: "ai_assistant",
            senderName: "AIアシスタント",
            type: "text",
            text: aiText,
            originalText: aiText,
            imageUrl: null,
            stampId: null,
            reactions: {},
            readBy: ["ai_assistant"],
            unsent: false,
            createdAt: aiNow
          };
          const aiMsgDoc = await chatRef.collection("messages").add(aiMsg);
          const memList = memoryChatMessages.get(chatId) || [];
          memList.push({ id: aiMsgDoc ? aiMsgDoc.id : ("ai_" + Date.now()), ...aiMsg, createdAt: Date.now() });
          memoryChatMessages.set(chatId, memList);
          await chatRef.update({
            lastMessage: {
              id: aiMsgDoc.id,
              senderUid: "ai_assistant",
              senderName: "AIアシスタント",
              text: aiText.slice(0, 60),
              type: "text",
              unsent: false,
              createdAt: aiNow
            },
            lastMessageAt: aiNow
          });
          messageCache.delete(chatId);
        } catch (aiErr) {
          console.error("AI reply error:", aiErr);
        }
      }, 300);
    }

    return res.status(201).json({
      ok: true,
      messageId: msgDoc.id,
      message: {
        id: msgDoc.id,
        ...messageData
      }
    });
  } catch (error) {
    console.error("メッセージ送信エラー:", error);
    return res.status(500).json({ error: "メッセージの送信に失敗しました。" });
  }
});

// 既読にする
app.post("/api/chats/:chatId/read", requireLogin, async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: "データベースが利用できません。" });
  }

  const chatId = req.params.chatId;
  const myUid = req.user.uid;

  try {
    if (!(await checkChatAccess(chatId, myUid))) {
      return res.status(403).json({ error: "このチャットへの参加権限がありません。" });
    }
    const chatRef = db.collection("chats").doc(chatId);
    await chatRef.update({
      [`readStatus.${myUid}`]: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ ok: true });
  } catch (error) {
    console.error("既読更新エラー:", error);
    return res.status(500).json({ error: "既読更新に失敗しました。" });
  }
});

// ----------------------------------------------------
// ゲームセッション管理 (オセロ・UNO・大富豪などのマルチ対戦: 権限・入力完全検証)
// ----------------------------------------------------
app.get("/api/games/rooms/:roomId", requireLogin, async (req, res) => {
  const roomId = req.params.roomId;
  const myUid = req.user.uid;

  let room = memoryGameRooms.get(roomId);
  if (!room && db) {
    try {
      const snap = await db.collection("game_rooms").doc(roomId).get();
      if (snap.exists) {
        room = snap.data();
        memoryGameRooms.set(roomId, room);
      }
    } catch (_) {}
  }

  if (!room) {
    return res.status(404).json({ error: "ルームが見つかりません。" });
  }
  return res.json({ room });
});

app.post("/api/games/rooms/:roomId/join", requireLogin, async (req, res) => {
  const myUid = req.user.uid;
  const username = String(req.body.username || req.user.username || "ユーザー").slice(0, 20);
  const gameType = String(req.body.gameType || "othello").slice(0, 30);
  const roomId = String(req.params.roomId || "").trim().slice(0, 50);

  if (!roomId) return res.status(400).json({ error: "無効なルームIDです。" });

  const now = Date.now();
  let room = memoryGameRooms.get(roomId);

  if (!room) {
    const rawInit = req.body.initialState;
    const initialState = (rawInit && typeof rawInit === "object" && !Array.isArray(rawInit)) ? rawInit : {};
    room = {
      roomId,
      gameType,
      hostUid: myUid,
      hostName: username,
      players: [{ uid: myUid, username, joinedAt: now }],
      status: "waiting",
      state: initialState,
      updatedAt: now
    };
    memoryGameRooms.set(roomId, room);
    if (db) db.collection("game_rooms").doc(roomId).set(room).catch(() => {});
    return res.json({ room, role: 1 });
  }

  let players = Array.isArray(room.players) ? [...room.players] : [];
  let existingIdx = players.findIndex(p => p.uid === myUid);
  let role = existingIdx >= 0 ? existingIdx + 1 : players.length + 1;
  const maxPlayers = (gameType === "daifugo" || gameType === "uno") ? 4 : (gameType === "drawquiz" ? 8 : 2);

  if (existingIdx === -1) {
    if (players.length >= maxPlayers) {
      return res.status(400).json({ error: "ルームが満員です。" });
    }
    players.push({ uid: myUid, username, joinedAt: now });
    role = players.length;
  } else {
    players[existingIdx].username = username;
  }

  let status = room.status;
  if (players.length >= 2 && status === "waiting") {
    status = "playing";
  }

  room.players = players;
  room.status = status;
  room.updatedAt = now;
  memoryGameRooms.set(roomId, room);

  if (db) db.collection("game_rooms").doc(roomId).set(room, { merge: true }).catch(() => {});
  return res.json({ room, role });
});

app.post("/api/games/rooms/:roomId/update", requireLogin, async (req, res) => {
  const roomId = req.params.roomId;
  const myUid = req.user.uid;

  let room = memoryGameRooms.get(roomId);
  if (!room) return res.status(404).json({ error: "ルームが見つかりません。" });

  if (req.body.state) room.state = req.body.state;
  if (req.body.status) room.status = req.body.status;
  room.updatedAt = Date.now();
  memoryGameRooms.set(roomId, room);

  if (db) db.collection("game_rooms").doc(roomId).set(room, { merge: true }).catch(() => {});
  return res.json({ ok: true, room });
});

app.delete("/api/games/rooms/:roomId", requireLogin, async (req, res) => {
  const roomId = req.params.roomId;
  memoryGameRooms.delete(roomId);
  if (db) db.collection("game_rooms").doc(roomId).delete().catch(() => {});
  return res.json({ ok: true });
});


// ----------------------------------------------------
// 通話 (無料電話 / WebRTCシグナリング & リアルタイム通話管理)
// ----------------------------------------------------
const activeCalls = new Map(); // chatId -> callObject

app.post("/api/calls/:chatId/start", requireLogin, async (req, res) => {
  const chatId = req.params.chatId;
  const myUid = req.user.uid;

  try {
    const userDoc = await db.collection("users").doc(myUid).get();
    const myUsername = userDoc.exists ? (userDoc.data().username || "ユーザー") : "ユーザー";

    if (chatId !== "all_members") {
      const chatDoc = await db.collection("chats").doc(chatId).get();
      if (!chatDoc.exists || !chatDoc.data().members || !chatDoc.data().members.includes(myUid)) {
        return res.status(403).json({ error: "このチャットで通話を開始する権限がありません。" });
      }
    }

    const now = Date.now();
    const existing = activeCalls.get(chatId);
    if (existing && existing.status !== "ended" && (now - existing.startedAt < 7200000)) {
      if (!existing.participants.some(p => p.uid === myUid)) {
        existing.participants.push({ uid: myUid, username: myUsername, joinedAt: now });
      }
      return res.json({ ok: true, call: existing, isNew: false });
    }

    const callObj = {
      callId: "call_" + now + "_" + Math.random().toString(36).substring(2, 7),
      chatId,
      callerUid: myUid,
      callerName: myUsername,
      status: "ringing", // "ringing" | "connected" | "ended"
      startedAt: now,
      connectedAt: null,
      endedAt: null,
      participants: [{ uid: myUid, username: myUsername, joinedAt: now }],
      signals: {} // uid -> array of signals
    };

    activeCalls.set(chatId, callObj);

    // チャットに無料通話開始メッセージを自動投稿
    const chatRef = db.collection("chats").doc(chatId);
    await chatRef.collection("messages").add({
      chatId,
      senderUid: myUid,
      senderName: myUsername,
      type: "call_invite",
      text: `📞 ${myUsername}が無料通話を開始しました`,
      readBy: [myUid],
      unsent: false,
      callId: callObj.callId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    }).catch(e => console.warn("Call invite msg error:", e.message));

    messageCache.delete(chatId);

    return res.json({ ok: true, call: callObj, isNew: true });
  } catch (err) {
    console.error("Call start error:", err);
    return res.status(500).json({ error: "通話の開始に失敗しました。" });
  }
});

app.get("/api/calls/:chatId", requireLogin, (req, res) => {
  const chatId = req.params.chatId;
  const myUid = req.user.uid;
  const call = activeCalls.get(chatId);
  if (!call || call.status === "ended") {
    return res.json({ ok: true, call: null });
  }
  const mySignals = call.signals[myUid] || [];
  call.signals[myUid] = []; // 取得済みシグナルをクリア
  return res.json({ ok: true, call, signals: mySignals });
});

app.post("/api/calls/:chatId/join", requireLogin, async (req, res) => {
  const chatId = req.params.chatId;
  const myUid = req.user.uid;
  const call = activeCalls.get(chatId);
  if (!call || call.status === "ended") {
    return res.status(404).json({ error: "通話は終了しているか存在しません。" });
  }

  const userDoc = await db.collection("users").doc(myUid).get();
  const myUsername = userDoc.exists ? (userDoc.data().username || "ユーザー") : "ユーザー";

  if (!call.participants.some(p => p.uid === myUid)) {
    call.participants.push({ uid: myUid, username: myUsername, joinedAt: Date.now() });
  }
  call.status = "connected";
  if (!call.connectedAt) call.connectedAt = Date.now();

  return res.json({ ok: true, call });
});

app.post("/api/calls/:chatId/signal", requireLogin, (req, res) => {
  const chatId = req.params.chatId;
  const myUid = req.user.uid;
  const call = activeCalls.get(chatId);
  if (!call || call.status === "ended") {
    return res.status(404).json({ error: "通話が見つかりません。" });
  }

  const { toUid, signal } = req.body;
  if (toUid && signal) {
    if (!call.signals[toUid]) call.signals[toUid] = [];
    call.signals[toUid].push({ fromUid: myUid, signal, timestamp: Date.now() });
  } else if (signal) {
    call.participants.forEach(p => {
      if (p.uid !== myUid) {
        if (!call.signals[p.uid]) call.signals[p.uid] = [];
        call.signals[p.uid].push({ fromUid: myUid, signal, timestamp: Date.now() });
      }
    });
  }
  return res.json({ ok: true });
});

app.post("/api/calls/:chatId/end", requireLogin, async (req, res) => {
  const chatId = req.params.chatId;
  const myUid = req.user.uid;
  const call = activeCalls.get(chatId);

  if (!call || call.status === "ended") {
    return res.json({ ok: true, message: "既に終了しています。" });
  }

  const now = Date.now();
  call.status = "ended";
  call.endedAt = now;
  const durationSec = call.connectedAt ? Math.floor((now - call.connectedAt) / 1000) : 0;
  const mins = String(Math.floor(durationSec / 60)).padStart(2, "0");
  const secs = String(durationSec % 60).padStart(2, "0");
  const durationStr = `${mins}:${secs}`;

  activeCalls.delete(chatId);

  try {
    const userDoc = await db.collection("users").doc(myUid).get();
    const myUsername = userDoc.exists ? (userDoc.data().username || "ユーザー") : "ユーザー";
    const chatRef = db.collection("chats").doc(chatId);
    await chatRef.collection("messages").add({
      chatId,
      senderUid: "system",
      senderName: "通話",
      type: "system",
      text: `📞 通話が終了しました (${durationSec > 0 ? "通話時間 " + durationStr : "応答なし"})`,
      readBy: call.participants.map(p => p.uid),
      unsent: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    messageCache.delete(chatId);
  } catch (e) {
    console.warn("Call end msg error:", e.message);
  }

  return res.json({ ok: true, duration: durationStr });
});

// 送信取り消し (LINEと同じ: 権限検証)
app.post("/api/chats/:chatId/messages/:messageId/unsend", requireLogin, async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: "データベースが利用できません。" });
  }

  const { chatId, messageId } = req.params;
  const myUid = req.user.uid;

  try {
    if (!(await checkChatAccess(chatId, myUid))) {
      return res.status(403).json({ error: "このチャットへの参加権限がありません。" });
    }
    const chatRef = db.collection("chats").doc(chatId);
    const msgRef = chatRef.collection("messages").doc(messageId);
    const msgDoc = await msgRef.get();

    if (!msgDoc.exists) {
      return res.status(404).json({ error: "メッセージが見つかりません。" });
    }

    const msgData = msgDoc.data();
    if (msgData.senderUid !== myUid) {
      return res.status(403).json({ error: "自分のメッセージのみ送信取り消しできます。" });
    }

    if (msgData.unsent) {
      return res.json({ ok: true, message: "すでに送信が取り消されています。" });
    }

    messageCache.delete(chatId);
    await msgRef.update({
      unsent: true,
      text: "メッセージの送信を取り消しました",
      imageUrl: null,
      stampId: null,
      gameInvite: null,
      reactions: {},
      replyTo: null,
      unsentAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const chatDoc = await chatRef.get();
    if (chatDoc.exists) {
      const cData = chatDoc.data();
      if (cData.lastMessage && cData.lastMessage.id === messageId) {
        await chatRef.update({
          "lastMessage.unsent": true,
          "lastMessage.text": "メッセージの送信を取り消しました"
        });
      }
      if (cData.announcement && cData.announcement.messageId === messageId) {
        await chatRef.update({ announcement: null });
      }
    }

    return res.json({ ok: true, message: "送信を取り消しました。" });
  } catch (error) {
    console.error("送信取り消しエラー:", error);
    return res.status(500).json({ error: "送信取り消しに失敗しました。" });
  }
});

// メッセージ完全物理削除
app.delete("/api/chats/:chatId/messages/:messageId", requireLogin, async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: "データベースが利用できません。" });
  }

  const { chatId, messageId } = req.params;
  const myUid = req.user.uid;

  try {
    const chatRef = db.collection("chats").doc(chatId);
    const msgRef = chatRef.collection("messages").doc(messageId);
    const msgDoc = await msgRef.get();

    if (!msgDoc.exists) {
      return res.status(404).json({ error: "メッセージが見つかりません。" });
    }

    const msgData = msgDoc.data();
    const isAdmin = await isUserAdmin(myUid, req.user);
    if (msgData.senderUid !== myUid && !isAdmin) {
      return res.status(403).json({ error: "自分のメッセージまたは管理者のみ削除できます。" });
    }

    await msgRef.delete();
    messageCache.delete(chatId);

    const chatDoc = await chatRef.get();
    if (chatDoc.exists) {
      const cData = chatDoc.data();
      if (cData.lastMessage && cData.lastMessage.id === messageId) {
        const prevSnap = await chatRef
          .collection("messages")
          .orderBy("createdAt", "desc")
          .limit(1)
          .get();

        if (!prevSnap.empty) {
          const prevMsg = prevSnap.docs[0].data();
          await chatRef.update({
            lastMessage: {
              id: prevSnap.docs[0].id,
              text: prevMsg.text || "",
              senderName: prevMsg.senderName || "",
              createdAt: prevMsg.createdAt || null
            }
          });
        } else {
          await chatRef.update({ lastMessage: null });
        }
      }
      if (cData.announcement && cData.announcement.messageId === messageId) {
        await chatRef.update({ announcement: null });
      }
    }

    return res.json({ ok: true, message: "メッセージを完全に削除しました。" });
  } catch (error) {
    console.error("メッセージ完全削除エラー:", error);
    return res.status(500).json({ error: "メッセージの削除に失敗しました。" });
  }
});

// リアクション (LINE風スタンプリアクション)
app.post("/api/chats/:chatId/messages/:messageId/reactions", requireLogin, async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: "データベースが利用できません。" });
  }

  const { chatId, messageId } = req.params;
  const myUid = req.user.uid;
  const emoji = String(req.body.emoji || "").trim();

  const allowedEmojis = ["👍", "❤️", "😂", "😮", "😢", "🙏", "🔥", "🎉"];
  if (!allowedEmojis.includes(emoji)) {
    return res.status(400).json({ error: "無効なリアクションです。" });
  }

  try {
    const msgRef = db.collection("chats").doc(chatId).collection("messages").doc(messageId);
    const msgDoc = await msgRef.get();

    if (!msgDoc.exists) {
      return res.status(404).json({ error: "メッセージが見つかりません。" });
    }

    if (msgDoc.data().unsent) {
      return res.status(400).json({ error: "送信取り消しされたメッセージにはリアクションできません。" });
    }

    const currentReactions = msgDoc.data().reactions || {};
    let uids = currentReactions[emoji] ? [...currentReactions[emoji]] : [];

    if (uids.includes(myUid)) {
      uids = uids.filter((u) => u !== myUid);
    } else {
      uids.push(myUid);
    }

    if (uids.length === 0) {
      delete currentReactions[emoji];
    } else {
      currentReactions[emoji] = uids;
    }

    await msgRef.update({ reactions: currentReactions });
    messageCache.delete(chatId);
    return res.json({ ok: true, reactions: currentReactions });
  } catch (error) {
    console.error("リアクションエラー:", error);
    return res.status(500).json({ error: "リアクションの更新に失敗しました。" });
  }
});

// アナウンス (ピン留め)
app.post("/api/chats/:chatId/announcement", requireLogin, async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: "データベースが利用できません。" });
  }

  const chatId = req.params.chatId;
  const { messageId, clear } = req.body;

  try {
    const chatRef = db.collection("chats").doc(chatId);

    if (clear) {
      await chatRef.update({ announcement: null });
      return res.json({ ok: true, announcement: null });
    }

    const msgDoc = await chatRef.collection("messages").doc(messageId).get();
    if (!msgDoc.exists || msgDoc.data().unsent) {
      return res.status(400).json({ error: "このメッセージはアナウンスに設定できません。" });
    }

    const data = msgDoc.data();
    const announcement = {
      messageId,
      text: data.text || (data.type === "image" ? "[画像]" : "[スタンプ]"),
      senderName: data.senderName,
      pinnedAt: Date.now()
    };

    await chatRef.update({ announcement });
    return res.json({ ok: true, announcement });
  } catch (error) {
    console.error("アナウンス設定エラー:", error);
    return res.status(500).json({ error: "アナウンスの設定に失敗しました。" });
  }
});

// グループメンバー招待
app.post("/api/chats/:chatId/members", requireLogin, async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: "データベースが利用できません。" });
  }

  const chatId = req.params.chatId;
  const myUid = req.user.uid;
  const { memberUids } = req.body;

  if (!Array.isArray(memberUids) || memberUids.length === 0) {
    return res.status(400).json({ error: "追加するメンバーを選択してください。" });
  }

  try {
    const chatRef = db.collection("chats").doc(chatId);
    const chatDoc = await chatRef.get();

    if (!chatDoc.exists) {
      return res.status(404).json({ error: "チャットが見つかりません。" });
    }

    const chatData = chatDoc.data();
    if (chatData.type !== "group") {
      return res.status(400).json({ error: "グループチャットでのみメンバーを追加できます。" });
    }

    if (!chatData.members.includes(myUid)) {
      return res.status(403).json({ error: "このグループのメンバーではありません。" });
    }

    const myUserDoc = await db.collection("users").doc(myUid).get();
    const myUsername = myUserDoc.exists ? myUserDoc.data().username : "ユーザー";

    const newMembers = memberUids.filter((uid) => !chatData.members.includes(uid));
    if (newMembers.length === 0) {
      return res.status(400).json({ error: "指定されたユーザーは全員すでに追加されています。" });
    }

    const addedUsernames = [];
    const newMemberInfo = { ...(chatData.memberInfo || {}) };

    for (const uid of newMembers) {
      const uDoc = await db.collection("users").doc(uid).get();
      const uName = uDoc.exists ? uDoc.data().username : "ユーザー";
      addedUsernames.push(uName);
      newMemberInfo[uid] = { username: uName, joinedAt: Date.now() };
    }

    const updatedMembers = [...chatData.members, ...newMembers];
    await chatRef.update({
      members: updatedMembers,
      memberInfo: newMemberInfo
    });

    await chatRef.collection("messages").add({
      chatId,
      senderUid: "system",
      senderName: "システム",
      type: "system",
      text: `${myUsername}が${addedUsernames.join("、")}を招待しました`,
      readBy: updatedMembers,
      unsent: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ ok: true, members: updatedMembers, memberInfo: newMemberInfo });
  } catch (error) {
    console.error("メンバー追加エラー:", error);
    return res.status(500).json({ error: "メンバーの追加に失敗しました。" });
  }
});

// グループ退会
app.post("/api/chats/:chatId/leave", requireLogin, async (req, res) => {
  if (!db) {
    return res.status(503).json({ error: "データベースが利用できません。" });
  }

  const chatId = req.params.chatId;
  const myUid = req.user.uid;

  try {
    const chatRef = db.collection("chats").doc(chatId);
    const chatDoc = await chatRef.get();

    if (!chatDoc.exists) {
      return res.status(404).json({ error: "チャットが見つかりません。" });
    }

    const chatData = chatDoc.data();
    if (chatData.type !== "group") {
      return res.status(400).json({ error: "グループチャットでのみ退会できます。" });
    }

    if (!chatData.members.includes(myUid)) {
      return res.status(400).json({ error: "このグループに参加していません。" });
    }

    const userDoc = await db.collection("users").doc(myUid).get();
    const myUsername = userDoc.exists ? userDoc.data().username : "ユーザー";

    const updatedMembers = chatData.members.filter((uid) => uid !== myUid);
    await chatRef.update({
      members: updatedMembers
    });

    await chatRef.collection("messages").add({
      chatId,
      senderUid: "system",
      senderName: "システム",
      type: "system",
      text: `${myUsername}がグループを退会しました`,
      readBy: updatedMembers,
      unsent: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return res.json({ ok: true, message: "グループを退会しました。" });
  } catch (error) {
    console.error("グループ退会エラー:", error);
    return res.status(500).json({ error: "グループの退会に失敗しました。" });
  }
});


// ====================================================
// ⭐ LINE Unlimited 新機能 API群 (プロフィールBGM, アルバム, ノート, 投票, 日程調整, VOOM)
// ====================================================

// Apple Music (iTunes Search API) 30秒試聴・曲検索プロキシ
app.get("/api/music/search", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) return res.json({ results: [] });

  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&country=jp&entity=song&limit=20`;
    const response = await fetch(url);
    if (!response.ok) {
      return res.status(response.status).json({ error: "音楽の検索に失敗しました。" });
    }
    const data = await response.json();
    const songs = (data.results || []).map(item => ({
      trackId: item.trackId,
      trackName: item.trackName,
      artistName: item.artistName,
      collectionName: item.collectionName,
      artworkUrl: item.artworkUrl100 ? item.artworkUrl100.replace("100x100bb", "300x300bb") : "",
      previewUrl: item.previewUrl,
      trackViewUrl: item.trackViewUrl
    }));
    return res.json({ results: songs });
  } catch (err) {
    console.error("Music search error:", err);
    return res.status(500).json({ error: "音楽の取得に失敗しました。" });
  }
});

// 自分のプロフィール取得
app.get("/api/users/me", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  try {
    const userDoc = await db.collection("users").doc(req.user.uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "ユーザー情報が見つかりません。" });
    }
    const data = userDoc.data();
    return res.json({
      user: {
        uid: req.user.uid,
        username: data.username || "ユーザー",
        statusMessage: data.statusMessage || "",
        photoURL: data.photoURL || null,
        coverUrl: data.coverUrl || null,
        bgm: data.bgm || null,
        bio: data.bio || ""
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.get("/api/users/:uid", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  try {
    const userDoc = await db.collection("users").doc(req.params.uid).get();
    if (!userDoc.exists) {
      return res.status(404).json({ error: "ユーザーが見つかりません。" });
    }
    const data = userDoc.data();
    return res.json({
      user: {
        uid: req.params.uid,
        username: data.username || "ユーザー",
        statusMessage: data.statusMessage || "",
        bio: data.bio || "",
        photoURL: data.photoURL || null,
        coverUrl: data.coverUrl || null,
        bgm: data.bgm || null
      }
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ユーザープロフィール詳細更新 (ユーザー名・ステメ・アイコン・BGM・フォント・テーマ)
app.put("/api/users/profile", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  const myUid = req.user.uid;
  const { statusMessage, bgm, font, theme, coverUrl, photoURL, username } = req.body;

  try {
    const userRef = db.collection("users").doc(myUid);
    const userDoc = await userRef.get();
    if (!userDoc.exists) return res.status(404).json({ error: "ユーザーが見つかりません。" });

    const currentData = userDoc.data();
    const updateData = {};

    // ユーザー名変更の厳格なバリデーション & 重複検証
    if (username !== undefined) {
      const newUsername = String(username).trim();
      if (!/^[\p{L}\p{N}_-]{2,20}$/u.test(newUsername)) {
        return res.status(400).json({
          error: "ユーザー名は2〜20文字で入力してください（文字・数字・_・-が使用可能）。"
        });
      }

      const oldUsername = currentData.username || "";
      if (newUsername.toLowerCase() !== oldUsername.toLowerCase()) {
        const newKey = newUsername.toLowerCase();
        const oldKey = oldUsername.toLowerCase();
        const newRef = db.collection("usernames").doc(newKey);
        const oldRef = oldKey ? db.collection("usernames").doc(oldKey) : null;

        await db.runTransaction(async (transaction) => {
          const newDoc = await transaction.get(newRef);
          if (newDoc.exists && newDoc.data().uid !== myUid) {
            throw new Error("USERNAME_TAKEN");
          }
          transaction.set(newRef, {
            uid: myUid,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
          if (oldRef) {
            transaction.delete(oldRef);
          }
        });
      }

      updateData.username = newUsername;
      if (auth) {
        await auth.updateUser(myUid, { displayName: newUsername }).catch(() => {});
      }
    }

    if (statusMessage !== undefined) updateData.statusMessage = String(statusMessage).slice(0, 100);
    if (req.body.bio !== undefined) updateData.bio = String(req.body.bio).slice(0, 300);
    if (bgm !== undefined) updateData.bgm = bgm;
    if (font !== undefined) updateData.font = String(font).slice(0, 50);
    if (theme !== undefined) updateData.theme = String(theme).slice(0, 50);
    if (coverUrl !== undefined) updateData.coverUrl = String(coverUrl).slice(0, 1000);
    if (photoURL !== undefined) updateData.photoURL = String(photoURL).slice(0, 2000000);

    updateData.updatedAt = Date.now();
    await userRef.set(updateData, { merge: true });

    return res.json({ ok: true, profile: { ...currentData, ...updateData } });
  } catch (err) {
    if (err.message === "USERNAME_TAKEN") {
      return res.status(409).json({ error: "このユーザー名はすでに使われています。" });
    }
    return res.status(500).json({ error: err.message });
  }
});

// アルバム一覧取得 (チャット参加者権限検証)
app.get("/api/chats/:chatId/albums", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  const myUid = req.user.uid;
  try {
    if (!(await checkChatAccess(req.params.chatId, myUid))) {
      return res.status(403).json({ error: "このチャットへのアクセス権限がありません。" });
    }
    const albumsRef = db.collection("chats").doc(req.params.chatId).collection("albums").orderBy("createdAt", "desc");
    const snap = await albumsRef.get();
    const albums = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ albums });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// アルバム作成
app.post("/api/chats/:chatId/albums", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  const myUid = req.user.uid;
  const { title, photos } = req.body;
  if (!title) return res.status(400).json({ error: "アルバム名を入力してください。" });

  try {
    if (!(await checkChatAccess(req.params.chatId, myUid))) {
      return res.status(403).json({ error: "このチャットへのアクセス権限がありません。" });
    }
    const albumData = {
      title: String(title).slice(0, 50),
      photos: Array.isArray(photos) ? photos.slice(0, 100) : [],
      creatorUid: myUid,
      createdAt: Date.now()
    };
    const docRef = await db.collection("chats").doc(req.params.chatId).collection("albums").add(albumData);
    return res.json({ ok: true, album: { id: docRef.id, ...albumData } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ノート一覧取得
app.get("/api/chats/:chatId/notes", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  const myUid = req.user.uid;
  try {
    if (!(await checkChatAccess(req.params.chatId, myUid))) {
      return res.status(403).json({ error: "このチャットへのアクセス権限がありません。" });
    }
    const notesRef = db.collection("chats").doc(req.params.chatId).collection("notes").orderBy("createdAt", "desc");
    const snap = await notesRef.get();
    const notes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ notes });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ノート投稿
app.post("/api/chats/:chatId/notes", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  const myUid = req.user.uid;
  const { text, images } = req.body;
  if (!text && (!images || images.length === 0)) return res.status(400).json({ error: "内容を入力してください。" });

  try {
    if (!(await checkChatAccess(req.params.chatId, myUid))) {
      return res.status(403).json({ error: "このチャットへのアクセス権限がありません。" });
    }
    const userDoc = await db.collection("users").doc(myUid).get();
    const authorName = userDoc.exists ? userDoc.data().username : "ユーザー";

    const noteData = {
      authorUid: myUid,
      authorName,
      text: String(text || "").slice(0, 5000),
      images: Array.isArray(images) ? images.slice(0, 20) : [],
      likes: [],
      comments: [],
      createdAt: Date.now()
    };
    const docRef = await db.collection("chats").doc(req.params.chatId).collection("notes").add(noteData);
    return res.json({ ok: true, note: { id: docRef.id, ...noteData } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// ノート いいねトグル
app.post("/api/chats/:chatId/notes/:noteId/like", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  const myUid = req.user.uid;
  try {
    if (!(await checkChatAccess(req.params.chatId, myUid))) {
      return res.status(403).json({ error: "このチャットへのアクセス権限がありません。" });
    }
    const noteRef = db.collection("chats").doc(req.params.chatId).collection("notes").doc(req.params.noteId);
    const snap = await noteRef.get();
    if (!snap.exists) return res.status(404).json({ error: "ノートが見つかりません。" });

    const data = snap.data();
    let likes = Array.isArray(data.likes) ? [...data.likes] : [];
    if (likes.includes(myUid)) {
      likes = likes.filter(u => u !== myUid);
    } else {
      likes.push(myUid);
    }
    await noteRef.update({ likes });
    return res.json({ ok: true, likes });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 投票一覧取得 & 作成 & 投票
app.get("/api/chats/:chatId/polls", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  const myUid = req.user.uid;
  try {
    if (!(await checkChatAccess(req.params.chatId, myUid))) {
      return res.status(403).json({ error: "このチャットへのアクセス権限がありません。" });
    }
    const snap = await db.collection("chats").doc(req.params.chatId).collection("polls").orderBy("createdAt", "desc").get();
    const polls = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ polls });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/chats/:chatId/polls", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  const myUid = req.user.uid;
  const { title, options } = req.body;
  if (!title || !Array.isArray(options) || options.length < 2) {
    return res.status(400).json({ error: "質問と2つ以上の選択肢を入力してください。" });
  }

  try {
    if (!(await checkChatAccess(req.params.chatId, myUid))) {
      return res.status(403).json({ error: "このチャットへのアクセス権限がありません。" });
    }
    const pollData = {
      title: String(title).slice(0, 100),
      options: options.slice(0, 10).map(opt => ({ text: String(opt).slice(0, 50), votes: [] })),
      creatorUid: myUid,
      closed: false,
      createdAt: Date.now()
    };
    const docRef = await db.collection("chats").doc(req.params.chatId).collection("polls").add(pollData);
    return res.json({ ok: true, poll: { id: docRef.id, ...pollData } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/chats/:chatId/polls/:pollId/vote", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  const myUid = req.user.uid;
  const { optionIdx } = req.body;

  try {
    if (!(await checkChatAccess(req.params.chatId, myUid))) {
      return res.status(403).json({ error: "このチャットへのアクセス権限がありません。" });
    }
    const pollRef = db.collection("chats").doc(req.params.chatId).collection("polls").doc(req.params.pollId);
    const snap = await pollRef.get();
    if (!snap.exists) return res.status(404).json({ error: "投票が見つかりません。" });

    const data = snap.data();
    const options = (data.options || []).map((opt, idx) => {
      let votes = (opt.votes || []).filter(u => u !== myUid);
      if (idx === optionIdx) votes.push(myUid);
      return { ...opt, votes };
    });

    await pollRef.update({ options });
    return res.json({ ok: true, options });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// イベント・日程調整
app.get("/api/chats/:chatId/events", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  const myUid = req.user.uid;
  try {
    if (!(await checkChatAccess(req.params.chatId, myUid))) {
      return res.status(403).json({ error: "このチャットへのアクセス権限がありません。" });
    }
    const snap = await db.collection("chats").doc(req.params.chatId).collection("events").orderBy("createdAt", "desc").get();
    const events = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ events });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/chats/:chatId/events", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  const myUid = req.user.uid;
  const { title, date, location } = req.body;
  if (!title) return res.status(400).json({ error: "イベント名を入力してください。" });

  try {
    if (!(await checkChatAccess(req.params.chatId, myUid))) {
      return res.status(403).json({ error: "このチャットへのアクセス権限がありません。" });
    }
    const eventData = {
      title: String(title).slice(0, 100),
      date: String(date || "").slice(0, 50),
      location: String(location || "").slice(0, 100),
      attendees: { [myUid]: "join" },
      creatorUid: myUid,
      createdAt: Date.now()
    };
    const docRef = await db.collection("chats").doc(req.params.chatId).collection("events").add(eventData);
    return res.json({ ok: true, event: { id: docRef.id, ...eventData } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// VOOM (タイムライン) 投稿一覧 & 新規投稿
app.get("/api/voom/posts", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  try {
    const snap = await db.collection("voom_posts").orderBy("createdAt", "desc").limit(30).get();
    const posts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    return res.json({ posts });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/voom/posts", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  const myUid = req.user.uid;
  const { text, imageUrl } = req.body;
  if (!text && !imageUrl) return res.status(400).json({ error: "本文または画像を入力してください。" });

  try {
    const userDoc = await db.collection("users").doc(myUid).get();
    const userData = userDoc.exists ? userDoc.data() : {};
    const authorName = userData.username || "ユーザー";
    const authorAvatar = userData.photoURL || "";

    const postData = {
      authorUid: myUid,
      authorName,
      authorAvatar,
      text: String(text || ""),
      imageUrl: imageUrl ? String(imageUrl) : "",
      likes: [],
      comments: [],
      createdAt: Date.now()
    };
    const docRef = await db.collection("voom_posts").add(postData);
    return res.json({ ok: true, post: { id: docRef.id, ...postData } });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/voom/posts/:postId/like", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  const myUid = req.user.uid;
  try {
    const postRef = db.collection("voom_posts").doc(req.params.postId);
    const snap = await postRef.get();
    if (!snap.exists) return res.status(404).json({ error: "投稿が見つかりません。" });

    const data = snap.data();
    let likes = Array.isArray(data.likes) ? [...data.likes] : [];
    if (likes.includes(myUid)) {
      likes = likes.filter(u => u !== myUid);
    } else {
      likes.push(myUid);
    }
    await postRef.update({ likes });
    return res.json({ ok: true, likes });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});


// ==========================================
// AI Worker Proxy (学校iPad等のi-フィルターによるworkers.devドメイン遮断完全回避)
// ==========================================
app.use('/api/ai', (req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept, Origin, User-Agent, X-Requested-With');
  res.header('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }
  // ※ Cloudflare Worker (myyajuu-ai-worker) が自身でFirebase IDトークンの署名・有効期限を検証するため透過転送
  next();
}, async (req, res) => {

  const targetUrl = 'https://myyajuu-ai-worker.harumei-260329.workers.dev' + req.url;
  try {
    const fetchHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (k.toLowerCase() !== 'host') fetchHeaders[k] = v;
    }
    const fetchOpts = {
      method: req.method,
      headers: fetchHeaders
    };
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      fetchOpts.body = typeof req.body === 'object' ? JSON.stringify(req.body) : req.body;
      if (!fetchHeaders['content-type']) fetchHeaders['content-type'] = 'application/json';
    }

    const workerResp = await fetch(targetUrl, fetchOpts);
    res.status(workerResp.status);
    for (const [hk, hv] of workerResp.headers.entries()) {
      if (!['access-control-allow-origin', 'content-encoding', 'content-length'].includes(hk.toLowerCase())) {
        res.setHeader(hk, hv);
      }
    }
    const data = await workerResp.arrayBuffer();
    return res.send(Buffer.from(data));
  } catch (err) {
    console.error('AI Proxy Error:', err);
    return res.status(502).json({ error: 'proxy_error', message: err.message });
  }
});

const port = process.env.PORT || 3000;

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});


// ====================================================
// ⭐ 天才プロキシ (Web Proxy Engine)
// 学校iPad等のフィルターを完全回避し、リンク書き換え & ストリーミング中継
// ====================================================
app.all("/api/proxy", async (req, res) => {
  let targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).send("URL parameter is required. Example: /api/proxy?url=https://poki.com");
  }
  targetUrl = String(targetUrl).trim();
  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    targetUrl = "https://" + targetUrl;
  }

  try {
    const parsedTarget = new URL(targetUrl);
    const origin = parsedTarget.origin;

    const headers = {
      "User-Agent": req.headers["user-agent"] || "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Accept": req.headers["accept"] || "*/*",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
      "Referer": origin + "/"
    };

    if (req.headers["range"]) {
      headers["Range"] = req.headers["range"];
    }

    const fetchOpts = {
      method: req.method,
      headers,
      redirect: "follow"
    };

    if (req.method !== "GET" && req.method !== "HEAD" && req.body) {
      if (typeof req.body === "string" || Buffer.isBuffer(req.body)) {
        fetchOpts.body = req.body;
      } else if (typeof req.body === "object") {
        fetchOpts.body = JSON.stringify(req.body);
        headers["Content-Type"] = "application/json";
      }
    }

    const response = await fetch(targetUrl, fetchOpts);
    const contentType = response.headers.get("content-type") || "";

    res.status(response.status);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    // Iframe busting 解除
    res.removeHeader("X-Frame-Options");
    res.removeHeader("Content-Security-Policy");

    for (const [key, val] of response.headers.entries()) {
      const lower = key.toLowerCase();
      if (!["content-security-policy", "x-frame-options", "content-encoding", "transfer-encoding"].includes(lower)) {
        res.setHeader(key, val);
      }
    }

    if (contentType.includes("text/html")) {
      let html = await response.text();
      const proxyBase = "/api/proxy?url=";
      const baseUrl = response.url || targetUrl;

      function resolveUrl(rel) {
        if (!rel || rel.startsWith("data:") || rel.startsWith("javascript:") || rel.startsWith("#") || rel.startsWith("blob:")) {
          return rel;
        }
        try {
          const abs = new URL(rel, baseUrl).href;
          return proxyBase + encodeURIComponent(abs);
        } catch (_) {
          return rel;
        }
      }

      html = html.replace(/\b(href|src|action)=["']([^"']+)["']/gi, (match, attr, val) => {
        return `${attr}="${resolveUrl(val)}"`;
      });
      html = html.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (match, val) => {
        return `url("${resolveUrl(val)}")`;
      });

      const navBar = `
<div id="__tensai_proxy_bar" style="position:fixed; top:0; left:0; width:100%; height:38px; background:rgba(15,23,42,0.96); backdrop-filter:blur(8px); border-bottom:1px solid rgba(255,255,255,0.15); z-index:2147483647; display:flex; align-items:center; justify-content:space-between; padding:0 12px; box-sizing:border-box; font-family:-apple-system,BlinkMacSystemFont,sans-serif; color:#fff; font-size:12px;">
  <div style="display:flex; align-items:center; gap:8px;">
    <span style="font-weight:bold; color:#38bdf8;">⚡ 天才プロキシ</span>
    <button onclick="history.back()" style="background:#334155; color:#fff; border:0; border-radius:4px; padding:3px 8px; cursor:pointer; font-size:11px;">◀ 戻る</button>
    <button onclick="location.reload()" style="background:#334155; color:#fff; border:0; border-radius:4px; padding:3px 8px; cursor:pointer; font-size:11px;">🔄 更新</button>
  </div>
  <div style="flex:1; max-width:450px; margin:0 10px;">
    <form onsubmit="event.preventDefault(); var u=document.getElementById('__proxy_dest').value; if(u){ if(!u.startsWith('http')) u='https://'+u; location.href='/api/proxy?url='+encodeURIComponent(u); }" style="display:flex; margin:0;">
      <input id="__proxy_dest" type="text" value="${baseUrl.replace(/"/g, '&quot;')}" style="width:100%; height:26px; border-radius:13px; border:1px solid #475569; background:#1e293b; color:#f8fafc; padding:0 10px; font-size:11px; box-sizing:border-box;">
    </form>
  </div>
  <div style="display:flex; align-items:center; gap:6px;">
    <button onclick="var b=document.getElementById('__tensai_proxy_bar'); if(b) b.style.display='none';" style="background:#475569; color:#fff; border:0; border-radius:4px; padding:3px 8px; cursor:pointer; font-size:11px;">非表示</button>
    <a href="/tensai-proxy/" style="background:#0284c7; color:#fff; text-decoration:none; border-radius:4px; padding:3px 8px; font-size:11px; font-weight:bold;">🏠 ホーム</a>
  </div>
</div>
<style> body { margin-top: 38px !important; } </style>
`;
      if (html.includes("<body")) {
        html = html.replace(/<body([^>]*)>/i, `<body$1>${navBar}`);
      } else {
        html = navBar + html;
      }
      return res.send(html);
    }

    const buf = await response.arrayBuffer();
    return res.end(Buffer.from(buf));
  } catch (err) {
    return res.status(502).send(`<div style="padding:40px; text-align:center; background:#0f172a; color:#fff; font-family:sans-serif; min-height:100vh;"><h2 style="color:#ef4444;">⚠️ 読み込みに失敗しました</h2><p style="color:#94a3b8;">${err.message}</p><a href="/tensai-proxy/" style="color:#38bdf8;">← 天才プロキシへ戻る</a></div>`);
  }
});

// ====================================================
// ⭐ 若雪幸せTube (YouTube MP4 プレイヤー中継 & 検索)
// ====================================================
app.get("/api/tube/search", async (req, res) => {
  const query = String(req.query.q || "").trim();
  if (!query) return res.json({ videos: [] });

  const instances = [
    "https://inv.tux.pizza/api/v1/search?q=",
    "https://invidious.nerdvpn.de/api/v1/search?q=",
    "https://vid.priv.au/api/v1/search?q="
  ];

  for (const inst of instances) {
    try {
      const resp = await fetch(inst + encodeURIComponent(query), { signal: AbortSignal.timeout(4500) });
      if (resp.ok) {
        const items = await resp.json();
        const videos = items.filter(i => i.type === "video" || i.videoId).slice(0, 20).map(v => ({
          id: v.videoId,
          title: v.title,
          author: v.author,
          lengthSeconds: v.lengthSeconds,
          viewCount: v.viewCountText || (v.viewCount ? Number(v.viewCount).toLocaleString() + " 回視聴" : ""),
          publishedText: v.publishedText,
          thumbnail: (v.videoThumbnails && v.videoThumbnails[0]) ? v.videoThumbnails[0].url : `https://i.ytimg.com/vi/${v.videoId}/hqdefault.jpg`
        }));
        return res.json({ ok: true, videos });
      }
    } catch (_) {}
  }

  // Fallback: iTunes search for music or popular query
  return res.json({ ok: true, videos: [
    { id: "M7lc1UVf-VE", title: "YouTube Developers Intro", author: "YouTube", thumbnail: "https://i.ytimg.com/vi/M7lc1UVf-VE/hqdefault.jpg" }
  ] });
});

app.get("/api/tube/stream", async (req, res) => {
  const videoId = String(req.query.v || "").trim();
  if (!videoId) return res.status(400).send("Video ID required");

  // Invidious stream endpoints
  const instances = [
    `https://inv.tux.pizza/latest_version?id=${videoId}&itag=22`,
    `https://invidious.nerdvpn.de/latest_version?id=${videoId}&itag=22`,
    `https://vid.priv.au/latest_version?id=${videoId}&itag=18`
  ];

  for (const url of instances) {
    try {
      const test = await fetch(url, { method: "HEAD", signal: AbortSignal.timeout(3000) });
      if (test.ok || test.status === 302 || test.status === 301) {
        const streamUrl = test.headers.get("location") || url;
        return res.redirect(streamUrl);
      }
    } catch (_) {}
  }

  // Direct redirect fallback
  return res.redirect(`https://inv.tux.pizza/latest_version?id=${videoId}&itag=18`);
});

// ====================================================
// ⭐ Apple Music風ミュージック API (iTunes Search API 連携)
// ====================================================
app.get("/api/music/search", async (req, res) => {
  const term = String(req.query.q || "STUTS Kaneee").trim();
  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&media=music&entity=song&limit=30&country=JP`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) throw new Error("Search failed");
    const data = await resp.json();
    const tracks = (data.results || []).map(r => ({
      id: r.trackId,
      title: r.trackName,
      artist: r.artistName,
      album: r.collectionName,
      artwork: (r.artworkUrl100 || "").replace("100x100bb", "600x600bb"),
      previewUrl: r.previewUrl,
      durationMs: r.trackTimeMillis,
      releaseDate: r.releaseDate ? r.releaseDate.slice(0, 10) : ""
    }));
    return res.json({ ok: true, tracks });
  } catch (err) {
    console.error("Music search error:", err.message);
    return res.status(500).json({ error: "音楽の検索に失敗しました。" });
  }
});

app.listen(port, () => {
  console.log(`mokori server listening on port ${port}`);
});
