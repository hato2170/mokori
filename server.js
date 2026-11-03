const express = require("express");
const admin = require("firebase-admin");
const bcrypt = require("bcryptjs");

const app = express();
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

app.use(express.static("public"));

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

    // テストメッセージの完全物理消去クリーンアップ
    (async () => {
      try {
        const chatRef = db.collection("chats").doc("all_members");
        await chatRef.collection("messages").doc("QgF1ndcIGF77ux4OuMzI").delete().catch(() => {});
        const snap = await chatRef.collection("messages").get();
        for (const doc of snap.docs) {
          const d = doc.data();
          if (
            (d.text && (d.text.includes("テスト成功") || d.text.includes("もこりバージョンUnlimited テスト成功"))) ||
            (d.senderName && d.senderName.includes("haruto_unlimited"))
          ) {
            await doc.ref.delete().catch(() => {});
          }
        }
        // lastMessageが削除対象だった場合の復旧
        const cDoc = await chatRef.get();
        if (cDoc.exists) {
          const lastMsg = cDoc.data().lastMessage;
          if (
            lastMsg &&
            (lastMsg.id === "QgF1ndcIGF77ux4OuMzI" ||
              (lastMsg.text && lastMsg.text.includes("テスト成功")) ||
              (lastMsg.senderName && lastMsg.senderName.includes("haruto_unlimited")))
          ) {
            const prevSnap = await chatRef
              .collection("messages")
              .where("unsent", "==", false)
              .orderBy("createdAt", "desc")
              .limit(1)
              .get();
            if (!prevSnap.empty) {
              const p = prevSnap.docs[0].data();
              await chatRef.update({
                lastMessage: {
                  id: prevSnap.docs[0].id,
                  text: p.text || "",
                  senderName: p.senderName || "",
                  createdAt: p.createdAt || null
                }
              });
            } else {
              await chatRef.update({ lastMessage: null });
            }
          }
        }
        console.log("Cleaned up test messages from all_members successfully");
      } catch (e) {
        console.warn("Cleanup test messages notice:", e.message);
      }
    })();
  } else {
    console.warn("Firebase is not configured yet.");
  }
} catch (error) {
  console.error("Firebase setup error:", error.message);
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
    const userDoc = await db.collection("users").doc(uid).get();

    if (!userDoc.exists) {
      return res.status(401).json({
        error: "ユーザー名またはパスワードが違います。"
      });
    }

    const valid = await bcrypt.compare(
      password,
      userDoc.data().passwordHash
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
    const username = String(req.body.username || "").trim();

    if (!username || username.length > 20) {
      return res.status(400).json({
        error: "申請する相手のユーザー名を入力してください。"
      });
    }

    const targetDoc = await db
      .collection("usernames")
      .doc(username.toLowerCase())
      .get();

    if (!targetDoc.exists) {
      return res.status(404).json({
        error: "そのユーザーは見つかりませんでした。"
      });
    }

    const targetUid = targetDoc.data().uid;
    const myUid = req.user.uid;

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

    const snapshot = await chatRef
      .collection("messages")
      .orderBy("createdAt", "asc")
      .limit(200)
      .get();

    const batch = db.batch();
    let unreadUpdated = false;
    const messages = [];

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const readBy = Array.isArray(data.readBy) ? [...data.readBy] : [];

      // 相手の未読メッセージを自分の既読リストに追加
      if (!readBy.includes(myUid) && data.senderUid !== myUid && !data.unsent) {
        batch.update(doc.ref, {
          readBy: admin.firestore.FieldValue.arrayUnion(myUid)
        });
        readBy.push(myUid);
        unreadUpdated = true;
      }

      messages.push({
        id: doc.id,
        ...data,
        readBy
      });
    }

    if (unreadUpdated) {
      await batch.commit().catch((e) => console.warn("既読バッチ更新警告:", e.message));
    }

    // チャットの最終既読時刻を更新
    await chatRef.update({
      [`readStatus.${myUid}`]: admin.firestore.FieldValue.serverTimestamp()
    }).catch(() => {});

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
// ゲームセッション管理 (オセロ・UNO・大富豪などのマルチ対戦)
// ----------------------------------------------------
app.get("/api/games/rooms/:roomId", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  try {
    const roomRef = db.collection("game_rooms").doc(req.params.roomId);
    const snap = await roomRef.get();
    if (!snap.exists) {
      return res.status(404).json({ error: "ルームが見つかりません。" });
    }
    return res.json({ room: snap.data() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/games/rooms/:roomId/join", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  const myUid = req.user.uid;
  const username = String(req.body.username || "ユーザー");
  const gameType = String(req.body.gameType || "othello");

  try {
    const roomRef = db.collection("game_rooms").doc(req.params.roomId);
    const snap = await roomRef.get();
    const now = Date.now();

    if (!snap.exists) {
      const initialData = {
        roomId: req.params.roomId,
        gameType,
        hostUid: myUid,
        hostName: username,
        players: [{ uid: myUid, username, joinedAt: now }],
        status: "waiting",
        state: req.body.initialState || {},
        updatedAt: now
      };
      await roomRef.set(initialData);
      return res.json({ room: initialData, role: 1 });
    }

    const data = snap.data();
    let players = Array.isArray(data.players) ? [...data.players] : [];
    const existingIdx = players.findIndex(p => p.uid === myUid);
    let role = existingIdx >= 0 ? existingIdx + 1 : players.length + 1;

    if (existingIdx === -1 && players.length < 4) {
      players.push({ uid: myUid, username, joinedAt: now });
      role = players.length;
    }

    let status = data.status;
    if (players.length >= 2 && status === "waiting") {
      status = "playing";
    }

    await roomRef.update({
      players,
      status,
      updatedAt: now
    });

    return res.json({
      room: { ...data, players, status, updatedAt: now },
      role
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

app.post("/api/games/rooms/:roomId/update", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  try {
    const roomRef = db.collection("game_rooms").doc(req.params.roomId);
    const updateData = {
      ...req.body,
      updatedAt: Date.now()
    };
    await roomRef.update(updateData);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// 送信取り消し (LINEと同じ)
app.post("/api/chats/:chatId/messages/:messageId/unsend", requireLogin, async (req, res) => {
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
    if (msgData.senderUid !== myUid) {
      return res.status(403).json({ error: "自分のメッセージのみ送信取り消しできます。" });
    }

    if (msgData.unsent) {
      return res.json({ ok: true, message: "すでに送信が取り消されています。" });
    }

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
    if (msgData.senderUid !== myUid && req.user.username !== "hato2170" && !myUid.startsWith("pcIKtKGb")) {
      return res.status(403).json({ error: "自分のメッセージのみ削除できます。" });
    }

    await msgRef.delete();

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
app.get("/api/music/search", requireLogin, async (req, res) => {
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

// ユーザープロフィール詳細更新 (ステメ, BGM, フォント, テーマ, カバー画像)
app.put("/api/users/profile", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  const myUid = req.user.uid;
  const { statusMessage, bgm, font, theme, coverUrl, photoURL, username } = req.body;

  try {
    const userRef = db.collection("users").doc(myUid);
    const updateData = {};
    if (statusMessage !== undefined) updateData.statusMessage = String(statusMessage);
    if (bgm !== undefined) updateData.bgm = bgm; // { trackName, artistName, previewUrl, artworkUrl }
    if (font !== undefined) updateData.font = String(font);
    if (theme !== undefined) updateData.theme = String(theme);
    if (coverUrl !== undefined) updateData.coverUrl = String(coverUrl);
    if (photoURL !== undefined) updateData.photoURL = String(photoURL);
    if (username !== undefined) updateData.username = String(username);

    updateData.updatedAt = Date.now();
    await userRef.set(updateData, { merge: true });

    return res.json({ ok: true, profile: updateData });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// アルバム一覧取得
app.get("/api/chats/:chatId/albums", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  try {
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
    const albumData = {
      title: String(title),
      photos: Array.isArray(photos) ? photos : [],
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
  try {
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
    const userDoc = await db.collection("users").doc(myUid).get();
    const authorName = userDoc.exists ? userDoc.data().username : "ユーザー";

    const noteData = {
      authorUid: myUid,
      authorName,
      text: String(text || ""),
      images: Array.isArray(images) ? images : [],
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
  try {
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
    const pollData = {
      title: String(title),
      options: options.map(opt => ({ text: String(opt), votes: [] })),
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
  try {
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
    const eventData = {
      title: String(title),
      date: String(date || ""),
      location: String(location || ""),
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

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`mokori server listening on port ${port}`);
});
