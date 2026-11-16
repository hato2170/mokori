const fs = require("fs");
const path = require("path");
const https = require("https");
const vm = require("vm");
const { Readable } = require("stream");
const dns = require("dns");
// Render などのクラウド環境では、外向きの IPv6 接続が確立しないまま固まり
// fetch が UND_ERR_CONNECT_TIMEOUT（fetch failed）で落ちることがある。
// 名前解決の結果を IPv4 優先にしておく（DNS の AAAA が先に返るホスト対策）。
// 例: 天才プロキシで「相手のサイトが一時的に応答していない…」と出る原因のひとつ。
try { dns.setDefaultResultOrder("ipv4first"); } catch (_) {}
const express = require("express");
const admin = require("firebase-admin");
const bcrypt = require("bcryptjs");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "15mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(express.urlencoded({ extended: true, limit: "15mb", verify: (req, _res, buf) => { req.rawBody = buf; } }));

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

// 🏠 プロキシ中の「見た目のホーム（/?__px=1）」だけは、もこりのトップではなく
// プロキシしていたサイトへ戻す（YouTube のトップを再読み込みしても消えないように）。
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if ((req.path || "/") !== "/") return next();
  if (!("__px" in (req.query || {}))) return next();
  const origin = proxyOriginFromRequest(req);
  if (!origin) return next();
  return res.redirect(307, "/api/proxy?url=" + encodeURIComponent(origin + "/") + "&_spa=1");
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

// ====================================================
// ⚡ プロキシ内相対リンク・Instagram/TikTok遷移の自動救済
// ====================================================
app.use((req, res, next) => {
  // 1. Instagramの典型的なパス（/accounts/...）
  if (req.path.startsWith("/accounts/")) {
    const targetUrl = new URL(req.originalUrl, "https://www.instagram.com").href;
    return res.redirect(`/api/proxy?url=${encodeURIComponent(targetUrl)}`);
  }

  // 2. Refererがプロキシの場合の相対リクエスト救済
  const referer = req.headers.referer || "";
  if (referer.includes("proxy?url=") && !req.path.startsWith("/api/")) {
    try {
      const prevTarget = decodeURIComponent((referer.split("proxy?url=")[1] || "").split("&")[0]);
      if (prevTarget) {
        const targetUrl = new URL(req.originalUrl, prevTarget).href;
        if (req.accepts("html") && req.method === "GET") {
          return res.redirect(`/api/proxy?url=${encodeURIComponent(targetUrl)}`);
        }
      }
    } catch (_) {}
  }

  next();
});

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
    // ⚠️ 以前は asc + limit で「古い順に250件」を取っていたため、250件を超えたトークでは
    //    新しいメッセージ（今日の会話）が画面に出なくなっていた。最新250件を取ってから
    //    昇順に直す（＝常に直近の会話が見える）。
    const snapshot = await db.collection("chats").doc(chatId)
      .collection("messages")
      .orderBy("createdAt", "desc")
      .limit(MAX_MEM_MESSAGES)
      .get();
    const msgs = [];
    snapshot.forEach(doc => {
      msgs.push({ id: doc.id, ...doc.data() });
    });
    msgs.reverse();
    memoryChatMessages.set(chatId, msgs);
    return msgs;
  } catch (err) {
    console.warn("Fast get messages DB fallback:", err.message);
    return memoryChatMessages.get(chatId) || [];
  }
}
const CACHE_TTL_MS = 3000;

// ----------------------------------------------------
// ⭐ 「アップデート完了！」「テスト」等のメッセージ完全自動抹消処理
// ----------------------------------------------------
async function purgeUpdateAndTestMessages(extraWord = "") {
  if (!db) return { ok: false, error: "Firebase DB is not initialized" };
  try {
    console.log("[Cleanup] Starting purge of update/test messages across all chats...");
    const chatsSnap = await db.collection("chats").get();
    let totalDeleted = 0;
    const deletedList = [];

    // 0. テストユーザー (haruto_unlimited や「ぶろすたがすきです！」等) の完全消去
    try {
      const usersSnap = await db.collection("users").get();
      for (const uDoc of usersSnap.docs) {
        const uData = uDoc.data() || {};
        const uName = String(uData.username || "").toLowerCase();
        const uBio = String(uData.bio || "");
        const uStatus = String(uData.statusMessage || "");
        const isTarget =
          uName.includes("haruto_unlimited") ||
          uName.includes("harutounlimited") ||
          uBio.includes("ぶろすたがすき") ||
          uStatus.includes("ぶろすたがすき") ||
          uBio.includes("ぶろすた") ||
          uName === "haruto_unlimited" ||
          uName === "haruto_unlimited_3";

        if (isTarget) {
          console.log(`[Cleanup] Deleting test user ${uDoc.id} (${uData.username})`);
          await uDoc.ref.delete().catch(() => {});
          if (uData.username) {
            await db.collection("usernames").doc(String(uData.username).toLowerCase()).delete().catch(() => {});
          }
          // 全員グループのメンバー一覧からも除外
          try {
            const allRef = db.collection("chats").doc("all_members");
            const allSnap = await allRef.get();
            if (allSnap.exists) {
              const allData = allSnap.data() || {};
              const members = (allData.members || []).filter(uid => uid !== uDoc.id);
              const memberInfo = { ...(allData.memberInfo || {}) };
              delete memberInfo[uDoc.id];
              await allRef.update({ members, memberInfo }).catch(() => {});
            }
          } catch (_) {}
        }
      }

      // usernames コレクションも念のため直接点検
      const unSnap = await db.collection("usernames").get();
      for (const unDoc of unSnap.docs) {
        if (unDoc.id.includes("haruto_unlimited") || unDoc.id.includes("harutounlimited")) {
          await unDoc.ref.delete().catch(() => {});
        }
      }
    } catch (e) {
      console.warn("[Cleanup] User purge error:", e.message);
    }

    for (const chatDoc of chatsSnap.docs) {
      const chatId = chatDoc.id;
      const chatRef = db.collection("chats").doc(chatId);
      const msgsSnap = await chatRef.collection("messages").get();

      for (const mDoc of msgsSnap.docs) {
        const data = mDoc.data();
        const text = String(data.text || "");
        const origText = String(data.originalText || "");
        const shouldDelete =
          mDoc.id === "TFtFQF3Blod4K4wB6zui" ||
          text.includes("俺は知らないよ") ||
          origText.includes("俺は知らないよ") ||
          text.includes("アップデート") ||
          text.includes("アプデ") ||
          text.includes("落ちないよ") ||
          text.includes("超安定化") ||
          text.includes("完了！") ||
          text.includes("アップデート完了") ||
          text.includes("テスト成功") ||
          text.includes("テスト") ||
          text.includes("ぶろすたがすき") ||
          origText.includes("ぶろすたがすき") ||
          text.includes("はると(cpu1)") ||
          origText.includes("はると(cpu1)") ||
          (data.senderName && (
            String(data.senderName).includes("haruto_unlimited") ||
            String(data.senderName).includes("はると(cpu1)") ||
            String(data.senderName).includes("haruto unlimited")
          )) ||
          (extraWord && (text.includes(extraWord) || origText.includes(extraWord)));

        if (shouldDelete) {
          console.log(`[Cleanup] Deleting message ${mDoc.id} in ${chatId}: "${text}" (orig: "${origText}")`);
          await mDoc.ref.delete().catch(() => {});
          deletedList.push({ chatId, msgId: mDoc.id, text: origText || text, senderName: data.senderName });
          totalDeleted++;
        }
      }

      // lastMessage と announcement の復旧・クリーンアップ
      const cData = chatDoc.data();
      const updates = {};
      if (cData.lastMessage) {
        const lastId = String(cData.lastMessage.id || "");
        const lastText = String(cData.lastMessage.text || "");
        const needUpdateLast =
          lastId === "TFtFQF3Blod4K4wB6zui" ||
          lastText.includes("俺は知らないよ") ||
          lastText.includes("アップデート") ||
          lastText.includes("アプデ") ||
          lastText.includes("落ちないよ") ||
          lastText.includes("超安定化") ||
          lastText.includes("完了！") ||
          lastText.includes("アップデート完了") ||
          lastText.includes("テスト成功") ||
          lastText.includes("テスト") ||
          (extraWord && lastText.includes(extraWord));

        if (needUpdateLast) {
          const prevSnap = await chatRef.collection("messages").orderBy("createdAt", "desc").limit(10).get();
          let foundPrev = null;
          for (const pDoc of prevSnap.docs) {
            if (pDoc.id === "TFtFQF3Blod4K4wB6zui") continue;
            const pData = pDoc.data();
            const pText = String(pData.text || "");
            const pOrig = String(pData.originalText || "");
            if (
              !pText.includes("俺は知らないよ") &&
              !pOrig.includes("俺は知らないよ") &&
              !pText.includes("アップデート") &&
              !pText.includes("アプデ") &&
              !pText.includes("テスト") &&
              !pText.includes("超安定化") &&
              !pText.includes("落ちないよ")
            ) {
              foundPrev = {
                id: pDoc.id,
                text: pText,
                senderName: pData.senderName || "",
                createdAt: pData.createdAt || null,
                unsent: Boolean(pData.unsent)
              };
              break;
            }
          }
          updates.lastMessage = foundPrev || null;
        }
      }
      if (cData.announcement) {
        const annText = String(cData.announcement.text || "");
        if (
          annText.includes("アップデート") ||
          annText.includes("アプデ") ||
          annText.includes("落ちないよ") ||
          annText.includes("超安定化") ||
          annText.includes("完了！") ||
          annText.includes("アップデート完了") ||
          annText.includes("テスト成功") ||
          annText.includes("テスト") ||
          annText.includes("俺は知らないよ") ||
          (extraWord && annText.includes(extraWord))
        ) {
          updates.announcement = null;
        }
      }
      if (Object.keys(updates).length > 0) {
        await chatRef.update(updates).catch(() => {});
        console.log(`[Cleanup] Fixed chat headers for ${chatId}:`, updates);
      }
    }

    memoryChatMessages.clear();
    messageCache.clear();
    console.log(`[Cleanup] Purge complete! Total messages deleted: ${totalDeleted}`);
    return { ok: true, deletedCount: totalDeleted, deleted: deletedList };
  } catch (err) {
    console.warn("[Cleanup] Purge error:", err.message);
    return { ok: false, error: err.message };
  }
}

// ----------------------------------------------------
// ⭐ 「もこり全員グループ」のメンバーを登録済みの全アカウントに揃える
//    （新規登録者の自動参加 + メンバー一覧から脱落してしまった既存アカウントの復元）
//    ※ joinedAt は「すでに入っている人」の値を残し、新しく足す人には入れない
//      （入れると「参加前のメッセージ」として過去ログが隠れてしまうため）
// ----------------------------------------------------
async function ensureAllMembersGroup() {
  if (!db) return null;
  try {
    const allRef = db.collection("chats").doc("all_members");
    const allSnap = await allRef.get();
    if (!allSnap.exists) return null;
    const usersSnap = await db.collection("users").get();
    if (usersSnap.empty) return null;

    const data = allSnap.data() || {};
    const members = Array.isArray(data.members) ? [...data.members] : [];
    const memberInfo = { ...(data.memberInfo || {}) };
    let changed = false;

    for (const uDoc of usersSnap.docs) {
      const uid = uDoc.id;
      const uData = uDoc.data() || {};
      const uname = String(uData.username || "ユーザー");
      if (!members.includes(uid)) {
        members.push(uid);
        changed = true;
      }
      const info = memberInfo[uid];
      if (!info) {
        memberInfo[uid] = { username: uname };
        changed = true;
      } else if (info.username !== uname) {
        memberInfo[uid] = { ...info, username: uname };
        changed = true;
      }
    }

    if (changed) {
      await allRef.update({
        members,
        memberInfo,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
      console.log(`[AllMembers] synced: ${members.length} members`);
    }
    return { ok: true, members: members.length, changed };
  } catch (e) {
    console.warn("[AllMembers] sync failed:", e.message);
    return { ok: false, error: e.message };
  }
}

// サーバー起動時に自動実行
setTimeout(() => {
  if (db) {
    purgeUpdateAndTestMessages().catch(() => {});
    ensureAllMembersGroup().catch(() => {});
  }
}, 1500);

// 手動呼び出し・確認用エンドポイント
app.all("/api/system/cleanup-messages", async (req, res) => {
  const extraWord = (req.query && req.query.text) || (req.body && req.body.text) || "";
  const result = await purgeUpdateAndTestMessages(extraWord);
  try {
    if (db) {
      const chatDoc = await db.collection("chats").doc("all_members").get();
      result.allMembersLastMessage = chatDoc.exists ? chatDoc.data().lastMessage : null;
      const mSnap = await db.collection("chats").doc("all_members").collection("messages").orderBy("createdAt", "desc").limit(10).get();
      const msgs = [];
      mSnap.forEach(m => msgs.push({ id: m.id, text: m.data().text, senderName: m.data().senderName }));
      result.allMembersMsgs = msgs;
    }
  } catch (err) {
    result.inspectError = err.message;
  }
  return res.json(result);
});

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

    // 新規登録した人も「もこり全員グループ」に入れる
    await ensureAllMembersGroup().catch(() => {});

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

  // Firestore の予約済みドキュメントID（__xxx__ や . / ..）は読み取り自体が例外になるため、
  // ログイン失敗（401）として扱う（以前は 500「ログインに失敗しました」になっていた）
  const usernameKey = username.toLowerCase();
  if (usernameKey === "." || usernameKey === ".." || /^__.*__$/.test(usernameKey)) {
    return res.status(401).json({
      error: "ユーザー名またはパスワードが違います。"
    });
  }

  try {
    const usernameDoc = await db
      .collection("usernames")
      .doc(usernameKey)
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
        // 既存の登録者も含めて全員をグループに入れる
        await ensureAllMembersGroup().catch(() => {});
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
    if (data.type === "direct" || data.type === "ai") {
      partnerUid = (data.members && data.members.find((u) => u !== myUid)) || (data.type === "ai" ? "ai_assistant" : myUid);
      const pInfo = data.memberInfo && data.memberInfo[partnerUid];
      name = pInfo ? pInfo.username : (data.name || "ユーザー");
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
    let messages = await getChatMessagesFast(chatId);

    // 途中からグループ・全体グループに入ってきたメンバーへの過去ログ保護
    if (db && (chatId === "all_members" || chatId.startsWith("group_") || chatId.startsWith("grp_"))) {
      try {
        const chatDoc = await db.collection("chats").doc(chatId).get();
        if (chatDoc.exists) {
          const cData = chatDoc.data();
          const myInfo = cData.memberInfo && cData.memberInfo[myUid];
          const myJoinedAt = myInfo && myInfo.joinedAt;
          if (myJoinedAt) {
            const joinMs = myJoinedAt.toMillis ? myJoinedAt.toMillis() : (typeof myJoinedAt === "number" ? myJoinedAt : 0);
            if (joinMs > 0) {
              messages = messages.filter(m => {
                if (!m.createdAt) return true;
                const mMs = m.createdAt.toMillis ? m.createdAt.toMillis() : (typeof m.createdAt === "number" ? m.createdAt : (m.createdAt._seconds ? m.createdAt._seconds * 1000 : 0));
                return mMs >= (joinMs - 2000); // 参加直前2秒以降のみ表示
              });
            }
          }
        }
      } catch (_) {}
    }

    return res.json({ messages });
  } catch (error) {
    console.error("メッセージ取得エラー:", error);
    return res.status(500).json({ error: "メッセージの取得に失敗しました。" });
  }
});

// 既読API (個別・グループ・全体・AIチャットの未読通知解除 & 既読者リスト更新)
app.post("/api/chats/:chatId/read", requireLogin, async (req, res) => {
  const chatId = req.params.chatId;
  const myUid = req.user.uid;
  const now = admin.firestore.Timestamp.now();

  try {
    // 1. メモリ内メッセージのreadByを即時更新 (未キャッシュなら取得して同期)
    let updatedCount = 0;
    if (!memoryChatMessages.has(chatId)) {
      await getChatMessagesFast(chatId);
    }
    const list = memoryChatMessages.get(chatId) || [];
    for (const m of list) {
      if (!m.readBy) m.readBy = [];
      if (!m.readBy.includes(myUid)) {
        m.readBy.push(myUid);
        updatedCount++;
      }
      if (chatId.startsWith("ai_") && !m.readBy.includes("ai_assistant")) {
        m.readBy.push("ai_assistant");
      }
    }

    // 2. FirestoreのチャットreadStatusを更新 (未読バッジの即時消去)
    if (db) {
      const chatRef = db.collection("chats").doc(chatId);
      chatRef.set({
        readStatus: { [myUid]: now }
      }, { merge: true }).catch(() => {});

      // メッセージのreadByもバッチ更新 (直近50件)
      chatRef.collection("messages")
        .orderBy("createdAt", "desc")
        .limit(50)
        .get()
        .then(snap => {
          const batch = db.batch();
          let count = 0;
          snap.docs.forEach(doc => {
            const data = doc.data();
            const readBy = Array.isArray(data.readBy) ? data.readBy : [];
            if (!readBy.includes(myUid)) {
              batch.update(doc.ref, {
                readBy: admin.firestore.FieldValue.arrayUnion(myUid)
              });
              count++;
            }
          });
          if (count > 0) batch.commit().catch(() => {});
        }).catch(() => {});
    }

    return res.json({ ok: true, updatedCount });
  } catch (err) {
    return res.status(500).json({ error: err.message });
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
    const liveMsg = {
      id: msgDoc.id,
      ...messageData,
      createdAt: { _seconds: Math.floor(Date.now() / 1000), _nanoseconds: 0 }
    };
    if (memoryChatMessages.has(chatId)) {
      const cached = memoryChatMessages.get(chatId);
      cached.push(liveMsg);
      // 上限を超えたら古いものから捨てる（キャッシュが無限に膨らまないように）
      if (cached.length > MAX_MEM_MESSAGES) {
        cached.splice(0, cached.length - MAX_MEM_MESSAGES);
      }
    } else {
      // キャッシュ未生成のときに1通だけのキャッシュを作ると、以降の読み込みで
      // 過去ログが全部消えて見えてしまう。ここでは何もせず、次の読み込みで
      // DBから最新250件を取らせる（クライアントは送信直後に再取得する）。
    }

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
          // 1. AIがユーザーのメッセージを既読にする (即時反映)
          if (memoryChatMessages.has(chatId)) {
            const list = memoryChatMessages.get(chatId) || [];
            for (const m of list) {
              if (!m.readBy) m.readBy = [];
              if (!m.readBy.includes("ai_assistant")) {
                m.readBy.push("ai_assistant");
              }
            }
          }
          if (db) {
            chatRef.collection("messages").doc(msgDoc.id).update({
              readBy: admin.firestore.FieldValue.arrayUnion("ai_assistant")
            }).catch(() => {});
          }

          const authHeader = req.headers.authorization || "";
          let aiText = "";
          try {
            let aiPayload = {
              message: text,
              model: "@cf/meta/llama-3.2-3b-instruct"
            };
            if (chatData.aiConversationId) {
              aiPayload.conversationId = chatData.aiConversationId;
            }
            let aiResp = await fetch("https://myyajuu-ai-worker.harumei-260329.workers.dev/v1/chat", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: authHeader
              },
              body: JSON.stringify(aiPayload)
            });
            // 既存の会話IDで失敗した場合は新規会話として即座に自動再試行
            if (!aiResp.ok && aiPayload.conversationId) {
              delete aiPayload.conversationId;
              aiResp = await fetch("https://myyajuu-ai-worker.harumei-260329.workers.dev/v1/chat", {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: authHeader
                },
                body: JSON.stringify(aiPayload)
              });
            }
            if (aiResp.ok) {
              const aiData = await aiResp.json();
              aiText = aiData.reply || aiData.assistantMessage?.content || aiData.response || aiData.message || "";
              if (aiData.conversationId && aiData.conversationId !== chatData.aiConversationId) {
                await chatRef.update({ aiConversationId: aiData.conversationId }).catch(() => {});
              }
            }
          } catch (e) {
            console.warn("AI fetch fallback:", e.message);
          }
          if (!aiText) {
            const t = text.trim();
            if (/^(こんにちは|はじめまして|やあ|hello|hi)/i.test(t)) {
              aiText = "こんにちは！メッセージありがとうございます！何か調べたいことや学校の課題、雑談など何でも気軽に聞いてくださいね。";
            } else if (/^(おはよう|おっは)/i.test(t)) {
              aiText = "おはようございます！今日も一日楽しくいきましょう！何かあればいつでも質問してくださいね。";
            } else if (/^(おやすみ|寝る)/i.test(t)) {
              aiText = "今日もお疲れ様でした！ゆっくり休んでくださいね。おやすみなさい🌙";
            } else if (/\?|？|教えて|どういう|何|なぜ|どうやって|オススメ|おすすめ/.test(t)) {
              aiText = `「${t.slice(0, 30)}」についてですね！上部の🤖「AIスタジオ」を開くと、最新のLlama 3.2モデルによる長文解説やリアルタイムWeb検索、画像生成機能も使えますよ！`;
            } else {
              aiText = `「${t.slice(0, 30)}」ですね！しっかり届きました。もっと詳しく聞きたいことや画像を作りたいときは、ぜひAIスタジオも使ってみてくださいね！`;
            }
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

  if (req.body.state) {
    room.state = {
      ...(room.state || {}),
      ...req.body.state,
      updatedBy: myUid,
      updatedAt: Date.now()
    };
  }
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

// フル尺音源（1曲まるごと）の解決: SoundCloud → Audius の順に探す
app.get("/api/music/full", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  try {
    const { resolveFull } = require("./lib/music-full");
    const out = await resolveFull({
      artist: req.query.artist,
      title: req.query.title,
      album: req.query.album,
      durationSec: Number(req.query.duration || 0) || 0
    });
    return res.json(out);
  } catch (err) {
    return res.status(500).json({ ok: false, why: String(err && err.message || err).slice(0, 150) });
  }
});

// フル尺実体の中継（Range対応・iOS/iPad Safariがシークできるように）
app.get("/api/music/fullfile", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const src = String(req.query.src || "soundcloud");
  const id = String(req.query.id || "").trim();
  if (!id) return res.status(400).send("id required");
  // YouTube 由来は実体を抱えず、レンジ対応のストリーム中継へ逃がす（
  // 音声は itag=140 の m4a。iOS Safari でもそのままシークできる）
  if (src === "youtube") {
    try {
      const mod = require("./lib/music-full");
      const audio = await mod.ytAudioUrl(id);
      if (!audio || !audio.url) return res.status(502).json({ ok: false, error: "音声ストリームを取得できませんでした" });
      res.setHeader("Cache-Control", "private, max-age=60");
      return res.redirect(`/api/tube/proxy-stream?url=${encodeURIComponent(audio.url)}`);
    } catch (err) {
      return res.status(502).json({ ok: false, error: String(err && err.message || err).slice(0, 150) });
    }
  }
  try {
    const mod = require("./lib/music-full");
    const info = src === "audius" ? await mod.audiusFile(id) : await mod.soundcloudFile(id);
    const size = info.size;
    res.setHeader("Accept-Ranges", "bytes");
    // 実ファイルの拡張子に合わせる（SoundCloudはprogressive配信だとmp3になる）
    res.setHeader("Content-Type", String(info.path).endsWith(".mp3") ? "audio/mpeg" : "audio/mp4");
    res.setHeader("Cache-Control", "public, max-age=3600");
    const range = req.headers.range;
    if (range) {
      const m = /bytes=(\d+)-(\d*)/.exec(String(range));
      let start = m ? parseInt(m[1], 10) : 0;
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1;
      if (!Number.isFinite(start) || start < 0) start = 0;
      if (!Number.isFinite(end) || end >= size) end = size - 1;
      if (start > end) {
        res.status(416);
        res.setHeader("Content-Range", `bytes */${size}`);
        return res.end();
      }
      res.status(206);
      res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
      res.setHeader("Content-Length", String(end - start + 1));
      return fs.createReadStream(info.path, { start, end }).pipe(res);
    }
    res.setHeader("Content-Length", String(size));
    return fs.createReadStream(info.path).pipe(res);
  } catch (err) {
    return res.status(502).json({ ok: false, error: String(err && err.message || err).slice(0, 150) });
  }
});

// Apple Music (iTunes Search API) 30秒試聴・曲検索プロキシ (ちゅこミュージック & yaju&king & プロフィールBGM共用)
app.get("/api/music/search", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const query = String(req.query.q || req.query.term || "STUTS Kaneee").trim();
  if (!query) return res.json({ ok: true, tracks: [], results: [] });

  try {
    const url = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&country=jp&entity=song&limit=30`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) {
      return res.status(response.status).json({ error: "音楽の検索に失敗しました。" });
    }
    const data = await response.json();
    const songs = (data.results || []).map(item => ({
      id: item.trackId,
      trackId: item.trackId,
      title: item.trackName,
      trackName: item.trackName,
      artist: item.artistName,
      artistName: item.artistName,
      album: item.collectionName || "",
      collectionName: item.collectionName || "",
      artwork: item.artworkUrl100 ? item.artworkUrl100.replace("100x100bb", "600x600bb") : "",
      artworkUrl: item.artworkUrl100 ? item.artworkUrl100.replace("100x100bb", "600x600bb") : "",
      previewUrl: item.previewUrl || "",
      durationMs: item.trackTimeMillis || 30000,
      releaseDate: item.releaseDate ? item.releaseDate.slice(0, 10) : "",
      trackViewUrl: item.trackViewUrl || ""
    }));
    return res.json({ ok: true, tracks: songs, results: songs });
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

// VOOM 投稿削除
app.delete("/api/voom/posts/:postId", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  const myUid = req.user.uid;
  try {
    const docRef = db.collection("voom_posts").doc(req.params.postId);
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: "投稿が見つかりません" });
    const post = snap.data();
    if (post.authorUid !== myUid) {
      return res.status(403).json({ error: "自分の投稿のみ削除できます" });
    }
    await docRef.delete();
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
});

// VOOM 投稿編集
app.put("/api/voom/posts/:postId", requireLogin, async (req, res) => {
  if (!db) return res.status(503).json({ error: "データベース未接続" });
  const myUid = req.user.uid;
  const { text, imageUrl } = req.body;
  try {
    const docRef = db.collection("voom_posts").doc(req.params.postId);
    const snap = await docRef.get();
    if (!snap.exists) return res.status(404).json({ error: "投稿が見つかりません" });
    const post = snap.data();
    if (post.authorUid !== myUid) {
      return res.status(403).json({ error: "自分の投稿のみ編集できます" });
    }
    const updateData = { updatedAt: Date.now() };
    if (text !== undefined) updateData.text = String(text).slice(0, 1000);
    if (imageUrl !== undefined) updateData.imageUrl = String(imageUrl);
    await docRef.update(updateData);
    return res.json({ ok: true });
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


function isBlockedHost(host) {
  if (!host) return true;
  const h = host.toLowerCase().trim();
  if (['localhost', '127.0.0.1', '0.0.0.0', '::1'].includes(h)) return true;
  if (h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.localhost')) return true;
  if (/^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2[0-9]|3[0-1])\./.test(h)) return true;
  if (/^169\.254\./.test(h)) return true;
  return false;
}

function renderProxyError(title, detail, retryUrl, extra) {
  const links = (extra && Array.isArray(extra.links)) ? extra.links : [];
  const note = (extra && extra.note) ? `<p style="font-size:12px;color:#94a3b8;margin-top:0;">${extra.note}</p>` : "";
  const extraBtns = links.map((l) => `<a href="${l.href}" class="btn ${l.primary ? "btn-primary" : "btn-sec"}">${l.label}</a>`).join("\n      ");
  return `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>お知らせ · 天才プロキシ</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #0b1120; color: #f8fafc; font-family: -apple-system, BlinkMacSystemFont, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; text-align: center; }
    .box { background: #1e293b; border: 1px solid #334155; border-radius: 16px; padding: 28px 22px; max-width: 500px; width: 100%; box-shadow: 0 10px 30px rgba(0,0,0,0.5); }
    h2 { color: #fbbf24; font-size: 19px; margin-bottom: 12px; line-height: 1.4; }
    p { color: #94a3b8; font-size: 14px; line-height: 1.7; margin-bottom: 16px; }
    .btn-row { display: flex; gap: 10px; justify-content: center; flex-wrap: wrap; }
    .btn { display: inline-block; padding: 10px 16px; border-radius: 8px; text-decoration: none; font-weight: bold; font-size: 13px; }
    .btn-primary { background: #0284c7; color: #fff; }
    .btn-sec { background: #334155; color: #cbd5e1; }
    .foot { margin-top: 18px; font-size: 11px; color: #475569; word-break: break-all; }
  </style>
</head>
<body>
  <div class="box">
    <h2>⚠️ ${title}</h2>
    <p>${detail}</p>
    ${note}
    <div class="btn-row">
      ${retryUrl ? `<a href="${retryUrl}" class="btn btn-primary">🔄 もう一度読み込む</a>` : ""}
      ${extraBtns}
      <a href="/tensai-proxy/" class="btn btn-sec">🏠 天才プロキシへ戻る</a>
    </div>
    <div class="foot">天才プロキシ</div>
  </div>
</body>
</html>`;
}

// ====================================================
// ⭐ 天才プロキシ (Web Proxy Engine)
// 学校iPad等のフィルターを完全回避し、リンク書き換え & ストリーミング中継
// ====================================================
app.use(async (req, res, next) => {
  if (req.method === "GET" && req.path.startsWith("/api/")) {
    const filename = req.path.slice(5);
    const knownApiPrefixes = ["system", "health", "register", "login", "users", "friends", "chats", "games", "calls", "music", "voom", "proxy", "tube", "tiktok", "instagram", "media", "tempmail", "ai"];
    const firstPart = filename.split("/")[0].toLowerCase();
    if (!knownApiPrefixes.includes(firstPart)) {
      if (filename.includes("poki-sdk")) {
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.setHeader("Access-Control-Allow-Origin", "*");
        return res.send(`
          (function() {
            window.pokiDebug = true;
            window.poki_nobot = true;
            var targetSDK = {
              init: function() { return Promise.resolve(); },
              gameLoadingStart: function() {},
              gameLoadingFinished: function() {},
              gameLoadingProgress: function() {},
              gameplayStart: function() {},
              gameplayStop: function() {},
              commercialBreak: function() { return Promise.resolve(); },
              rewardedBreak: function() { return Promise.resolve(true); },
              displayAd: function() { return Promise.resolve(); },
              destroyAd: function() {},
              setDebug: function() {},
              happyTime: function() {},
              showLeaderboard: function() { return Promise.resolve(); },
              getLeaderboard: function() { return Promise.resolve([]); },
              measure: function() {},
              setPlayerAge: function() {},
              toggleMute: function() {},
              captureError: function() {},
              muteAd: function() {},
              setPayload: function() {},
              customEvent: function() {},
              getPayload: function() { return Promise.resolve({}); },
              isAdBlocked: function() { return false; },
              getParam: function() { return null; },
              shareableURL: function() { return Promise.resolve(window.location.href); },
              dequeue: function() {}
            };
            window.PokiSDK = new Proxy(targetSDK, {
              get: function(t, p) {
                if (p in t) return t[p];
                return function() { return Promise.resolve(); };
              }
            });
            try {
              if (typeof targetSDK.dequeue === 'function') targetSDK.dequeue();
            } catch(_) {}
          })();
        `);
      }

      const referer = req.headers.referer || "";
      if (referer.includes("proxy?url=")) {
        try {
          const rawTarget = decodeURIComponent((referer.split("proxy?url=")[1] || "").split("&")[0]);
          const dir = rawTarget.substring(0, rawTarget.lastIndexOf("/") + 1);
          const candidates = [
            dir + filename,
            dir + "webapp/" + filename,
            new URL(filename, dir).href
          ];
          const isPokiTarget = rawTarget.includes("poki");
          const customHeaders = { "User-Agent": "Mozilla/5.0" };
          if (isPokiTarget) {
            customHeaders["Referer"] = "https://poki.com/";
            customHeaders["Origin"] = "https://poki.com";
          }
          for (const cand of candidates) {
            try {
              const resp = await fetch(cand, { headers: customHeaders });
              if (resp.ok) {
                const ct = resp.headers.get("content-type") || (filename.endsWith(".wasm") ? "application/wasm" : filename.endsWith(".js") ? "application/javascript" : "application/octet-stream");
                res.setHeader("Content-Type", ct);
                res.setHeader("Access-Control-Allow-Origin", "*");
                const buf = await resp.arrayBuffer();
                return res.end(Buffer.from(buf));
              }
            } catch (_) {}
          }
        } catch (_) {}
      }
      return res.status(404).send("Not found");
    }
  }
  next();
});

// ====================================================
// 🛡 上流フェッチの堅牢化
// 「ページを読み込めませんでした」「fetch failed」の多くは、上流がUAやIPで
// 接続を切っているだけなので、別UAで自動的にやり直せば通る。
// ====================================================
const UA_IOS_SAFARI = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const UA_DESKTOP_CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const UA_YOUTUBE = UA_DESKTOP_CHROME;

// 📱 端末がスマホかどうか（iPadはデスクトップ扱い: 画面が広く、PC版のままでも崩れない）
function isMobileClientUA(ua) {
  const s = String(ua || "");
  if (/iPad/i.test(s)) return false;
  return /iPhone|iPod|Android.*Mobile|Windows Phone|BlackBerry|Opera Mini/i.test(s);
}

function pickUAForHost(hostname, clientUA) {
  const h = String(hostname || "").toLowerCase();
  if (h.includes("instagram.com") || h.includes("cdninstagram.com") || h.includes("fbcdn.net")) return UA_IOS_SAFARI;
  if (h.includes("tiktok") || h.includes("ttwstatic") || h.includes("ibytedtos") || h.includes("ibyteimg")) {
    // TikTokはUAで違う画面を返す。PC版のログイン画面は幅390pxのiPhoneでは
    // カードが重なってボタンが切れる（＝「デザインがぶっ壊れてる」の正体）。
    // スマホから来たときは端末のUAをそのまま上流へ渡し、TikTok自身の
    // モバイル画面（スマホ用に組まれたレイアウト）を返してもらう。
    if (isMobileClientUA(clientUA)) return clientUA;
    return UA_DESKTOP_CHROME;
  }
  // YouTubeはiPhone SafariのUAだとデータセンターIPからの接続を切られる（実測: fetch failed）
  if (h.includes("youtube.com") || h.includes("youtu.be") || h.includes("ytimg.com") || h.includes("googlevideo.com") || h.includes("googleusercontent.com")) return UA_YOUTUBE;
  return clientUA || UA_DESKTOP_CHROME;
}

async function fetchUpstream(targetUrl, baseHeaders, fetchOpts, { allowUAChange = true, timeoutMs = 0, retries = 0 } = {}) {
  const uaList = [];
  if (baseHeaders["User-Agent"]) uaList.push(baseHeaders["User-Agent"]);
  if (allowUAChange && !uaList.includes(UA_DESKTOP_CHROME)) uaList.push(UA_DESKTOP_CHROME);
  let lastError = null;
  for (let i = 0; i < uaList.length; i++) {
    const headers = { ...baseHeaders, "User-Agent": uaList[i] };
    // 文書は待ち時間を切る。上流が無応答のまま数十秒ぶら下がると、Safari側が
    // 「問題が発生したため、ページを読み込めませんでした」で打ち切ってしまう。
    const attemptOpts = timeoutMs > 0 ? { ...fetchOpts, signal: AbortSignal.timeout(timeoutMs) } : fetchOpts;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const response = await fetch(targetUrl, { ...attemptOpts, headers });
        const wantsDoc = String(headers["Accept"] || "").includes("text/html");
        // 上流が文書そのものを拒否したときだけ、UAを替えて一度やり直す（429は回線制限なので再試行しない）
        if (i === 0 && wantsDoc && uaList.length > 1 && [401, 403, 406, 451, 502, 503].includes(response.status)) {
          lastError = new Error("upstream refused: HTTP " + response.status);
          break;
        }
        return response;
      } catch (err) {
        lastError = err;
        const code = err && err.cause ? String(err.cause.code || "") : "";
        // 🕒 接続タイムアウト（UND_ERR_CONNECT_TIMEOUT / ETIMEDOUT）は
        // 「相手が一瞬だけ応答しない」「IPv6 側で固まる」だけで起きる。
        // UA を変える意味は無いが、少し待って同じ URL を引き直すと通ることが多いので
        // 一度だけ即リトライする（以前はここで即諦めて 502 画面になっていた）。
        const connectTimeout = ["UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT", "UND_ERR_SOCKET", "ECONNRESET"].includes(code);
        // DNS 不能・経路そのものが無い場合は UA を変えても同じなので即あきらめる
        const unreachable = ["ENOTFOUND", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "EAI_AGAIN"].includes(code);
        if (connectTimeout && !err.__tubeConnectRetried) {
          try {
            await new Promise((r) => setTimeout(r, 700));
            const retryResponse = await fetch(targetUrl, { ...attemptOpts, headers });
            return retryResponse;
          } catch (retryErr) {
            if (retryErr && typeof retryErr === "object") retryErr.__tubeConnectRetried = true;
            lastError = retryErr;
          }
        }
        if (unreachable || connectTimeout) return Promise.reject(lastError);
        // 「接続が途中で切れた」系（MetaがデータセンターIPを弾く典型）は少し待ってもう一度
        if (attempt < retries) {
          await new Promise((r) => setTimeout(r, 600));
          continue;
        }
      }
    }
  }
  throw lastError || new Error("upstream fetch failed");
}

// プロキシ経由のページから相対パスがはみ出したとき（Worker内の /ttwid/check/ 等）に
// どの上流へ戻すかを決めるためのCookie名
const PROXY_ORIGIN_COOKIE = "__px_origin";

// ====================================================
// 👷 Web Worker 用URL解決シム
// TikTok は Worker の中で `/ttwid/check/` や `/api/core.js` を「ワーカー基準の相対URL」で
// 呼ぶため、ページ側の書き換えが一切効かず、すべて mokori の404へ抜けて
// 「不明なエラーが発生しました」になっていた。Workerの中だけに、上流基準で
// 解決し直す小さなシムを先頭に注入する（通常のページ用スクリプトでは何もしない）。
// ====================================================
// 🧭 バンドル内の location 参照を、プロキシ用のモック location へ差し替える。
// 以前は `location.href` を `(条件 ? モック.href : location.href)` という【式】に
// 置き換えていたため、`location.href = url` のように代入の左辺に来ると Safari/JSC が
//   SyntaxError: Left side of assignment is not a reference
// を投げ、そのバンドルは1行も実行されなくなっていた（TurboWarp が起動しなかった原因。
// player.js 12行目・vendors~…player.js 13行目＝差し込みシムの直後の行で必ず失敗していた）。
// いまは「関数呼び出しの戻り値のプロパティ」= PX_LOC_EXPR.href の形だけを作る。
// これは読み取りにも代入の左辺にも使える参照なので、どちらでも構文エラーにならない。
//
// 置き換え先はグローバル変数ではなく、その場で完結した式にしてある。Worker が
// blob から作られていたり、シムを通らない文書（iframeのsrcdoc等）だったりしても、
// 「モックが無ければ本物の location」に自分でフォールバックするため、
// 未定義参照でバンドルが落ちることがない。
const PX_LOC_EXPR = "(function(){try{return (typeof window!=='undefined'&&window.__proxy_location)||location;}catch(e){return location;}})()";
function pxRewriteLocationRefs(js) {
  const rewriteCode = (code) => {
    if (code.indexOf("location") < 0) return code;
    // ① 裸の location への代入（location = url / window.location = url）は
    //    モックの href セッターへ回す（`==`/`===` の比較は対象外）
    let s = code.replace(/\b(?:window|self|document)\s*\.\s*location\s*=(?!=)/g, PX_LOC_EXPR + ".href =");
    s = s.replace(/(^|[^.\w$])location\s*=(?!=)/g, "$1" + PX_LOC_EXPR + ".href =");
    // ② window.location / self.location / document.location は本体ごとモックへ
    s = s.replace(/\b(?:window|self|document)\s*\.\s*location\b/g, PX_LOC_EXPR);
    // ③ 素の location はプロパティ参照・メソッド呼び出しだけを置き換える
    //    （オブジェクトのキー `{location: ...}` は触らない）
    s = s.replace(/(^|[^.\w$])location\b(?!\s*:)/g, "$1" + PX_LOC_EXPR);
    return s;
  };
  // 文字列・テンプレート・コメント・正規表現リテラルの中は書き換えない
  // （"location.pathname" のような文字列まで壊すと、サイト側の判定が狂うため）
  let out = "";
  let i = 0;
  let seg = 0;
  const n = js.length;
  let prevSig = "";
  const REGEX_OK = "([{!&|?:;,+-*%~^<>=";
  while (i < n) {
    const c = js[i];
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n) {
        const d = js[j];
        if (d === "\\") { j += 2; continue; }
        if (d === c) { j++; break; }
        if (c !== "`" && (d === "\n" || d === "\r")) { j++; break; }
        j++;
      }
      out += rewriteCode(js.slice(seg, i)) + js.slice(i, j);
      seg = j;
      i = j;
      prevSig = c;
      continue;
    }
    if (c === "/" && js[i + 1] === "/") {
      let j = i + 2;
      while (j < n && js[j] !== "\n") j++;
      out += rewriteCode(js.slice(seg, i)) + js.slice(i, j);
      seg = j;
      i = j;
      continue;
    }
    if (c === "/" && js[i + 1] === "*") {
      let j = js.indexOf("*/", i + 2);
      j = j < 0 ? n : j + 2;
      out += rewriteCode(js.slice(seg, i)) + js.slice(i, j);
      seg = j;
      i = j;
      continue;
    }
    if (c === "/" && (prevSig === "" || REGEX_OK.indexOf(prevSig) >= 0)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < n) {
        const d = js[j];
        if (d === "\\") { j += 2; continue; }
        if (d === "\n") break;
        if (inClass) { if (d === "]") inClass = false; }
        else if (d === "[") inClass = true;
        else if (d === "/") { j++; closed = true; break; }
        j++;
      }
      if (closed) {
        while (j < n && /[a-z]/i.test(js[j])) j++;
        out += rewriteCode(js.slice(seg, i)) + js.slice(i, j);
        seg = j;
        i = j;
        prevSig = "/";
        continue;
      }
    }
    if (c !== " " && c !== "\n" && c !== "\t" && c !== "\r") prevSig = c;
    i++;
  }
  out += rewriteCode(js.slice(seg, n));
  return out;
}

// 差し替え後のコードが本当に構文として通るか確かめる（実行はしない）。
// ESモジュール（import/export を含むファイル）はここでは通らないので、
// その場合は「元も通らない＝判定不能」として差し替えをそのまま採用する。
function pxJsCompiles(src) {
  try {
    new vm.Script(src, { filename: "px-loc-check.js" });
    return true;
  } catch (_) {
    return false;
  }
}

const PROXY_WORKER_SHIM = `(function(){try{
if(typeof document!=="undefined"||typeof location==="undefined")return;
var q=location.search||"",m=/[?&]url=([^&]*)/.exec(q);if(!m)return;
var B="";try{B=decodeURIComponent(m[1]);}catch(e){return;}
if(!B)return;
var SX=location.origin;
function px(u){if(typeof u!=="string"||!u)return u;if(u.indexOf("/api/proxy?url=")>=0)return u;var p=u.slice(0,5);if(p==="data:"||p==="blob:"||p==="java")return u;try{var a=new URL(u,B);if(a.origin===SX)return a.href;return SX+"/api/proxy?url="+encodeURIComponent(a.href);}catch(e){return u;}}
if(typeof importScripts==="function"){var _is=importScripts;try{importScripts=function(){var a=[].slice.call(arguments);for(var i=0;i<a.length;i++)a[i]=px(a[i]);return _is.apply(this,a);};}catch(e){}}
if(typeof fetch==="function"){var _f=fetch;try{fetch=function(i,o){try{if(typeof i==="string")i=px(i);else if(i&&typeof i.url==="string"){var r=new Request(i,o);i=new Request(px(r.url),r);o=undefined;}}catch(e){}return _f.call(this,i,o);};}catch(e){}}
if(typeof XMLHttpRequest!=="undefined"&&XMLHttpRequest.prototype){var _o=XMLHttpRequest.prototype.open;try{XMLHttpRequest.prototype.open=function(a,b){try{if(typeof b==="string")arguments[1]=px(b);}catch(e){}return _o.apply(this,arguments);};}catch(e){}}
}catch(e){}})();\n`;

// ====================================================
// 🎬 Google IMA（動画広告SDK）の安全なスタブ
// 本物の ima3.js は先頭で「読み込み元が google ドメインか」を document.location と
// <script src> の両方で検証し、プロキシ経由（/api/proxy?url=...）では必ず
//   Error: IMA SDK is either not loaded from a google domain or is not a supported version.
// を投げる。広告待ちのゲームはその例外で広告ブレークから戻れなくなる
// （Pokiで出ていた ⚠ 1件の正体）。広告自体は中継できないので、ゲームが待っている
// イベント（AD_ERROR / ADS_MANAGER_LOADED / ALL_ADS_COMPLETED）だけを返す
// API互換スタブを配り、ゲームの進行は止めない。
// ====================================================
// Poki の本物のSDKが読み込まれた「後」に広告系だけ差し替える小さなパッチ
const POKI_SDK_PATCH = [
  ';/*__pokiInstant*/(function(){',
  'function p(){try{',
  'var s=window.PokiSDK;if(!s||s.__pokiInstant)return;',
  'var w=new Proxy(s,{get:function(t,k){',
  'if(k==="commercialBreak"||k==="displayAd"||k==="showLeaderboard"||k==="init"||k==="gameLoadingFinished"||k==="gameLoadingStart")return function(){return Promise.resolve();};',
  'if(k==="rewardedBreak")return function(){return Promise.resolve(true);};',
  'if(k==="isAdBlocked")return function(){return true;};',
  'var v=t[k];return typeof v==="function"?v.bind(t):v;',
  '}});',
  'Object.defineProperty(w,"__pokiInstant",{value:true});',
  'window.PokiSDK=w;',
  '}catch(e){}}',
  'p();[0,30,200,800,2000].forEach(function(ms){setTimeout(p,ms);});',
  '})();'
].join("\n");

const IMA_STUB_JS = `(function () {
  try {
    var W = window;
    var existing = W.google && W.google.ima;
    if (existing && existing.__pxImaStub) return;
    if (existing && existing.AdsLoader) return;

    function noop() {}
    function isFn(f) { return typeof f === "function"; }

    function Event(type, extra) {
      this.type = type;
      this.target = null;
      this.currentTarget = null;
      this._extra = extra || null;
    }
    Event.prototype.preventDefault = noop;
    Event.prototype.stopPropagation = noop;
    Event.prototype.stopImmediatePropagation = noop;
    Event.prototype.isDefaultPrevented = function () { return false; };

    function Bus() { this._l = {}; }
    Bus.prototype.addEventListener = function (type, fn) {
      if (!type || !isFn(fn)) return;
      (this._l[type] = this._l[type] || []).push(fn);
    };
    Bus.prototype.removeEventListener = function (type, fn) {
      var a = this._l[type];
      if (!a) return;
      var i = a.indexOf(fn);
      if (i >= 0) a.splice(i, 1);
    };
    Bus.prototype.removeAllListeners = function () { this._l = {}; };
    Bus.prototype._count = function (type) { var a = this._l[type]; return a ? a.length : 0; };
    Bus.prototype._fire = function (ev) {
      var a = ev && this._l[ev.type];
      if (!a || !a.length) return 0;
      a = a.slice();
      for (var i = 0; i < a.length; i++) {
        try { a[i].call(this, ev); } catch (e) { try { console.warn("[ima-stub]", e); } catch (_) {} }
      }
      return a.length;
    };

    function AdError(code, message, type) {
      this._c = (code == null ? 1005 : code);
      this._m = message || "Ads are not available here";
      this._t = type || "unknown";
    }
    AdError.prototype.getErrorCode = function () { return this._c; };
    AdError.prototype.getMessage = function () { return this._m; };
    AdError.prototype.getType = function () { return this._t; };
    AdError.prototype.getVastErrorCode = function () { return this._c; };
    AdError.prototype.getInnerError = function () { return null; };
    AdError.prototype.toString = function () { return "AdError(" + this._c + "): " + this._m; };
    AdError.ErrorCode = {
      UNKNOWN_ERROR: 900, ADS_REQUEST_NETWORK_ERROR: 101, INVALID_AD_TAG: 102,
      VAST_MALFORMED_RESPONSE: 100, VAST_TRAFFICKING_ERROR: 200, VAST_LOAD_TIMEOUT: 301,
      VAST_TOO_MANY_REDIRECTS: 302, VAST_NO_ADS_AFTER_WRAPPER: 303,
      VIDEO_PLAY_ERROR: 400, VAST_MEDIA_LOAD_TIMEOUT: 402, VAST_LINEAR_ASSET_MISMATCH: 403,
      COMPANION_REQUIRED_ERROR: 602, ADSLOT_TOO_LARGE_FOR_PLAYER: 605,
      REQUIRED_LISTENER_NOT_LISTENING: 905, REQUIRED_TAG_MISSING: 906,
      VAST_UNSUPPORTED_VERSION: 103, VAST_AD_NOT_SUPPORTED: 104
    };

    function AdEvent(type, ad) {
      Event.call(this, type);
      this._ad = ad || null;
      this.ad = ad || null;
    }
    AdEvent.prototype = Object.create(Event.prototype);
    AdEvent.prototype.constructor = AdEvent;
    AdEvent.prototype.getAd = function () { return this._ad; };
    AdEvent.prototype.getAdData = function () { return {}; };
    AdEvent.Type = {
      AD_BREAK_READY: "adBreakReady", AD_BREAK_START: "adBreakStart", AD_BREAK_END: "adBreakEnd",
      AD_BUFFERING: "adBuffering", AD_PROGRESS: "adProgress", AD_METADATA: "adMetadata",
      LOADED: "loaded", STARTED: "start", FIRST_QUARTILE: "firstquartile",
      MIDPOINT: "midpoint", THIRD_QUARTILE: "thirdquartile", COMPLETE: "complete",
      PAUSED: "pause", RESUMED: "resume", SKIPPED: "skip",
      SKIPPABLE_STATE_CHANGED: "skippableStateChanged", CLICK: "click", TAPPED: "tapped",
      ICON_TAPPED: "iconTapped", USER_CLOSE: "userClose", ALL_ADS_COMPLETED: "allAdsCompleted",
      CONTENT_PAUSE_REQUESTED: "contentPauseRequested", CONTENT_RESUME_REQUESTED: "contentResumeRequested",
      AD_PERFORMANCE_MEASUREMENT: "adPerformanceMeasurement", AD_IMPRESSION: "adImpression",
      INTERACTION: "interaction", VOLUME_CHANGED: "volumeChange", VOLUME_MUTED: "mute",
      DURATION_CHANGE: "durationChange", AD_POD_DURATION_CHANGED: "adPodDurationChanged",
      LINEAR_AD_DURATION_CHANGED: "linearAdDurationChanged"
    };

    function AdErrorEvent(error) {
      Event.call(this, "adError");
      this._e = error || new AdError();
    }
    AdErrorEvent.prototype = Object.create(Event.prototype);
    AdErrorEvent.prototype.constructor = AdErrorEvent;
    AdErrorEvent.prototype.getError = function () { return this._e; };
    AdErrorEvent.prototype.getUserRequestContext = function () { return null; };
    AdErrorEvent.Type = { AD_ERROR: "adError", LOAD: "load" };

    function AdDisplayContainer(adContainer, videoElement, clickTracking) {
      this._a = adContainer || null;
      this._v = videoElement || null;
      this._c = clickTracking || null;
    }
    AdDisplayContainer.prototype.initialize = noop;
    AdDisplayContainer.prototype.destroy = noop;
    AdDisplayContainer.prototype.getAdContainer = function () { return this._a; };
    AdDisplayContainer.prototype.getVideoElement = function () { return this._v; };

    function ImaSdkSettings() {
      this._numRedirects = 4;
      this._autoPlayAdBreaks = true;
      this._vpaidAllowed = true;
      this._playerType = "";
      this._playerVersion = "";
    }
    ImaSdkSettings.prototype.setVpaidAllowed = noop;
    ImaSdkSettings.prototype.setVpaidMode = noop;
    ImaSdkSettings.prototype.setDisableCustomPlaybackForIOS10Plus = noop;
    ImaSdkSettings.prototype.setAutoPlayAdBreaks = noop;
    ImaSdkSettings.prototype.setNumRedirects = noop;
    ImaSdkSettings.prototype.setPpid = noop;
    ImaSdkSettings.prototype.setPlayerType = noop;
    ImaSdkSettings.prototype.setPlayerVersion = noop;
    ImaSdkSettings.prototype.setSessionId = noop;
    ImaSdkSettings.prototype.setLocale = noop;
    ImaSdkSettings.prototype.setRestrictToCustomPlayback = noop;
    ImaSdkSettings.prototype.setMaxRedirects = noop;
    ImaSdkSettings.prototype.setFeatureFlags = noop;
    ImaSdkSettings.prototype.getNumRedirects = function () { return this._numRedirects; };
    ImaSdkSettings.prototype.getPpid = function () { return ""; };
    ImaSdkSettings.prototype.getPlayerType = function () { return this._playerType; };
    ImaSdkSettings.prototype.getPlayerVersion = function () { return this._playerVersion; };
    ImaSdkSettings.prototype.getLocale = function () { return "en"; };
    ImaSdkSettings.prototype.isVpaidAllowed = function () { return true; };
    ImaSdkSettings.prototype.getAutoPlayAdBreaks = function () { return true; };
    ImaSdkSettings.prototype.isRestrictToCustomPlayback = function () { return false; };

    var globalSettings = new ImaSdkSettings();

    function AdsRenderingSettings() {
      this.restoreCustomPlaybackStateOnAdBreakComplete = false;
      this.uiElements = [];
      this.enablePreloading = false;
      this.bitrate = -1;
      this.mimeTypes = [];
      this.playMuted = false;
    }
    AdsRenderingSettings.prototype.setMimeTypes = function () {};
    AdsRenderingSettings.prototype.setUiElements = function () {};

    function AdsRequest(obj) {
      this.adTagUrl = "";
      this.adsResponse = "";
      this.linearAdSlotWidth = 640;
      this.linearAdSlotHeight = 360;
      this.nonlinearAdSlotWidth = 640;
      this.nonlinearAdSlotHeight = 100;
      this.adWillAutoPlay = false;
      this.adWillPlayMuted = false;
      this.omidAccessModeRules = {};
      this.vastLoadTimeout = -1;
      this.loadTimeout = -1;
      if (obj) for (var k in obj) { try { this[k] = obj[k]; } catch (_) {} }
    }
    AdsRequest.prototype.setAdWillAutoPlay = function (v) { this.adWillAutoPlay = !!v; };
    AdsRequest.prototype.setAdWillPlayMuted = function (v) { this.adWillPlayMuted = !!v; };
    AdsRequest.prototype.setVastLoadTimeout = function (v) { this.vastLoadTimeout = v; };
    AdsRequest.prototype.setLoadTimeout = function (v) { this.loadTimeout = v; };
    AdsRequest.prototype.setContinuousPlayback = function () {};
    AdsRequest.prototype.setContentDuration = function () {};
    AdsRequest.prototype.setContentKeywords = function () {};
    AdsRequest.prototype.setContentTitle = function () {};

    function AdsManager(loader) {
      Bus.call(this);
      this._loader = loader || null;
      this._started = false;
      this._volume = 1;
    }
    AdsManager.prototype = Object.create(Bus.prototype);
    AdsManager.prototype.constructor = AdsManager;
    AdsManager.prototype._fireBoth = function (ev) {
      var n = this._fire(ev);
      if (this._loader && this._loader._fire) { try { n += this._loader._fire(ev); } catch (_) {} }
      return n;
    };
    AdsManager.prototype.init = noop;
    AdsManager.prototype.start = function () {
      var self = this;
      if (self._started) return;
      self._started = true;
      setTimeout(function () {
        self._fireBoth(new AdEvent(AdEvent.Type.CONTENT_PAUSE_REQUESTED));
        setTimeout(function () {
          self._fireBoth(new AdEvent(AdEvent.Type.ALL_ADS_COMPLETED));
          self._fireBoth(new AdEvent(AdEvent.Type.CONTENT_RESUME_REQUESTED));
        }, 0);
      }, 0);
    };
    AdsManager.prototype.stop = noop;
    AdsManager.prototype.pause = noop;
    AdsManager.prototype.resume = noop;
    AdsManager.prototype.destroy = noop;
    AdsManager.prototype.resize = noop;
    AdsManager.prototype.focus = noop;
    AdsManager.prototype.skip = noop;
    AdsManager.prototype.collapse = noop;
    AdsManager.prototype.expand = noop;
    AdsManager.prototype.click = noop;
    AdsManager.prototype.setClickElement = noop;
    AdsManager.prototype.setVolume = function (v) { this._volume = v; };
    AdsManager.prototype.getVolume = function () { return this._volume; };
    AdsManager.prototype.getRemainingTime = function () { return 0; };
    AdsManager.prototype.getCuePoints = function () { return []; };
    AdsManager.prototype.getCurrentAd = function () { return null; };
    AdsManager.prototype.getAdSkippableState = function () { return false; };
    AdsManager.prototype.isCustomPlaybackUsed = function () { return false; };
    AdsManager.prototype.getAdSkippableState = function () { return false; };

    function AdsManagerLoadedEvent(manager, userRequestContext) {
      Event.call(this, "adsManagerLoaded");
      this._m = manager || null;
      this._u = userRequestContext || null;
    }
    AdsManagerLoadedEvent.prototype = Object.create(Event.prototype);
    AdsManagerLoadedEvent.prototype.constructor = AdsManagerLoadedEvent;
    AdsManagerLoadedEvent.prototype.getAdsManager = function () { return this._m; };
    AdsManagerLoadedEvent.prototype.getUserRequestContext = function () { return this._u; };
    AdsManagerLoadedEvent.Type = { ADS_MANAGER_LOADED: "adsManagerLoaded" };

    function AdsLoader(container) {
      Bus.call(this);
      this._container = container || null;
      this._requested = false;
    }
    AdsLoader.prototype = Object.create(Bus.prototype);
    AdsLoader.prototype.constructor = AdsLoader;
    AdsLoader.prototype.getSettings = function () { return globalSettings; };
    AdsLoader.prototype.contentComplete = function () {
      this._fire(new AdEvent(AdEvent.Type.ALL_ADS_COMPLETED));
    };
    AdsLoader.prototype.destroy = noop;
    AdsLoader.prototype.requestAds = function (request) {
      var self = this;
      if (self._requested) return;
      self._requested = true;
      setTimeout(function () {
        var handled = self._fire(new AdErrorEvent(new AdError(1005, "Ads are skipped inside the proxy", "vast")));
        if (handled) return;
        var wantsManager = self._count(AdsManagerLoadedEvent.Type.ADS_MANAGER_LOADED) > 0;
        var manager = new AdsManager(self);
        self._fire(new AdsManagerLoadedEvent(manager, request));
        if (wantsManager) {
          setTimeout(function () { manager.start(); }, 0);
        }
      }, 0);
    };

    var ImaSdkFactory = {
      getInstance: function () {
        return {
          createAdDisplayContainer: function (a, v, c) { return new AdDisplayContainer(a, v, c); },
          createAdsLoader: function (c) { return new AdsLoader(c); },
          createAdsRequest: function () { return new AdsRequest(); },
          createAdsRenderingSettings: function () { return new AdsRenderingSettings(); },
          createImaSdkSettings: function () { return new ImaSdkSettings(); }
        };
      }
    };

    var ima = {
      __pxImaStub: true,
      VERSION: "3.799.0",
      AdsLoader: AdsLoader,
      AdsRequest: AdsRequest,
      AdsManager: AdsManager,
      AdsManagerLoadedEvent: AdsManagerLoadedEvent,
      AdDisplayContainer: AdDisplayContainer,
      AdError: AdError,
      AdErrorEvent: AdErrorEvent,
      AdEvent: AdEvent,
      AdsRenderingSettings: AdsRenderingSettings,
      ImaSdkSettings: ImaSdkSettings,
      ImaSdkFactory: ImaSdkFactory,
      settings: globalSettings,
      ViewMode: { NORMAL: "normal", FULLSCREEN: "fullscreen" },
      UiElements: { AD_ATTRIBUTION: "adAttribution", COUNTDOWN: "countdown" },
      AdType: { LINEAR: "linear", NONLINEAR: "nonlinear", COMPANION: "companion" },
      OmidAccessMode: { LIMITED: "limited", DOMAIN: "domain", FULL: "full" },
      OmidVerificationVendor: { OTHER: 1, GOOGLE: 2, MOAT: 3 }
    };

    try {
      if (typeof Proxy === "function") {
        ima = new Proxy(ima, {
          get: function (t, p) {
            if (p in t) return t[p];
            if (typeof p !== "string") return undefined;
            if (p === "then" || p === "toJSON" || p === "inspect" || p === "constructor" || p === "prototype") return undefined;
            var stub = function () {
              return new Proxy({}, {
                get: function (o, q) {
                  if (q === "then") return undefined;
                  return function () { return undefined; };
                }
              });
            };
            try { t[p] = stub; } catch (_) {}
            return stub;
          }
        });
      }
    } catch (_) {}

    W.google = W.google || {};
    try {
      Object.defineProperty(W.google, "ima", { value: ima, writable: true, configurable: true, enumerable: true });
    } catch (_) {
      W.google.ima = ima;
    }
  } catch (_) {}
})();`;


// ====================================================
// 🗄 不変アセットのキャッシュ（Instagram / TikTok / YouTube の CDN 用）
// Instagram は1ページで20〜30本・十数MBのJS/CSSを読む。プロキシが毎回それを
// Meta のCDNへ取りに行くと、データセンターIPはすぐ 429 を食らって
// 「Bootloading module failed」＝無限スピナーになる。ハッシュ付きの不変URLだけを
// メモリに溜め、ブラウザ側にもキャッシュさせる。
// ====================================================
const assetCache = new Map();
const ASSET_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const ASSET_CACHE_MAX_BYTES = 48 * 1024 * 1024;
const ASSET_CACHE_MAX_ITEM = 8 * 1024 * 1024;
let assetCacheBytes = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isCacheableAsset(hostname, pathname) {
  const h = String(hostname || "").toLowerCase();
  const p = String(pathname || "");
  const staticHosts = [
    "cdninstagram.com", "fbcdn.net", "ttwstatic.com", "tiktokcdn.com", "tiktokcdn-us.com",
    "ibytedtos.com", "ibyteimg.com", "muscdn.com", "ytimg.com", "ggpht.com", "gstatic.com",
    "googleusercontent.com"
  ];
  if (staticHosts.some((d) => h === d || h.endsWith("." + d))) return true;
  // サイト本体のドメインでも、ハッシュ付きの /rsrc.php/ や YouTube のバンドルは不変
  if (p.startsWith("/rsrc.php/") || /\/_\/(?:js|ss)\//.test(p)) return true;
  // 🧩 プロキシ側で中身を書き換えるホスト（Poki / Fancade / TurboWarp）のJSは、
  // 書き換え結果を使い回す。毎回5MB級のバンドルを走査して構文検証し直すと、
  // TurboWarpの初回表示が2秒近く余計にかかってしまう。
  const rewriteHosts = ["poki.com", "poki-cdn.com", "fancade.com", "turbowarp.org", "trampoline.turbowarp.xyz"];
  return /\.js$/i.test(p) && rewriteHosts.some((d) => h === d || h.endsWith("." + d));
}

function assetCacheGet(key) {
  const hit = assetCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expire) {
    assetCache.delete(key);
    assetCacheBytes -= hit.buf.length;
    return null;
  }
  return hit;
}

function assetCacheSet(key, buf, contentType) {
  if (!key || !buf || !buf.length || buf.length > ASSET_CACHE_MAX_ITEM) return;
  const prev = assetCache.get(key);
  if (prev) {
    assetCacheBytes -= prev.buf.length;
    assetCache.delete(key);
  }
  while (assetCacheBytes + buf.length > ASSET_CACHE_MAX_BYTES && assetCache.size) {
    const oldest = assetCache.keys().next().value;
    const e = assetCache.get(oldest);
    if (!e) break;
    assetCacheBytes -= e.buf.length;
    assetCache.delete(oldest);
  }
  assetCache.set(key, { buf, ct: contentType, expire: Date.now() + ASSET_CACHE_TTL_MS });
  assetCacheBytes += buf.length;
}

// 🎬 YouTube のモジュールバンドルは `/_/js/`・`/_/ss/` の疑似パスでブラウザから来る。
// リダイレクトせず、その場で上流（= __px_origin Cookie のオリジン）へ中継する。
// YouTube のモジュールローダーは #base-js の src に `/_/js/` と `/k=` があるか検証し、
// 無いと Error("rc") を投げて起動を止める（＝「現在オフラインです」の正体）。
app.use((req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();
  if (!/\/_\/(?:js|ss)\//.test(req.path || "")) return next();
  const origin = proxyOriginFromRequest(req);
  if (!origin) return next();
  req.url = "/api/proxy?url=" + encodeURIComponent(origin + req.originalUrl) + "&_asset=1";
  next();
});

// 🧲 同じInstagramページを同時に開いたときの合流（1回だけ上流へ取りに行き、全員に配る）。
// 学校で何人もが同時に開くと、Renderの無料枠と Metaのレート制限の両方が一度に押される。
const proxyInflightDocs = new Map();
// ページキャッシュと一緒に預けるSet-Cookie（キャッシュを配る相手にも同じ無名の身元を見せる）
const igDocCookieCache = new Map();
function proxyDocWait(key) {
  const e = proxyInflightDocs.get(key);
  return e ? e.promise : null;
}
function proxyDocStart(key) {
  if (!key || proxyInflightDocs.has(key)) return () => {};
  let done;
  const promise = new Promise((r) => { done = r; });
  const entry = { promise };
  entry.done = () => {
    if (proxyInflightDocs.get(key) === entry) proxyInflightDocs.delete(key);
    done();
  };
  proxyInflightDocs.set(key, entry);
  const timer = setTimeout(entry.done, 15000);
  if (timer.unref) timer.unref();
  return entry.done;
}

// 🍪 上流Cookieのジャー（Instagram用）。プロキシはブラウザのCookieを上流へ送らないため、
// Instagramの ajax が csrftoken/mid/ig_did を持たないリクエストになり、ログインや
// モジュール取得が 404/429 で落ちていた。利用者ごと（__px_sid）に上流Cookieを預かる。
const upstreamCookieJar = new Map(); // sid -> Map(host -> Map(name -> value))
const PJAR_MAX_SESSIONS = 300;
const PJAR_MAX_COOKIES = 40;
function pjarSid(req, res) {
  let sid = "";
  try {
    const m = /(?:^|;\s*)__px_sid=([A-Za-z0-9]{8,40})/.exec(String(req.headers.cookie || ""));
    if (m) sid = m[1];
  } catch (_) {}
  if (!sid) {
    sid = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
    try { res.append("Set-Cookie", `__px_sid=${sid}; Path=/; Max-Age=604800; SameSite=Lax`); } catch (_) {}
  }
  return sid;
}
function pjarGet(sid, host) {
  const hosts = upstreamCookieJar.get(sid);
  const jar = hosts && hosts.get(host);
  if (!jar || !jar.size) return "";
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}
function pjarStore(sid, host, setCookies) {
  if (!setCookies || !setCookies.length) return;
  let hosts = upstreamCookieJar.get(sid);
  if (!hosts) {
    if (upstreamCookieJar.size >= PJAR_MAX_SESSIONS) upstreamCookieJar.delete(upstreamCookieJar.keys().next().value);
    hosts = new Map();
    upstreamCookieJar.set(sid, hosts);
  }
  let jar = hosts.get(host);
  if (!jar) { jar = new Map(); hosts.set(host, jar); }
  for (const raw of setCookies) {
    const pair = String(raw).split(";")[0];
    const idx = pair.indexOf("=");
    if (idx <= 0) continue;
    const name = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    if (!name) continue;
    if (/^(?:max-age=0|expires=thu, 01 jan 1970)/i.test(value)) { jar.delete(name); continue; }
    jar.set(name, value);
  }
  while (jar.size > PJAR_MAX_COOKIES) jar.delete(jar.keys().next().value);
}
function pjarSetCookies(response) {
  try {
    if (typeof response.headers.getSetCookie === "function") return response.headers.getSetCookie();
    const single = response.headers.get("set-cookie");
    return single ? [single] : [];
  } catch (_) {
    return [];
  }
}

app.all("/api/proxy", async (req, res) => {
  let targetUrl = req.query.url;
  if (!targetUrl && req.headers.referer) {
    try {
      const refUrl = new URL(req.headers.referer);
      const prevTarget = refUrl.searchParams.get("url");
      if (prevTarget) {
        const u = new URL(req.url, prevTarget);
        targetUrl = u.href;
      }
    } catch (_) {}
  }

  if (!targetUrl) {
    return res.status(400).send(renderProxyError("URLが指定されていません", "アドレスバーまたは検索欄にURLまたは検索キーワードを入力してください。"));
  }

  targetUrl = String(targetUrl).trim();
  if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
    targetUrl = "https://" + targetUrl;
  }

  // 🔧 URL二重化（プロキシURLの入れ子）を剥がす。
  // Instagram/TikTok等のSPAは自分のURLを基準にリンクや履歴を書き換えるため、
  // /api/proxy?url=https://mokori.onrender.com/api/proxy?url=https%3A... と入れ子になり
  // 以降の相対リンクがすべて壊れる（「リンクが破損しているか…」「ページを読み込めませんでした」の正体）。
  {
    const selfHost = String(req.get("host") || "").toLowerCase().split(":")[0];
    for (let guard = 0; guard < 6; guard++) {
      let inner = null;
      try {
        const probe = new URL(targetUrl);
        const probeHost = probe.hostname.toLowerCase();
        const isSelfHost = probeHost === selfHost || probeHost === "localhost" || probeHost === "127.0.0.1";
        if (isSelfHost && (probe.pathname === "/api/proxy" || probe.pathname === "/api/proxy/")) {
          inner = probe.searchParams.get("url");
        }
      } catch (_) {}
      if (!inner) break;
      targetUrl = inner;
      if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
        targetUrl = "https://" + targetUrl;
      }
    }
  }

  // Poki: 言語プレフィックスの無いパス（poki.com/g/drive-mad など）は上流が404を返す。
  // トップのゲームへの直リンクや検索欄からの入力でもゲームが開くよう、既定の /jp を補う。
  try {
    const pk = new URL(targetUrl);
    // 対象は poki.com 本体だけ。games.poki.com の /<site_id>/<game_id> に /jp を挿すと
    // 上流が 400 {"error":"Invalid Game"} を返す（ゲームが一切起動しない原因になる）。
    if (pk.hostname === "poki.com" || pk.hostname === "www.poki.com") {
      const LOCALES = new Set(["en", "jp", "ja", "de", "fr", "es", "pt", "pt-br", "it", "nl", "pl", "ru", "tr", "ar", "hi", "id", "th", "vi", "ko", "zh", "zh-cn", "zh-tw", "sv", "da", "no", "fi", "cs", "ro", "hu", "el", "he", "uk", "ms"]);
      const seg = String(pk.pathname.split("/")[1] || "").toLowerCase();
      if (!LOCALES.has(seg)) {
        pk.pathname = "/jp" + (pk.pathname.startsWith("/") ? pk.pathname : "/" + pk.pathname);
        targetUrl = pk.href;
      }
    }
  } catch (_) {}

  // 🧩 TurboWarp: プロジェクト以外のページ（トップなど）を iframe 内で開くと、
  // TurboWarp側が frame 内からの読み込みを拒否して「Invalid TurboWarp Embed :(
  // See docs.turbowarp.org/embedding for more information.」になる。
  // iframe から来たときは必ず /embed に寄せ、/embed を作れないページは
  // 自ドメインの案内ページを返して行き止まりにしない。
  {
    let tw = null;
    try { tw = new URL(targetUrl); } catch (_) {}
    if (tw && /^(?:www\.)?turbowarp\.org$/i.test(tw.hostname)) {
      const dest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
      const framed = dest === "iframe" || dest === "frame" || String(req.query._frame || "") === "1";
      const segs = tw.pathname.split("/").filter(Boolean);
      const projectId = /^\d{4,}$/.test(segs[0] || "") ? segs[0] : "";
      const isEmbed = (segs[1] || "").toLowerCase() === "embed";
      if (framed && !isEmbed && String(req.query._tw || "") !== "1") {
        if (projectId) {
          const embedUrl = `https://turbowarp.org/${projectId}/embed${tw.search || "?autoplay=true"}`;
          return res.redirect(`/api/proxy?url=${encodeURIComponent(embedUrl)}&_tw=1`);
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache");
        return res.send(`<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>TurboWarp</title><style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1220;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,"Hiragino Kaku Gothic ProN",sans-serif;padding:24px;text-align:center}.card{max-width:420px;background:#111a2e;border:1px solid #24334d;border-radius:16px;padding:22px}a.btn{display:inline-block;margin-top:14px;background:#0284c7;color:#fff;text-decoration:none;border-radius:10px;padding:11px 18px;font-weight:700}input{width:100%;box-sizing:border-box;margin-top:14px;background:#0b1220;border:1px solid #2d3d59;border-radius:10px;padding:11px 12px;color:#fff;font-size:14px}p{font-size:13px;color:#94a3b8;line-height:1.7}</style></head><body><div class="card"><div style="font-size:34px">🧩</div><h2 style="font-size:17px;margin:8px 0">TurboWarp</h2><p>TurboWarpのトップページはアプリ内（iframe）では開けません。<br>新しいタブで開くか、下にプロジェクトIDかURLを入れてください。</p><a class="btn" href="/api/proxy?url=${encodeURIComponent("https://turbowarp.org")}&_tw=1" target="_blank" rel="noopener">🌐 新しいタブで開く</a><input id="twp" placeholder="プロジェクトID 例: 544538470" /><a class="btn" href="#" onclick="var v=(document.getElementById('twp').value||'').trim();if(!v)return false;var m=v.match(/([0-9]{4,})/);if(!m)return false;location.href='/api/proxy?url='+encodeURIComponent('https://turbowarp.org/'+m[1]+'/embed?autoplay=true')+'&_tw=1';return false;">▶ プロジェクトを開く</a></div></body></html>`);
      }
    }
  }

  // Emscripten/WASM等の相対URLが /api/index.wasm に解決された場合の救済。
  // ⚠ これは「ページと同じホストの /api/… が相対解決で迷子になった」ときの救済なので、
  // 別ホストの本物のAPIパス（turbowarp.org のページ → trampoline.turbowarp.org/api/projects/…）
  // には絶対に適用しない。以前はここでターボワープのプロジェクト取得まで書き換えてしまい、
  // JSONの代わりにHTMLが返って「This project is unshared.」になっていた。
  if (targetUrl.includes("/api/") && !targetUrl.includes("proxy?url=")) {
    const assetPart = targetUrl.split("/api/").pop();
    const referer = req.headers.referer || "";
    if (referer.includes("proxy?url=")) {
      try {
        const parentTarget = decodeURIComponent(referer.split("proxy?url=")[1].split("&")[0]);
        const parentHost = new URL(parentTarget).hostname.toLowerCase();
        const targetHost = new URL(targetUrl).hostname.toLowerCase();
        if (parentHost === targetHost) {
          const parentDir = parentTarget.substring(0, parentTarget.lastIndexOf("/") + 1);
          const candidates = [
            parentDir + "webapp/" + assetPart,
            parentDir + assetPart
          ];
          for (const cand of candidates) {
            try {
              const probe = await fetch(cand, { method: "HEAD", headers: { "User-Agent": "Mozilla/5.0" }, redirect: "manual" });
              if (probe.ok) {
                targetUrl = cand;
                break;
              }
            } catch (_) {}
          }
        }
      } catch (_) {}
    }
  }

  let parsedTarget;
  try {
    parsedTarget = new URL(targetUrl);
  } catch (_) {
    return res.status(400).send(renderProxyError("無効なURL形式です", "正しいURL（例: poki.com または https://duckduckgo.com）を入力してください。"));
  }

  if (isBlockedHost(parsedTarget.hostname)) {
    return res.status(403).send(renderProxyError("アクセス制限", "安全保護のため、内部ネットワークやプライベートIPへの接続はブロックされています。"));
  }

  // 🎬 Google IMA（動画広告SDK）は、本物を中継しても「googleドメインから読み込まれていない」
  // と判定されて必ず例外になる（＝Pokiの ⚠ 1件）。ここでAPI互換スタブに差し替え、
  // 広告SDKの失敗でゲームの広告ブレークが止まらないようにする。
  if (/(^|\.)imasdk\.googleapis\.com$/i.test(parsedTarget.hostname) || /\/sdkloader\/ima3[^/]*\.js$/i.test(parsedTarget.pathname)) {
    res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    res.setHeader("Cache-Control", "public, max-age=1800");
    res.setHeader("Access-Control-Allow-Origin", "*");
    return res.send(IMA_STUB_JS);
  }

  // Instagramのリール/投稿ページ、TikTokの動画ページは、公式サイトが見せないので、もこり内ビューアで再生させる
  // （プロキシ内SPAの再読み込み _spa=1 は、そのままSPAで開き直す）
  if (req.method === "GET" && String(req.query._spa || "") !== "1" && (req.headers.accept || "").includes("text/html")) {
    const hostForRedirect = parsedTarget.hostname.toLowerCase();
    const pathForRedirect = parsedTarget.pathname;
    if (!pathForRedirect.includes("/embed/")) {
      if (hostForRedirect.includes("instagram.com") && /^\/(reel|reels|p|tv)\/[A-Za-z0-9_-]{5,}/i.test(pathForRedirect)) {
        return res.redirect(`/instagram/?url=${encodeURIComponent(targetUrl)}`);
      }
      if (hostForRedirect.includes("tiktok.com") && /^\/@[^/]+\/video\/\d+/i.test(pathForRedirect)) {
        return res.redirect(`/tiktok/?url=${encodeURIComponent(targetUrl)}`);
      }
    }
  }

  let docDone = () => {};
  try {
    const origin = parsedTarget.origin;
    const hostLower = parsedTarget.hostname.toLowerCase();
    const isTiktok = hostLower.includes("tiktok.com");
    const isInstagram = hostLower.includes("instagram.com");
    const isYouTubeHost = /(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/i.test(hostLower);

    // Instagramの文書（トップ・探索・リール・人気ページ等）はサーバー側でキャッシュする。
    // MetaはデータセンターIPに 429 を返すことがあり、その1回で画面が無限スピナーになる。
    // 一度取れたページはそのまま返し、上流が失敗したときは期限切れのコピーでも返す。
    const wantsHtmlDoc = req.method === "GET" && String(req.headers.accept || "").includes("text/html");
    // Instagramには利用者ごとの上流Cookieを預かる（無ければ発行）
    const pjarSidValue = isInstagram ? pjarSid(req, res) : "";
    const igPopular = parsedTarget.pathname.startsWith("/popular/");
    // ログイン・登録・DMなどトークン（lsd/csrftoken）を伴う画面はキャッシュしない。
    // 古いトークンのHTMLを返すと、その後のPOSTがCSRFエラーになるため。
    const igCacheableDoc = wantsHtmlDoc && isInstagram && !/^\/(?:accounts|direct|api|graphql)\b/i.test(parsedTarget.pathname);
    const pageCacheKey = igCacheableDoc
      ? (igPopular ? "ig-page:" + targetUrl : "ig-doc:" + targetUrl)
      : null;
    const pageCacheTtl = igPopular ? 5 * 60 * 1000 : 90 * 1000;
    if (pageCacheKey) {
      const hit = socialCacheGet(pageCacheKey);
      if (hit) {
        // キャッシュに預けてあるSet-Cookieを、この利用者のジャーとブラウザにも渡す
        const savedCookies = igDocCookieCache.get(pageCacheKey);
        if (savedCookies && savedCookies.length && pjarSidValue) {
          pjarStore(pjarSidValue, hostLower, savedCookies);
          for (const raw of savedCookies) {
            const rewritten = String(raw).replace(/domain=[^;]+;?/gi, "").replace(/samesite=[^;]+;?/gi, "SameSite=None; Secure;");
            res.append("Set-Cookie", rewritten);
          }
        }
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("X-Tensai-Cache", "PAGE");
        return res.send(hit);
      }
      // 同じページを取的っている最中なら、その結果を待って共有する
      const pending = proxyDocWait(pageCacheKey);
      if (pending) {
        try { await Promise.race([pending, sleep(9000)]); } catch (_) {}
        const shared = socialCacheGet(pageCacheKey);
        if (shared) {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          res.setHeader("X-Tensai-Cache", "PAGE");
          return res.send(shared);
        }
      }
    }
    docDone = proxyDocStart(pageCacheKey);

    let virtualReferer = origin + "/";
    try {
      const browserReferer = new URL(req.headers.referer || "");
      const virtualPageUrl = browserReferer.searchParams.get("url");
      if (virtualPageUrl) {
        const parsedVirtualPage = new URL(virtualPageUrl);
        if (parsedVirtualPage.protocol === "http:" || parsedVirtualPage.protocol === "https:") {
          virtualReferer = parsedVirtualPage.href;
        }
      }
    } catch (_) {}

    let requestOrigin = origin;
    if (parsedTarget.hostname.endsWith("poki.com") || parsedTarget.hostname.endsWith("poki-cdn.com")) {
      virtualReferer = "https://poki.com/";
      requestOrigin = "https://poki.com";
    } else if (isTiktok) {
      virtualReferer = "https://www.tiktok.com/";
      requestOrigin = "https://www.tiktok.com";
    } else if (isInstagram) {
      virtualReferer = "https://www.instagram.com/";
      requestOrigin = "https://www.instagram.com";
    }

    const clientUA = req.headers["user-agent"] || UA_DESKTOP_CHROME;
    const defaultUA = pickUAForHost(parsedTarget.hostname, clientUA);

    const headers = {
      "User-Agent": defaultUA,
      "Accept": req.headers["accept"] || "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      "Accept-Language": req.headers["accept-language"] || "ja,en-US;q=0.9,en;q=0.8",
      "Referer": virtualReferer
    };

    // ⚠ Origin は CORS/プリフライト・POST のときだけ付くヘッダー。GET の静的アセットに
    // まで付けて送ると Meta 側に API 呼び出しと判定され、データセンターIPへの 429 を
    // 誘発しやすかった（Instagram の Bootloading module failed の一因）。
    // ブラウザが Origin を送ってきたときだけ、上流のオリジンに置き換えて付ける。
    if (req.headers.origin) {
      try {
        headers["Origin"] = new URL(virtualReferer).origin;
      } catch (_) {}
    }
    for (const name of ["authorization", "content-type", "if-match", "if-none-match", "if-range", "if-modified-since", "if-unmodified-since", "x-requested-with", "x-api-key"]) {
      if (req.headers[name]) headers[name] = req.headers[name];
    }
    // 各サイト独自の X-* ヘッダーは中継する。Instagram は x-ig-app-id / x-csrftoken、
    // YouTube は x-youtube-client-name などが無いと API（bootloader・InnerTube）が
    // エラーや 429 になる。ホップバイホップの転送ヘッダーだけ除外する。
    for (const name of Object.keys(req.headers)) {
      if (!name.startsWith("x-")) continue;
      if (/^x-forwarded|x-real-ip|x-request-start|x-timer/i.test(name)) continue;
      if (headers[name] === undefined) headers[name] = req.headers[name];
    }
    if (isYouTubeHost) {
      for (const name of ["sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest"]) {
        if (req.headers[name]) headers[name] = req.headers[name];
      }
    }
    if (req.headers["range"]) {
      headers["Range"] = req.headers["range"];
    }
    // Instagramには預かっている上流Cookie（csrftoken/mid/ig_did等）を付けて送る
    if (isInstagram) {
      const cookieHeader = pjarGet(pjarSidValue, hostLower);
      if (cookieHeader) headers["Cookie"] = cookieHeader;
    }

    const fetchOpts = {
      method: req.method,
      headers,
      redirect: "follow"
    };

    if (req.method !== "GET" && req.method !== "HEAD") {
      if (Buffer.isBuffer(req.rawBody) && req.rawBody.length) {
        // 受信した生のボディをそのまま中継する（Instagram/TikTokのPOSTは再エンコードで壊れる）
        fetchOpts.body = req.rawBody;
      } else if (typeof req.body === "string" || Buffer.isBuffer(req.body)) {
        fetchOpts.body = req.body;
      } else if (req.body && typeof req.body === "object") {
        if ((req.headers["content-type"] || "").includes("application/x-www-form-urlencoded")) {
          fetchOpts.body = new URLSearchParams(req.body).toString();
        } else {
          fetchOpts.body = JSON.stringify(req.body);
          if (!headers["content-type"]) headers["Content-Type"] = "application/json";
        }
      }
    }

    // タイムアウトは「文書」だけ短く切る。JSバンドル（YouTubeのbase.jsは約10MB）まで
    // 14秒で切ると、遅いときに 502 になり画面が白くなる。
    const wantsDocument = String(headers["Accept"] || "").includes("text/html");
    const upstreamTimeout = wantsDocument ? 14000 : 45000;

    // 不変アセットはキャッシュから返す（Ctrl+再読み込み等の明示的な再取得のときだけ取り直す）
    const cacheableAsset = req.method === "GET" && !req.headers.range && isCacheableAsset(hostLower, parsedTarget.pathname);
    const assetKey = cacheableAsset ? "asset:" + targetUrl : null;
    const forceReload = /(^|,)\s*(no-cache|no-store)\b/i.test(String(req.headers["cache-control"] || ""));
    if (assetKey && !forceReload) {
      const hit = assetCacheGet(assetKey);
      if (hit) {
        res.status(200);
        res.setHeader("Content-Type", hit.ct || "application/octet-stream");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Cache-Control", "public, max-age=1800");
        res.setHeader("X-Tensai-Cache", "HIT");
        res.setHeader("X-Tensai-Upstream", "CACHE");
        return res.end(hit.buf);
      }
    }

    let response = await fetchUpstream(targetUrl, headers, fetchOpts, {
      allowUAChange: !isInstagram,
      timeoutMs: upstreamTimeout,
      // InstagramはデータセンターIPの接続を時々切る。一度だけやり直して、
      // その1回でページ全体が502（＝スピナー）になるのを防ぐ。
      retries: isInstagram ? 1 : 0
    });
    // 429 はデータセンターIPへのレート制限。GET なら少し待ってやり直す
    // （Instagram の Bootloading module failed／無限スピナーの直接原因）。
    // InstagramはUAを変えると余計に警戒されるので、同じiOS SafariのUAのまま
    // 時間をおいて2回まで引き直す。
    if (response.status === 429 && req.method === "GET") {
      const retryWaits = isInstagram ? [700, 2000] : [600];
      for (const wait of retryWaits) {
        await sleep(wait);
        try {
          const retryUA = isInstagram
            ? UA_IOS_SAFARI
            : (defaultUA === UA_DESKTOP_CHROME ? UA_IOS_SAFARI : UA_DESKTOP_CHROME);
          const retryHeaders = { ...headers, "User-Agent": retryUA };
          response = await fetchUpstream(targetUrl, retryHeaders, fetchOpts, {
            allowUAChange: false,
            timeoutMs: upstreamTimeout
          });
          if (response.status !== 429) break;
        } catch (_) {}
      }
    }
    const contentType = response.headers.get("content-type") || "";
    // 上流（Instagram）が実際に返したステータスを外から見えるようにする
    res.setHeader("X-Tensai-Upstream", String(response.status));
    // 上流が発行したCookieを預かる（次のajax・ログインで同じ上流に見せるため）
    if (pjarSidValue) {
      try { pjarStore(pjarSidValue, hostLower, pjarSetCookies(response)); } catch (_) {}
    }

    // 上流が 429/5xx を返しても、一度取れているページがあればそれを返す
    // （無限スピナー・「リンクが破損しています」を出さないための最後の砦）
    if (pageCacheKey && response.status >= 400) {
      const staleDoc = socialCacheGetAny(pageCacheKey);
      if (staleDoc) {
        docDone();
        res.status(200);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("X-Tensai-Stale", "1");
        return res.send(staleDoc);
      }
    }

    // Instagramのモジュール取得（bootloader-endpoint）は、一度でも 200 が取れたら
    // そのJSONをキャッシュし、429/404 のときはキャッシュを返して無限スピナーを止める。
    const isIgBootloader = req.method === "GET" && isInstagram && /\/ajax\/bootloader-endpoint\/?$/i.test(parsedTarget.pathname);
    const bootCacheKey = isIgBootloader ? "ig-boot:" + targetUrl : null;
    if (bootCacheKey && response.status !== 200) {
      const staleBoot = socialCacheGetAny(bootCacheKey);
      if (staleBoot) {
        res.status(200);
        res.setHeader("Content-Type", "application/javascript; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("X-Tensai-Stale", "1");
        return res.send(staleBoot);
      }
    }
    if (bootCacheKey && response.status === 200) {
      const bootBody = await response.text();
      socialCacheSet(bootCacheKey, bootBody, 20 * 60 * 1000);
      res.setHeader("Content-Type", response.headers.get("content-type") || "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      return res.send(bootBody);
    }

    // Instagramが回線制限（429）を返したときは、壊れたページではなく案内を出す
    if (response.status === 429 && isInstagram && (req.headers.accept || "").includes("text/html")) {
      const igLink = (p) => `/api/proxy?url=${encodeURIComponent("https://www.instagram.com" + p)}`;
      return res.status(429).send(renderProxyError(
        "Instagramがこのページだけアクセスを制限しています",
        "Instagram側の回線制限（429）で、ログイン・DM・設定のようなログインが必要なページはいま開けません。見るだけのページ（トップ・リール・探索・新規登録）は開けます。<br>数十秒おいてから「もう一度読み込む」を押すと通ることがあります。",
        `/api/proxy?url=${encodeURIComponent(targetUrl)}`,
        {
          links: [
            { href: igLink("/reels/"), label: "🎬 リールを見る" },
            { href: igLink("/explore/"), label: "🔎 探索する" },
            { href: igLink("/accounts/emailsignup/"), label: "📝 新規登録" }
          ],
          note: "Instagram公式アプリでログイン済みなら、このプロキシからも見られるページが増えます。"
        }
      ));
    }

    res.status(response.status);
    res.setHeader("X-Tensai-Proxy", "v2026-11-15d");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");

    // Iframe busting 解除
    res.removeHeader("X-Frame-Options");
    res.removeHeader("Content-Security-Policy");
    res.removeHeader("Cross-Origin-Opener-Policy");
    res.removeHeader("Cross-Origin-Embedder-Policy");
    // 上流の Referrer-Policy（poki の strict-origin 等）を中継すると、プロキシ内の
    // 相対アセット要求がオリジンだけのRefererになり、/api/index.wasm（Pokiゲームの
    // wasm）の救済が効かずゲームがロードで止まる。同一オリジンには完全URLを送る既定に戻す。
    res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");

    for (const [key, val] of response.headers.entries()) {
      const lower = key.toLowerCase();
      if (!["content-security-policy", "x-frame-options", "cross-origin-opener-policy", "cross-origin-embedder-policy", "content-encoding", "transfer-encoding", "content-length", "connection", "referrer-policy", "permissions-policy"].includes(lower)) {
        if (lower === "set-cookie") {
          const rewritten = val.replace(/domain=[^;]+;?/gi, "").replace(/samesite=[^;]+;?/gi, "SameSite=None; Secure;");
          res.append("Set-Cookie", rewritten);
        } else {
          res.setHeader(key, val);
        }
      }
    }

    if (contentType.includes("text/html")) {
      let html = await response.text();
      const proxyBase = "/api/proxy?url=";
      const baseUrl = response.url || targetUrl;
      const isYouTubeSite = /(^|\.)youtube\.com$|(^|\.)youtu\.be$|(^|\.)youtube-nocookie\.com$/i.test(parsedTarget.hostname);

      // 既存の <base> タグと integrity 属性を除去（プロキシURL誤解決とSRI拒否の根絶）
      html = html.replace(/<base\b[^>]*>/gi, "");
      html = html.replace(/\bintegrity=["'][^"']*["']/gi, "");

      // Poki等のBot判定ヘッダー・変数を安全に解除
      html = html.replace(/window\.pokiBotScore\s*=\s*\d+;/gi, "window.pokiBotScore = 0;");
      html = html.replace(/window\.pokiBotVerified\s*=\s*false;/gi, "window.pokiBotVerified = true;");
      html = html.replace(/window\.pokiCrawlerBlock\s*=\s*["'][^"']*["'];/gi, 'window.pokiCrawlerBlock = "";');
      html = html.replace(/function T\(e\)\{void 0===window\.pokiBotDetected&&\(window\.pokiBotDetected=e\)\}/gi, "function T(e){window.pokiBotDetected=false;}");
      html = html.replace(/window\.pokiBotDetectedPromise\s*=\s*Promise\.race\(\[[^\]]+\]\);/gs, "window.pokiBotDetectedPromise=Promise.resolve([]);window.pokiBotDetected=false;");

      const selfHostName = String(req.get("host") || "").toLowerCase().split(":")[0];

      function resolveUrl(rel) {
        if (!rel || rel.startsWith("data:") || rel.startsWith("javascript:") || rel.startsWith("#") || rel.startsWith("blob:")) {
          return rel;
        }
        try {
          const absUrl = new URL(rel, baseUrl);
          // すでにプロキシURL（自ドメインの /api/proxy）なら再ラップしない＝入れ子の根本防止
          if (absUrl.hostname.toLowerCase() === selfHostName && (absUrl.pathname === "/api/proxy" || absUrl.pathname === "/api/proxy/")) {
            return rel;
          }
          // 自ドメイン（もこり本体のページ）への絶対リンクはそのまま（/tube/ 等への誤中継を防ぐ）
          if (absUrl.hostname.toLowerCase() === selfHostName) {
            return absUrl.pathname + absUrl.search + absUrl.hash;
          }
          // 💡 YouTube は「本物のパス」をそのまま配る（中継はサーバー側の
          // __px_origin Cookie 救済がやる）。location.pathname や a.href が本物の
          // YouTube のままでないと、SPA のルーターやモジュールローダーが壊れる
          // （Error("rc") → (0,_.xi) is not a function →「現在オフラインです」）。
          if (isYouTubeSite && /(^|\.)youtube\.com$/i.test(absUrl.hostname)) {
            return absUrl.pathname + absUrl.search + absUrl.hash;
          }
          // 💡 YouTube のJS/CSSバンドルだけは「ルート相対の疑似パス」で配る。
          // モジュールローダーが #base-js の src に `/_/js/` と `/k=` が含まれるか検証し、
          // 無いと Error("rc") を投げて起動を止める（その後モジュールが全部 null になり
          // `(0,_.xi) is not a function` →「現在オフラインです」になる）。
          // パスを保ったまま配れば検証を通り、読み込みは `/_/js/` 用の中継ルートが受ける。
          if (isYouTubeSite && /\/_\/(?:js|ss)\//.test(absUrl.pathname)) {
            return absUrl.pathname + absUrl.search;
          }
          if (absUrl.pathname.endsWith(".js") && !absUrl.searchParams.has("_v")) {
            absUrl.searchParams.set("_v", "101");
          }
          return proxyBase + encodeURIComponent(absUrl.href);
        } catch (_) {
          return rel;
        }
      }

      function resolveSrcset(val) {
        if (!val) return val;
        return val.replace(/(\S+)(?:\s+([\d\.]+[wx]))?(?:,\s*|$)/g, (match, u, desc) => {
          if (!u) return match;
          const proxied = resolveUrl(u);
          const suffix = match.trim().endsWith(",") ? ", " : "";
          return proxied + (desc ? ` ${desc}` : "") + suffix;
        });
      }

      html = html.replace(/\b(href|src|action|data-src|poster|data-url)=["']([^"']+)["']/gi, (match, attr, val) => {
        return `${attr}="${resolveUrl(val)}"`;
      });
      html = html.replace(/\b(srcset|data-srcset)=["']([^"']+)["']/gi, (match, attr, val) => {
        return `${attr}="${resolveSrcset(val)}"`;
      });
      html = html.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (match, val) => {
        return `url("${resolveUrl(val)}")`;
      });

      // Instagramのリール・投稿リンク、TikTokの動画リンクは、もこり内ビューアへ直結させる
      // （公式サイト側はログイン壁を出して再生できないため）
      if (isInstagram || isTiktok) {
        html = html.replace(/href="\/api\/proxy\?url=([^"]+)"/g, (match, enc) => {
          let tv;
          try {
            tv = decodeURIComponent(enc);
          } catch (_) {
            return match;
          }
          if (isInstagram && /^https?:\/\/[^/]*instagram\.com\/(reel|reels|p|tv)\//i.test(tv)) {
            return `data-proxy-viewer="1" href="/instagram/?url=${encodeURIComponent(tv)}"`;
          }
          if (isTiktok && /^https?:\/\/[^/]*tiktok\.com\/@[^/]+\/video\/\d+/i.test(tv)) {
            return `data-proxy-viewer="1" href="/tiktok/?url=${encodeURIComponent(tv)}"`;
          }
          return match;
        });
      }

      // PokiのgameUri（games.poki.comのPARAMS）をプロキシURLに直接書き換え
      html = html.replace(/"gameUri"\s*:\s*"([^"]+)"/g, (match, val) => {
        return `"gameUri":"${resolveUrl(val)}&_ts=${Date.now()}"`;
      });
      html = html.replace(/'gameUri'\s*:\s*'([^']+)'/g, (match, val) => {
        return `'gameUri':'${resolveUrl(val)}&_ts=${Date.now()}'`;
      });

      const isPokiSite = /(^|\.)poki\.com$|poki-cdn\.com$|turbowarp\.org$|fancade\.com$/i.test(parsedTarget.hostname);
      // 🎬 ページのスクリプトより先に広告SDKの互換スタブを読みませる（同期スクリプトなので
      // 後続のゲームコードが google.ima を触る時点では必ず存在する）。本物を読みに行っても
      // 同じスタブが返るので二重にはならない。
      const imaPreseed = isPokiSite
        ? `<script src="/api/proxy?url=${encodeURIComponent("https://imasdk.googleapis.com/js/sdkloader/ima3.js")}"></script>`
        : "";
      const interceptScript = `
<script>
(function() {
  var baseUrl = ${JSON.stringify(baseUrl)};
  var baseObj;
  try {
    baseObj = new URL(baseUrl);
  } catch(_) {
    baseObj = { pathname: '/', search: '', hash: '', href: baseUrl, origin: '' };
  }

  window.__proxy_pathname = baseObj.pathname || '/';
  window.__proxy_search = baseObj.search || '';
  window.__proxy_hash = baseObj.hash || '';
  window.__proxy_href = baseObj.href || baseUrl;

  var IS_POKI = ${isPokiSite};

  // 🎬 YouTube はモジュールローダーの検証（#base-js の src に /_/js/ と /k=）と
  // location 基準のAPI呼び出しがあるので、専用の扱いをする
  var IS_YOUTUBE = /(^|\\.)youtube\\.com$|(^|\\.)youtu\\.be$/i.test(baseObj.hostname || '');

  // 📸 Instagramの「アプリでこのリール動画を見る」全画面ナグを自動で閉じる
  // （動画の上に被さって「見れない」ように感じる最大の原因。閉じるだけなので副作用なし）
  var PX_IS_IG = (function () {
    var h = (baseObj.hostname || '').toLowerCase();
    return h === 'instagram.com' || h.slice(-14) === '.instagram.com';
  })();
  if (PX_IS_IG) {
    (function () {
      var closed = 0;
      var timer = setInterval(function () {
        if (closed >= 8) { clearInterval(timer); return; }
        var dialogs = document.querySelectorAll('[role="dialog"]');
        var upsell = null;
        for (var i = 0; i < dialogs.length; i++) {
          var txt = dialogs[i].innerText || '';
          if (txt.indexOf('アプリでこのリール') >= 0 || txt.indexOf('アプリを利用すると') >= 0) { upsell = dialogs[i]; break; }
        }
        if (!upsell) return;
        // 閉じるボタンはダイアログの外側にあることが多いので、ラベルが完全一致するものだけを押す
        // （「Instagramを開く」「登録する」等は絶対に押さない）
        var cand = document.querySelectorAll('[aria-label="閉じる"],[aria-label="Close"],img[alt="閉じる"],img[alt="Close"]');
        for (var k = 0; k < cand.length; k++) {
          var el = cand[k];
          try {
            if (el.closest('[role="dialog"]')) continue;
            var target = el;
            if (el.tagName === 'IMG' || el.tagName === 'svg' || el.tagName === 'svg' || el.tagName === 'SPAN' || el.tagName === 'DIV') {
              target = el.closest('button,[role="button"]') || null;
            }
            if (!target) continue;
            if (target.tagName === 'A' || target.closest('a[href]')) continue;
            if (!target.getClientRects || target.getClientRects().length === 0) continue;
            target.click();
            closed++;
            return;
          } catch (_) {}
        }
      }, 800);
      setTimeout(function () { clearInterval(timer); }, 25000);
    })();
  }

  // 🧭 SPAのルーター対策: TikTokは location.pathname が既知のルートでないと
  // 自前の /404 へ飛ばしてしまう。プロキシのURLは常に /api/proxy なので、
  // 表示上のパスだけを「本物のサイトのパス」に合わせる（history.replaceState は
  // 通信を起こさないので安全。再読み込みは __px_origin Cookie 側で救済される）。
  var IS_TIKTOK = /(^|\.)tiktok\.com$/i.test(baseObj.hostname || '');
  // 「見た目のパス」を作る: 上流のパスをそのままアドレスバーに出す。
  // ホーム（/）だけは、再読み込みで mokori のトップに落ちないよう __px=1 を付ける。
  function pxVisualPath(pathname, search, hash) {
    var p = pathname || '/';
    var s = search || '';
    if (p === '/' && s.indexOf('__px=') < 0) s = (s ? s + '&' : '?') + '__px=1';
    return p + s + (hash || '');
  }
  window.__pxVisualPath = pxVisualPath;
  if (IS_TIKTOK || IS_YOUTUBE) {
    try {
      var upPath = baseObj.pathname || '/';
      if (IS_TIKTOK && (!upPath || upPath === '/')) upPath = '/foryou';
      if (upPath.indexOf('/api/') !== 0) {
        window.__pxFakePath = true;
        history.replaceState(history.state, '', pxVisualPath(upPath, baseObj.search, baseObj.hash));
      }
    } catch (_) {}
  }

  // 🚦 リロードループ検知（同じURLを短時間に何度も読み直したら止める）
  (function () {
    try {
      var key = '__pxloop:' + baseUrl;
      var rec = {};
      try { rec = JSON.parse(sessionStorage.getItem(key) || '{}') || {}; } catch (_) { rec = {}; }
      var now = Date.now();
      if (!rec.t || rec.n === undefined || (now - rec.t) > 10000) { rec = { n: 1, t: now }; }
      else { rec.n = rec.n + 1; rec.t = now; }
      sessionStorage.setItem(key, JSON.stringify(rec));
      window.__pxLoadCount = rec.n;
    } catch (_) { window.__pxLoadCount = 1; }
  })();

  // 🛡 リロードループを抜けられないときは、Safariのエラー画面に任せずここで止める
  function showLoopPanel() {
    if (document.getElementById('__px_loop_panel')) return;
    var p = document.createElement('div');
    p.id = '__px_loop_panel';
    p.style.cssText = 'position:fixed;left:0;right:0;top:0;bottom:0;z-index:2147483647;background:#0b1120;color:#f8fafc;font-family:-apple-system,BlinkMacSystemFont,sans-serif;display:flex;align-items:center;justify-content:center;padding:20px;';
    p.innerHTML = '<div style="background:#1e293b;border:1px solid #334155;border-radius:16px;padding:22px;max-width:420px;text-align:center;">' +
      '<div style="font-size:20px;font-weight:bold;color:#fbbf24;margin-bottom:10px;">このページの読み込みを止めました</div>' +
      '<div style="font-size:13px;color:#94a3b8;line-height:1.7;margin-bottom:16px;">同じページが何度も自動で読み直されていたので、端末が重くならないように一度止めています。</div>' +
      '<div style="display:flex;gap:8px;justify-content:center;flex-wrap:wrap;">' +
      '<a href="#" id="__px_loop_retry" style="background:#0284c7;color:#fff;text-decoration:none;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:bold;">もう一度だけ試す</a>' +
      '<a href="/tensai-proxy/" style="background:#334155;color:#cbd5e1;text-decoration:none;border-radius:8px;padding:9px 14px;font-size:13px;font-weight:bold;">🏠 ホーム</a>' +
      '</div></div>';
    (document.body || document.documentElement).appendChild(p);
    var btn = document.getElementById('__px_loop_retry');
    if (btn) btn.addEventListener('click', function (e) {
      e.preventDefault();
      try { sessionStorage.removeItem('__pxloop:' + baseUrl); } catch (_) {}
      location.reload();
    });
  }
  if ((window.__pxLoadCount || 0) >= 4) {
    if (document.body) showLoopPanel();
    else document.addEventListener('DOMContentLoaded', showLoopPanel);
  }

  // 🧹 プロキシ内でService Workerを登録させない（mokori側のキャッシュを壊し、
  // 「ページを読み込めませんでした」の原因になるため）
  try {
    if (navigator.serviceWorker) {
      try { navigator.serviceWorker.register = function () { return Promise.reject(new Error('proxy: service worker disabled')); }; } catch (_) {}
      try {
        navigator.serviceWorker.getRegistrations().then(function (rs) {
          (rs || []).forEach(function (r) {
            try {
              var sc = r.scope || '';
              if (sc.indexOf('/api/proxy') >= 0 || sc === location.origin + '/') r.unregister();
            } catch (_) {}
          });
        }).catch(function () {});
      } catch (_) {}
    }
  } catch (_) {}

  // 🩺 ページ内で起きたJSエラーを小さな⚠バッジに集める（白画面・無言の停止をなくす）
  (function () {
    var errs = [];
    function paint() {
      var b = document.getElementById('__px_err_badge');
      if (!b && errs.length) {
        b = document.createElement('div');
        b.id = '__px_err_badge';
        b.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483646;background:#7f1d1d;color:#fecaca;border:1px solid #b91c1c;border-radius:999px;padding:3px 9px;font:11px -apple-system,BlinkMacSystemFont,sans-serif;cursor:pointer;opacity:0.9;';
        b.addEventListener('click', function () {
          var pn = document.getElementById('__px_err_panel');
          if (pn) { pn.parentNode.removeChild(pn); return; }
          pn = document.createElement('div');
          pn.id = '__px_err_panel';
          pn.style.cssText = 'position:fixed;left:8px;right:8px;bottom:36px;z-index:2147483646;max-height:45vh;overflow:auto;background:#111827;color:#e5e7eb;border:1px solid #374151;border-radius:12px;padding:10px 12px;font:11px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;';
          var NL = String.fromCharCode(10); pn.textContent = '⚠ このページで起きたエラー（' + errs.length + '件）' + NL + errs.join(NL);
          (document.body || document.documentElement).appendChild(pn);
        });
        (document.body || document.documentElement).appendChild(b);
      }
      if (b) { b.textContent = '⚠ ' + errs.length; b.style.display = 'block'; }
    }
    function add(msg) {
      if (!msg) return;
      msg = String(msg).slice(0, 160);
      if (msg === 'Script error.' || errs.indexOf(msg) >= 0 || errs.length >= 8) return;
      // 🧹 サイト内部の無害な計測SDKのエラーはバッジに数えない（TikTok の
      // sync_web_sdk / a.init、Instagram の getMessage など）。見ても何もできない。
      if (/(sync_web_sdk|init is not a function|getMessage is not a function|ResizeObserver loop|__gCrWeb|Non-Error promise rejection|googletagmanager|doubleclick|IMA SDK|imasdk|google\.ima|AdsLoader|AdsManager|adTagUrl|VAST|AdError)/i.test(msg)) return;
      errs.push(msg);
      paint();
    }
    window.addEventListener('error', function (e) {
      try { add((e && (e.message || (e.error && e.error.message))) || ''); } catch (_) {}
    }, true);
    window.addEventListener('unhandledrejection', function (e) {
      try {
        var r = e && e.reason;
        add(r && (r.message || r.toString ? r.toString() : r));
      } catch (_) {}
    });
    window.__pxErrors = errs;
  })();

  var mockLocation = {
    get pathname() { return window.__proxy_pathname; },
    set pathname(v) { window.__proxy_pathname = v; },
    get search() { return window.__proxy_search; },
    set search(v) { window.__proxy_search = v; },
    get hash() { return window.__proxy_hash; },
    set hash(v) { window.__proxy_hash = v; },
    get href() { return window.__proxy_href; },
    set href(v) {
      if (typeof v === 'string' && !v.includes('/api/proxy')) {
        if (v.charAt(0) === '/' && !v.startsWith('//')) {
          try {
            var absSelf = new URL(v, baseUrl);
            if (absSelf.hostname === window.location.hostname) { location.href = v; return; }
          } catch (_) {}
        }
        location.href = '/api/proxy?url=' + encodeURIComponent(new URL(v, baseUrl).href);
      } else {
        location.href = v;
      }
    },
    get origin() { return baseObj.origin; },
    get host() { return baseObj.host; },
    get hostname() { return baseObj.hostname; },
    get port() { return baseObj.port; },
    get protocol() { return baseObj.protocol; },
    assign: function(url) { this.href = url; },
    replace: function(url) { this.href = url; },
    reload: function() { location.reload(); },
    toString: function() { return window.__proxy_href; }
  };
  window.__proxy_location = mockLocation;

  // Poki専用: 重いSPA（Instagram/TikTok等）ではWebKitが落ちる原因になるため、Poki系だけに限定
  if (IS_POKI) {
  try {
    var winProxy = new Proxy(window, {
      get: function(target, prop) {
        if (prop === 'location') return mockLocation;
        var val = target[prop];
        return typeof val === 'function' ? val.bind(target) : val;
      }
    });
    Object.defineProperty(Document.prototype, 'defaultView', {
      configurable: true,
      enumerable: true,
      get: function() { return winProxy; }
    });
  } catch(_) {}
  }

  if (IS_POKI) try {
    localStorage.setItem('poki_nobot', 'true');
    window.pokiDebug = true;
    window.poki_nobot = true;
    var targetSDK = {
      init: function() { return Promise.resolve(); },
      gameLoadingStart: function() {},
      gameLoadingFinished: function() {},
      gameLoadingProgress: function() {},
      gameplayStart: function() {},
      gameplayStop: function() {},
      commercialBreak: function() { return Promise.resolve(); },
      rewardedBreak: function() { return Promise.resolve(true); },
      displayAd: function() { return Promise.resolve(); },
      destroyAd: function() {},
      setDebug: function() {},
      happyTime: function() {},
      showLeaderboard: function() { return Promise.resolve(); },
      getLeaderboard: function() { return Promise.resolve([]); },
      measure: function() {},
      setPlayerAge: function() {},
      toggleMute: function() {},
      captureError: function() {},
      muteAd: function() {},
      setPayload: function() {},
      customEvent: function() {},
      getPayload: function() { return Promise.resolve({}); },
      isAdBlocked: function() { return false; },
      getParam: function() { return null; },
      shareableURL: function() { return Promise.resolve(window.__proxy_href); },
      dequeue: function() {}
    };
    window.PokiSDK = new Proxy(targetSDK, {
      get: function(t, p) {
        if (p in t) return t[p];
        return function() { return Promise.resolve(); };
      }
    });
    window.pokiBotDetected = [];
    window.pokiBotScore = 0;
    window.pokiBotVerified = true;
    window.pokiCrawlerBlock = "";
    window.pokiBotDetectedPromise = Promise.resolve([]);
  } catch(_) {}

  if (IS_POKI && baseUrl.includes('poki.com')) {
    // Poki自身のプレイヤーが先にゲームiframeを作る。こちらが重ねて作ると
    // 同じゲームが2つ同時にロードされ、広告SDKも二重初期化されて
    // ローディングが完了しない（＝ゲームが始まらない）。4秒待っても
    // プレイヤーが出てこないときだけ自前でマウントする。
    var pokiMountAt = Date.now() + 4000;
    function tryMountPokiGame() {
      if (Date.now() < pokiMountAt) return false;
      if (document.querySelector('iframe#game-element') || document.querySelector('#game-player iframe')) return true;
      var errEl = document.getElementById('pageError');
      if (errEl) {
        errEl.style.display = 'none';
        errEl.innerHTML = '';
      }
      var gp = document.getElementById('game-player');
      if (!gp && baseUrl.includes('/g/')) {
        gp = document.createElement('div');
        gp.id = 'game-player';
        gp.style.width = '100%';
        gp.style.height = 'calc(100vh - 50px)';
        gp.style.minHeight = '650px';
        gp.style.margin = '0 auto';
        gp.style.maxWidth = '1200px';
        gp.style.background = '#0f172a';
        gp.style.borderRadius = '16px';
        gp.style.overflow = 'hidden';
        gp.style.position = 'relative';
        if (errEl && errEl.parentElement) {
          errEl.parentElement.insertBefore(gp, errEl);
        } else if (document.body) {
          document.body.prepend(gp);
        }
      }

      if (!gp) return false;
      if (gp.querySelector('iframe')) return true;

      var contentUrl = null;
      try {
        if (window.INITIAL_STATE && window.INITIAL_STATE.api && window.INITIAL_STATE.api.queries) {
          for (var k in window.INITIAL_STATE.api.queries) {
            if (k.startsWith('getGame(')) {
              var qData = window.INITIAL_STATE.api.queries[k].data;
              if (qData && (qData.content || (qData.file && qData.file.content))) {
                contentUrl = qData.content || qData.file.content;
                break;
              }
            }
          }
        }
      } catch(e) {}

      if (!contentUrl) {
        try {
          var rawHTML = document.documentElement ? document.documentElement.innerHTML : '';
          var rx = new RegExp('https?:[/\\\\u002F]+games\\\\.poki\\\\.com[/\\\\u002F0-9a-zA-Z_\\\\-]+');
          var m = rawHTML.match(rx);
          if (m) {
            contentUrl = m[0].split('\\\\u002F').join('/').split('\\\\').join('');
          }
        } catch(_) {}
      }

      if (contentUrl) {
        var proxyUrl = '/api/proxy?url=' + encodeURIComponent(contentUrl) + '&_ts=' + Date.now();
        var iframe = document.createElement('iframe');
        iframe.id = 'game-element';
        iframe.name = 'gameFrame';
        iframe.src = proxyUrl;
        iframe.style.width = '100%';
        iframe.style.height = '100%';
        iframe.style.border = 'none';
        iframe.style.minHeight = '650px';
        iframe.allowFullscreen = true;
        iframe.setAttribute('allow', 'autoplay; fullscreen; camera; focus-without-user-activation *; monetization; gamepad; keyboard-map *; xr-spatial-tracking; clipboard-write; web-share; accelerometer; magnetometer; gyroscope; microphone *; screen-wake-lock');
        iframe.setAttribute('sandbox', 'allow-forms allow-modals allow-orientation-lock allow-pointer-lock allow-popups allow-popups-to-escape-sandbox allow-presentation allow-scripts allow-same-origin allow-downloads');
        gp.innerHTML = '';
        gp.appendChild(iframe);
        return true;
      }
      return false;
    }

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryMountPokiGame);
    } else {
      tryMountPokiGame();
    }
    var checkTimer = setInterval(tryMountPokiGame, 400);
    setTimeout(function() { clearInterval(checkTimer); }, 25000);
  }

  function toProxy(u) {
    if (!u || typeof u !== 'string' || u.startsWith('data:') || u.startsWith('blob:') || u.startsWith('javascript:') || u.startsWith('#') || u.includes('/api/proxy?url=') || /^\\/(?:tensai-proxy|tube|music|tiktok|instagram|mail\.html|downloads)(?:\\/|$)/.test(u)) return u;
    try {
      var absUrl = new URL(u, baseUrl);
      // もこり本体（自ドメイン）宛ては中継しない
      if (absUrl.hostname === window.location.hostname) {
        return absUrl.pathname + absUrl.search + absUrl.hash;
      }
      if (absUrl.pathname.endsWith('.js') && !absUrl.searchParams.has('_v')) {
        absUrl.searchParams.set('_v', '101');
      }
      return '/api/proxy?url=' + encodeURIComponent(absUrl.href);
    } catch(_) {
      return u;
    }
  }

  // リール・投稿・動画ページは、もこり内ビューアのURLを返す（無ければnull）
  function viewerHref(absUrl) {
    try {
      var u = new URL(typeof absUrl === 'string' ? absUrl : absUrl.href);
      var host = u.hostname.toLowerCase();
      var segs = u.pathname.split('/').filter(function (x) { return x.length > 0; });
      var root = segs[0] || '';
      var isIg = host === 'instagram.com' || host.slice(-14) === '.instagram.com';
      if (isIg && (root === 'reel' || root === 'reels' || root === 'p' || root === 'tv')) {
        return { href: '/instagram/?url=' + encodeURIComponent(u.href), viewer: '1' };
      }
      var isTt = host === 'tiktok.com' || host.slice(-11) === '.tiktok.com';
      if (isTt && root.charAt(0) === '@' && segs[1] === 'video' && /^[0-9]+$/.test(segs[2] || '')) {
        return { href: '/tiktok/?url=' + encodeURIComponent(u.href), viewer: '1' };
      }
    } catch (_) {}
    return null;
  }

  if (window.HTMLAnchorElement && window.HTMLAnchorElement.prototype) {
    var anchorHref = Object.getOwnPropertyDescriptor(HTMLAnchorElement.prototype, 'href');
    if (anchorHref && anchorHref.set) {
      var setAnchorHref = anchorHref.set;
      Object.defineProperty(HTMLAnchorElement.prototype, 'href', {
        configurable: anchorHref.configurable,
        enumerable: anchorHref.enumerable,
        get: anchorHref.get,
        set: function(val) {
          try {
            var abs = new URL(val, baseUrl);
            var vh = viewerHref(abs);
            if (vh) {
              this.setAttribute('data-proxy-viewer', '1');
              return setAnchorHref.call(this, vh.href);
            }
          } catch (_) {}
          return setAnchorHref.call(this, toProxy(val));
        }
      });
    }
  }

  if (window.open) {
    var originalOpen = window.open;
    window.open = function(url, name, features) {
      return originalOpen.call(window, typeof url === 'string' ? toProxy(url) : url, name, features);
    };
  }

  window.addEventListener('click', function(e) {
    // 🎬 YouTube のクリックは横取りしない。href が本物のパスなので、YouTube 自身の
    // SPA ルーターに任せるのが確実（横取りすると毎回フルロードになり、ウォッチ
    // ページのHTML取得でGoogleのロボット確認を食らう）。
    if (IS_YOUTUBE) return;
    var target = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
    var anchor = target && target.closest ? target.closest('a[href]') : null;
    // リール・投稿・動画ページは、もこり内ビューアへ（SPAの割り込みより先に処理する）
    if (anchor && anchor.getAttribute('data-proxy-viewer') === '1') {
      e.preventDefault();
      e.stopImmediatePropagation();
      window.location.href = anchor.getAttribute('href');
      return;
    }
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!anchor || (anchor.target && anchor.target !== '_self')) return;
    var href = anchor.getAttribute('href') || '';
    if (!href || href.startsWith('#')) return;
    if (href.includes('/api/proxy?url=')) {
      e.preventDefault();
      e.stopImmediatePropagation();
      window.location.href = href;
      return;
    }
    if (/^\\/(?:tensai-proxy|tube|music|tiktok|instagram)(?:\\/|$)/.test(href)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    window.location.href = toProxy(href);
  }, true);

  // Neutralize Framebusting for Instagram, TikTok, and Cloud Roblox
  try {
    Object.defineProperty(window, 'top', { get: function() { return window; }, configurable: true });
    Object.defineProperty(window, 'parent', { get: function() { return window; }, configurable: true });
    Object.defineProperty(window, 'frameElement', { get: function() { return null; }, configurable: true });
  } catch(_) {}

  // Intercept window.fetch for Instagram GraphQL & TikTok video feeds
  if (window.fetch) {
    var origFetch = window.fetch;
    window.fetch = function(resource, init) {
      if (typeof resource === 'string') {
        resource = toProxy(resource);
      } else if (resource && resource.url) {
        try {
          resource = new Request(toProxy(resource.url), resource);
        } catch(_) {}
      }
      return origFetch.call(this, resource, init);
    };
  }

  // Intercept Video, Audio, Image, IFrame, Script src
  ['HTMLImageElement', 'HTMLIFrameElement', 'HTMLScriptElement', 'HTMLSourceElement', 'HTMLVideoElement', 'HTMLAudioElement', 'HTMLMediaElement'].forEach(function(cls) {
    if (window[cls] && window[cls].prototype) {
      var desc = Object.getOwnPropertyDescriptor(window[cls].prototype, 'src');
      if (desc && desc.set) {
        var origSet = desc.set;
        Object.defineProperty(window[cls].prototype, 'src', {
          set: function(val) { return origSet.call(this, toProxy(val)); },
          get: desc.get
        });
      }
    }
  });

  var origSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, val) {
    if (name === 'src' || name === 'href' || name === 'data-src' || name === 'poster') {
      if (name === 'href') {
        try {
          var vh = viewerHref(new URL(String(val), baseUrl));
          if (vh) {
            origSetAttribute.call(this, 'data-proxy-viewer', '1');
            return origSetAttribute.call(this, name, vh.href);
          }
        } catch (_) {}
      }
      val = toProxy(val);
    }
    return origSetAttribute.call(this, name, val);
  };

  if (window.XMLHttpRequest) {
    var origOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
      if (typeof url === 'string') {
        arguments[1] = toProxy(url);
      }
      return origOpen.apply(this, arguments);
    };
  }

  if (window.history) {
    var origPush = history.pushState;
    var origReplace = history.replaceState;
    // 自ドメイン（もこり本体）のURLをプロキシURLで再ラップしない＝URL二重化の防止
    function resolveVirtual(u) {
      if (!u || typeof u !== 'string') return null;
      try {
        var abs = new URL(u, baseUrl);
        var selfHost = window.location.hostname;
        if (abs.hostname === selfHost && (abs.pathname === '/api/proxy' || abs.pathname === '/api/proxy/')) {
          var inner = abs.searchParams.get('url');
          if (inner) {
            return { url: new URL(inner), proxied: abs };
          }
          return { url: new URL(baseUrl), proxied: abs };
        }
        if (abs.hostname === selfHost) {
          return { url: abs, proxied: null, skip: true };
        }
        return { url: abs, proxied: null };
      } catch (_) {
        return null;
      }
    }
    function applyVirtual(v) {
      window.__proxy_pathname = v.url.pathname;
      window.__proxy_search = v.url.search;
      window.__proxy_hash = v.url.hash;
      window.__proxy_href = v.url.href;
      return v.proxied ? (v.proxied.pathname + v.proxied.search) : ('/api/proxy?url=' + encodeURIComponent(v.url.href));
    }
    // 偽装パス運用中（TikTok）は、URLも上流のパスに合わせておく。
    // そうしないとSPAのルーターが /api/proxy を読んで404へ飛ぶ。再読み込みは
    // __px_origin Cookie + _spa=1 の救済で元の画面に戻る。
    function visualPath(v) {
      return window.__pxVisualPath(v.url.pathname, v.url.search, v.url.hash);
    }
    history.pushState = function(state, title, url) {
      if (url) {
        var v = resolveVirtual(url);
        if (v) arguments[2] = window.__pxFakePath ? visualPath(v) : applyVirtual(v);
      }
      return origPush.apply(this, arguments);
    };
    history.replaceState = function(state, title, url) {
      if (url) {
        var v = resolveVirtual(url);
        if (v) arguments[2] = window.__pxFakePath ? visualPath(v) : applyVirtual(v);
      }
      return origReplace.apply(this, arguments);
    };
  }

  if (window.Worker) {
    var origWorker = window.Worker;
    window.Worker = function(scriptURL, options) {
      return new origWorker(toProxy(scriptURL), options);
    };
  }

  // 送信系（ビーコン・EventSource）も同じ中継を通す
  try {
    if (navigator.sendBeacon) {
      var origBeacon = navigator.sendBeacon.bind(navigator);
      navigator.sendBeacon = function(u, data) {
        try { return origBeacon(toProxy(u), data); } catch (_) { return false; }
      };
    }
    if (window.EventSource) {
      var OrigES = window.EventSource;
      window.EventSource = function(u, c) { return new OrigES(toProxy(u), c); };
    }
  } catch (_) {}

  document.addEventListener('submit', function(e) {
    var f = e.target;
    if (!f) return;
    var m = (f.method || 'GET').toUpperCase();
    if (m === 'GET') {
      e.preventDefault();
      try {
        var act = f.getAttribute('action') || '';
        var resolvedAct = act ? new URL(act, baseUrl).href : baseUrl;
        if (resolvedAct.includes('/api/proxy?url=')) {
          resolvedAct = decodeURIComponent(resolvedAct.split('/api/proxy?url=')[1]);
        }
        var fd = new FormData(f);
        var sp = new URLSearchParams(fd);
        var dest = resolvedAct.split('?')[0] + '?' + sp.toString();
        window.location.href = '/api/proxy?url=' + encodeURIComponent(dest);
      } catch(err) {
        f.submit();
      }
    }
  }, true);
})();
</script>
`;

      const navBar = `
<div id="__tensai_proxy_bar" style="position:fixed; top:0; left:0; width:100%; height:38px; background:rgba(15,23,42,0.96); backdrop-filter:blur(8px); border-bottom:1px solid rgba(255,255,255,0.15); z-index:2147483647; display:flex; align-items:center; justify-content:space-between; padding:0 12px; box-sizing:border-box; font-family:-apple-system,BlinkMacSystemFont,sans-serif; color:#fff; font-size:12px;">
  <div style="display:flex; align-items:center; gap:8px;">
    <span class="px-lbl" style="font-weight:bold; color:#38bdf8; white-space:nowrap;">⚡ 天才プロキシ</span>
    <button onclick="history.back()" style="background:#334155; color:#fff; border:0; border-radius:4px; padding:3px 8px; cursor:pointer; font-size:11px;">◀ 戻る</button>
    <button onclick="location.reload()" style="background:#334155; color:#fff; border:0; border-radius:4px; padding:3px 8px; cursor:pointer; font-size:11px;">🔄 更新</button>
  </div>
  <div class="px-dest" style="flex:1; min-width:0; max-width:450px; margin:0 10px;">
    <form onsubmit="event.preventDefault(); var u=document.getElementById('__proxy_dest').value; if(u){ if(!u.startsWith('http')) u='https://'+u; location.href='/api/proxy?url='+encodeURIComponent(u); }" style="display:flex; margin:0;">
      <input id="__proxy_dest" type="text" value="${baseUrl.replace(/"/g, '&quot;')}" style="width:100%; height:26px; border-radius:13px; border:1px solid #475569; background:#1e293b; color:#f8fafc; padding:0 10px; font-size:11px; box-sizing:border-box;">
    </form>
  </div>
  <div style="display:flex; align-items:center; gap:6px;">
    <button onclick="var b=document.getElementById('__tensai_proxy_bar'); if(b) b.style.display='none';" style="background:#475569; color:#fff; border:0; border-radius:4px; padding:3px 8px; cursor:pointer; font-size:11px;">非表示</button>
    <a href="/tensai-proxy/" style="background:#0284c7; color:#fff; text-decoration:none; border-radius:4px; padding:3px 8px; font-size:11px; font-weight:bold;">🏠 ホーム</a>
  </div>
</div>
<style id="__tensai_proxy_style"> body { margin-top: 38px !important; }${
        isYouTubeSite
          ? " #masthead-container { top: 38px !important; } #page-manager { margin-top: 38px !important; }"
          : ""
      }
/* 📱 スマホ幅（iPhone 390px等）ではバーを一段小さくして、サイトのレイアウトを
   押し潰さないようにする。URL欄とロゴ文字は隠し、操作ボタンだけを残す。 */
@media (max-width: 520px) {
  #__tensai_proxy_bar { height: 34px !important; padding: 0 8px !important; }
  #__tensai_proxy_bar .px-lbl, #__tensai_proxy_bar .px-dest { display: none !important; }
  #__tensai_proxy_bar button, #__tensai_proxy_bar a { font-size: 11px !important; padding: 3px 7px !important; }
  body { margin-top: 34px !important; }
} </style>
<script>
if (window !== window.top) {
  var __b = document.getElementById('__tensai_proxy_bar');
  if (__b) __b.style.display = 'none';
  var __s = document.getElementById('__tensai_proxy_style');
  if (__s) __s.remove();
  if (document.body) document.body.style.marginTop = '0px';
}
</script>
`;

      // 📸 Instagram公式SPAがBootloaderで止まったときの逃げ道。
      // MetaはデータセンターIPのモジュール取得（/ajax/bootloader-endpoint/）を 429/404 で
      // 落とすことがあり、その場合Instagramの画面は無限スピナーのままになる。
      // 一定時間たっても中身が描画されないときだけ、もこりのビューアへ案内を出す。
      const igFallbackBar = isInstagram ? `
<div id="__ig_fallback" style="display:none; position:fixed; left:0; right:0; bottom:0; z-index:2147483647; background:rgba(15,23,42,0.97); color:#fff; padding:14px 14px 16px; font-family:-apple-system,BlinkMacSystemFont,sans-serif; font-size:13px; line-height:1.6; box-shadow:0 -6px 20px rgba(0,0,0,0.35);">
  <div style="font-weight:bold; margin-bottom:6px;">📸 Instagramの公式画面を読み込めませんでした</div>
  <div style="font-size:12px; color:#cbd5e1; margin-bottom:10px;">Meta側の制限（HTTP 429）で、公式ページの部品が読み込めていません。<b>もこりの中のInstagramなら見られます。</b></div>
  <div style="display:flex; gap:8px; flex-wrap:wrap;">
    <a href="/instagram/" style="background:#e1306c; color:#fff; text-decoration:none; border-radius:8px; padding:9px 14px; font-weight:bold; font-size:13px;">📸 もこりInstagramで見る</a>
    <button onclick="location.reload()" style="background:#334155; color:#fff; border:0; border-radius:8px; padding:9px 14px; font-size:13px;">🔄 もう一度読み込む</button>
    <button onclick="document.getElementById('__ig_fallback').style.display='none'" style="background:transparent; color:#94a3b8; border:0; padding:9px 6px; font-size:12px;">閉じる</button>
  </div>
</div>
<script>
(function(){
  function looksStuck(){
    try {
      var b = document.body; if (!b) return true;
      var txt = (b.innerText || "").replace(/\\s+/g, "");
      var imgs = b.getElementsByTagName("img").length;
      var busy = b.querySelectorAll('[role="progressbar"], svg[aria-label*="読み込み"], svg[aria-label*="Loading"]').length;
      if (txt.length < 40 && imgs === 0) return true;
      return busy > 0 && imgs < 2 && txt.length < 200;
    } catch (e) { return false; }
  }
  function check(){
    var el = document.getElementById("__ig_fallback");
    if (!el) return;
    if (looksStuck()) el.style.display = "block";
  }
  setTimeout(check, 9000);
  setTimeout(check, 16000);
  window.addEventListener("load", function(){ setTimeout(check, 6000); });
})();
</script>
` : "";

      if (html.includes("<head")) {
        html = html.replace(/<head([^>]*)>/i, `<head$1>${imaPreseed}${interceptScript}`);
      } else if (html.includes("<body")) {
        html = html.replace(/<body([^>]*)>/i, `<body$1>${interceptScript}`);
      } else {
        html = interceptScript + html;
      }

      if (html.includes("<body")) {
        html = html.replace(/<body([^>]*)>/i, `<body$1>${navBar}${igFallbackBar}`);
      } else {
        html = navBar + igFallbackBar + html;
      }
      // このプロキシ画面がどの上流のものかをCookieに残す（Workerや絶対パスが
      // プロキシ外へ抜けたときに元のサイトへ戻すため）
      try {
        const prevCookie = String(req.headers.cookie || "");
        const existing = /(?:^|;\s*)__px_origin=([^;]*)/.exec(prevCookie);
        const encodedOrigin = encodeURIComponent(origin);
        // 🍪 上流のオリジンは「トップレベルの文書」だけが書き換える。iframe の中身
        // （YouTube内の accounts.google.com 等）まで書き換えると、救済ミドルウェアが
        // /s/_/… を間違った上流（Googleのログイン）へ中継してページが壊れる。
        const dest = String(req.headers["sec-fetch-dest"] || "").toLowerCase();
        const fromSubframe = dest === "iframe" || dest === "frame" || dest === "embed" || dest === "object";
        if (!fromSubframe && (!existing || existing[1] !== encodedOrigin)) {
          res.append("Set-Cookie", `${PROXY_ORIGIN_COOKIE}=${encodedOrigin}; Path=/; Max-Age=1800; SameSite=Lax`);
        }
      } catch (_) {}
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      if (pageCacheKey) {
        socialCacheSet(pageCacheKey, html, pageCacheTtl);
        try {
          igDocCookieCache.set(pageCacheKey, pjarSetCookies(response));
          if (igDocCookieCache.size > 40) igDocCookieCache.delete(igDocCookieCache.keys().next().value);
        } catch (_) {}
        docDone();
      }
      return res.send(html);
    }

    if (contentType.includes("text/css")) {
      let css = await response.text();
      const baseUrl = response.url || targetUrl;
      css = css.replace(/url\(\s*["']?([^"')]+)["']?\s*\)/gi, (match, val) => {
        if (!val || val.startsWith("data:") || val.startsWith("blob:")) return match;
        try {
          const abs = new URL(val, baseUrl).href;
          return `url("/api/proxy?url=${encodeURIComponent(abs)}")`;
        } catch (_) {
          return match;
        }
      });
      res.setHeader("Content-Type", "text/css; charset=utf-8");
      if (assetKey && response.ok) assetCacheSet(assetKey, Buffer.from(css, "utf8"), "text/css; charset=utf-8");
      res.setHeader("Cache-Control", assetKey ? "public, max-age=1800" : "no-cache, no-store, must-revalidate");
      return res.send(css);
    }

    if (contentType.includes("javascript") || (response.url && response.url.includes(".js"))) {
      let js = await response.text();
      // Worker内の相対URLを上流基準で解決し直す小さなシム（ページ内では何もしない）
      if (js && !js.startsWith("/*px-shim*/")) {
        js = "/*px-shim*/" + PROXY_WORKER_SHIM + js;
      }
      // PokiSDK: 本物の広告SDKは「広告ブレーク」をはさむまでゲームを開始させない。
      // プロキシでは広告を配信できないため、読み込み後に広告系メソッドを即解決へ差し替える
      // （これをしないとゲームのローディングが途中で止まったまま始まらない）。
      if (response.url && /poki-sdk/i.test(response.url) && !js.includes("__pokiInstant")) {
        js += POKI_SDK_PATCH;
      }
      // Poki等のゲームSitelock解除 & デバッグモード有効化 & ロケーション参照解決
      if (response.url && (response.url.includes("poki") || response.url.includes("fancade") || response.url.includes("turbowarp"))) {
        js = js.replace(/\bvar\s+pokiDebug\s*=\s*false;/g, "var pokiDebug = true;");
        js = js.replace(/\bpokiDebug\s*=\s*false\b/g, "pokiDebug = true");
        // 🧭 location の差し替えは「壊れたら元のまま返す」方式。
        // 1本のバンドルが構文エラーになると、そのサイトはまるごと起動しなくなる
        // （TurboWarp がこれで真っ白だった）。差し替え後のコードを実際にコンパイルして
        // 確かめ、通らないときは未加工のコードを返す。
        const locRewritten = pxRewriteLocationRefs(js);
        if (locRewritten !== js) {
          const okRewritten = pxJsCompiles(locRewritten) || !pxJsCompiles(js);
          if (okRewritten) {
            js = locRewritten;
            res.setHeader("X-Tensai-Loc", "rewritten");
          } else {
            res.setHeader("X-Tensai-Loc", "kept-original");
          }
        }
      }
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
      res.setHeader("Cache-Control", assetKey ? "public, max-age=1800" : "no-cache, no-store, must-revalidate");
      res.setHeader("Pragma", "no-cache");
      if (assetKey && response.ok) assetCacheSet(assetKey, Buffer.from(js, "utf8"), "application/javascript; charset=utf-8");
      return res.send(js);
    }

    const buf = Buffer.from(await response.arrayBuffer());
    if (assetKey && response.ok) assetCacheSet(assetKey, buf, contentType || "application/octet-stream");
    if (cacheableAsset) res.setHeader("Cache-Control", "public, max-age=1800");
    return res.end(buf);
  } catch (err) {
    docDone();
    // 上流へ届かなかったときも、取れているページがあればそれを返す（Instagramのスピナー対策）
    if (typeof pageCacheKey !== "undefined" && pageCacheKey) {
      const staleDoc = socialCacheGetAny(pageCacheKey);
      if (staleDoc) {
        res.status(200);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("X-Tensai-Stale", "1");
        return res.send(staleDoc);
      }
    }
    const cause = err && err.cause ? (err.cause.code || err.cause.message || String(err.cause)) : "";
    const detail = `${err && err.message ? err.message : "接続できませんでした"}${cause ? "（" + cause + "）" : ""}<br>相手のサイトが一時的に応答していないか、この回線をブロックしている可能性があります。少し待ってから「もう一度読み込む」を押してください。`;
    return res.status(502).send(renderProxyError("ページの読み込みに失敗しました", detail, `/api/proxy?url=${encodeURIComponent(targetUrl)}`));
  }
});

// ====================================================
// 🎬 メディア中継（TikTok / Instagram の mp4・画像を自ドメインから配信）
// ====================================================
const MEDIA_ALLOWED_HOSTS = [
  "tiktokcdn.com", "tiktokcdn-us.com", "tiktokcdn-eu.com", "tiktokcdn-a.com", "tiktokv.com", "tiktokv.us",
  "ibytedtos.com", "ibyteimg.com", "byteoversea.com", "muscdn.com", "tiktok.com", "ttwstatic.com",
  "cdninstagram.com", "fbcdn.net", "instagram.com", "threads.net"
];
function isAllowedMediaHost(host) {
  const h = String(host || "").toLowerCase();
  return MEDIA_ALLOWED_HOSTS.some((d) => h === d || h.endsWith("." + d));
}

app.get("/api/media", async (req, res) => {
  const raw = String(req.query.url || "");
  if (!raw) return res.status(400).send("url required");
  let target;
  try {
    target = new URL(raw);
  } catch (_) {
    return res.status(400).send("bad url");
  }
  if (!/^https?:$/.test(target.protocol) || !isAllowedMediaHost(target.hostname)) {
    return res.status(403).send("host not allowed");
  }
  try {
    const headers = {
      "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      "Accept": "*/*"
    };
    if (req.headers.range) headers["Range"] = req.headers.range;
    const upstream = await fetch(target.href, { headers, redirect: "follow" });
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
    res.setHeader("Accept-Ranges", "bytes");
    for (const h of ["content-length", "content-range", "etag", "last-modified"]) {
      const v = upstream.headers.get(h);
      if (v) res.setHeader(h, v);
    }
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.setHeader("Access-Control-Allow-Origin", "*");
    if (!upstream.body) return res.end();
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    return res.status(502).send("media fetch failed: " + err.message);
  }
});

// ====================================================
// 🎵 TikTok ビューア用API（公式 embed ページ + 公開API中継）
// ====================================================
const TK_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const IG_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const socialCache = new Map();
function socialCacheGet(key) {
  const hit = socialCache.get(key);
  if (!hit) return null;
  if (Date.now() > hit.expire) {
    socialCache.delete(key);
    return null;
  }
  return hit.value;
}
function socialCacheSet(key, value, ttlMs) {
  if (socialCache.size > 200) socialCache.clear();
  socialCache.set(key, { value, expire: Date.now() + ttlMs });
}
// 期限切れでもいいので直近の値を取り出す（上流が429/失敗したときの代替表示用）
function socialCacheGetAny(key) {
  const hit = socialCache.get(key);
  return hit ? hit.value : null;
}

// "key":[ ... ] / "key":{ ... } を文字列状態を保ったまま安全に取り出す
function extractJsonAfter(src, key) {
  const marker = '"' + key + '":';
  const idx = src.indexOf(marker);
  if (idx < 0) return null;
  let i = idx + marker.length;
  while (i < src.length && /\s/.test(src[i])) i++;
  const open = src[i];
  if (open !== "[" && open !== "{") return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let k = i; k < src.length; k++) {
    const c = src[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(src.slice(i, k + 1));
        } catch (_) {
          return null;
        }
      }
    }
  }
  return null;
}

function normalizeTiktokVideo(v) {
  if (!v || !v.id) return null;
  return {
    id: String(v.id),
    desc: v.desc || "",
    cover: v.coverUrl || v.originCoverUrl || v.dynamicCoverUrl || "",
    play: v.playAddr || "",
    author: v.authorUniqueId || "",
    plays: typeof v.playCount === "number" ? v.playCount : null,
    width: v.width || null,
    height: v.height || null
  };
}

async function fetchTiktokEmbedList(url) {
  const resp = await fetch(url, {
    headers: {
      "User-Agent": TK_UA,
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
      "Referer": "https://www.tiktok.com/"
    },
    redirect: "follow",
    signal: AbortSignal.timeout(20000)
  });
  if (!resp.ok) throw new Error("TikTok embed status " + resp.status);
  const html = await resp.text();
  const list = extractJsonAfter(html, "videoList");
  const userInfo = extractJsonAfter(html, "userInfo");
  const videos = Array.isArray(list) ? list.map(normalizeTiktokVideo).filter(Boolean) : [];
  return { videos, userInfo: userInfo && typeof userInfo === "object" ? userInfo : null };
}

async function fetchTikwmFeed(region) {
  const r = await fetch(`https://www.tikwm.com/api/feed/list?region=${region}&count=24`, {
    headers: { "User-Agent": TK_UA, "Accept": "application/json" },
    signal: AbortSignal.timeout(25000)
  });
  const text = await r.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch (_) {
    data = null;
  }
  const items = data && Array.isArray(data.data) ? data.data : [];
  return items.map((v) => ({
    id: String(v.video_id || ""),
    desc: v.title || "",
    cover: v.cover || v.origin_cover || "",
    play: v.play || v.wmplay || "",
    author: (v.author && v.author.unique_id) || "",
    nickname: (v.author && v.author.nickname) || "",
    avatar: (v.author && v.author.avatar) || "",
    plays: typeof v.play_count === "number" ? v.play_count : null,
    likes: typeof v.digg_count === "number" ? v.digg_count : null,
    duration: v.duration || null
  })).filter((v) => v.id && v.play);
}

const JP_TAGS = ["日本", "アニメ", "ダンス", "料理", "カフェ", "音楽", "推し活", "スポーツ"];

app.get("/api/tiktok/feed", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const region = (String(req.query.region || "JP").toUpperCase().replace(/[^A-Z]/g, "") || "JP").slice(0, 2);
  const slot = Math.floor(Date.now() / (1000 * 60 * 30));
  const jpTag = JP_TAGS[slot % JP_TAGS.length];
  const cacheKey = "tt-feed2:" + region + ":" + jpTag;
  const cached = socialCacheGet(cacheKey);
  if (cached) return res.json({ ok: true, source: "cache", region, videos: cached });

  // 日本のタグと全体のおすすめをブレンドして「おすすめ」を作る
  const [jp, extra, global, fyp] = await Promise.all([
    fetchTiktokEmbedList(`https://www.tiktok.com/embed/tag/${encodeURIComponent("日本")}`).then((r) => r.videos).catch(() => []),
    fetchTiktokEmbedList(`https://www.tiktok.com/embed/tag/${encodeURIComponent(jpTag)}`).then((r) => r.videos).catch(() => []),
    fetchTikwmFeed(region).catch(() => []),
    fetchTiktokEmbedList("https://www.tiktok.com/embed/tag/fyp").then((r) => r.videos).catch(() => [])
  ]);

  const seen = new Set();
  const videos = [];
  const push = (v) => {
    if (v && v.id && v.play && !seen.has(v.id)) {
      seen.add(v.id);
      videos.push(v);
    }
  };
  const maxLen = Math.max(jp.length, extra.length, global.length, fyp.length);
  for (let i = 0; i < maxLen; i++) {
    if (jp[i]) push(jp[i]);
    if (global[i]) push(global[i]);
    if (extra[i]) push(extra[i]);
    if (fyp[i]) push(fyp[i]);
  }

  if (!videos.length) {
    try {
      const fb = await fetchTiktokEmbedList("https://www.tiktok.com/embed/tag/%E3%83%80%E3%83%B3%E3%82%B9");
      fb.videos.forEach(push);
    } catch (_) {}
  }
  // 日本語の動画を先に見せる（おすすめが海外の動画ばかりにならないように）
  const hasJapanese = (v) => /[\u3040-\u30FF\u4E00-\u9FFF]/.test((v.desc || "") + " " + (v.nickname || ""));
  videos.sort((a, b) => (hasJapanese(b) ? 1 : 0) - (hasJapanese(a) ? 1 : 0));
  if (!videos.length) {
    return res.status(502).json({ ok: false, error: "おすすめ動画を取得できませんでした。少し待って再度お試しください。" });
  }
  socialCacheSet(cacheKey, videos, 5 * 60 * 1000);
  return res.json({ ok: true, source: "live", region, videos });
});

app.get("/api/tiktok/user", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const user = String(req.query.user || "").replace(/^@/, "").trim();
  if (!/^[A-Za-z0-9._]{1,40}$/.test(user)) {
    return res.status(400).json({ ok: false, error: "ユーザー名は半角英数字・._ のみ使えます" });
  }
  const cacheKey = "tt-user:" + user.toLowerCase();
  const cached = socialCacheGet(cacheKey);
  if (cached) return res.json({ ok: true, source: "cache", user, ...cached });
  try {
    const { videos, userInfo } = await fetchTiktokEmbedList(`https://www.tiktok.com/embed/@${encodeURIComponent(user)}`);
    if (!videos.length) throw new Error("このユーザーの動画が見つかりません");
    const payload = {
      videos,
      profile: userInfo
        ? {
            nickname: userInfo.nickName || userInfo.nickname || user,
            avatar: userInfo.avatarThumb || userInfo.avatarMedium || (userInfo.avatarLarger || ""),
            signature: userInfo.signature || "",
            followers: userInfo.followerCount !== undefined ? userInfo.followerCount : null,
            likes: userInfo.heartCount !== undefined ? userInfo.heartCount : null,
            verified: !!userInfo.verified
          }
        : { nickname: user }
    };
    socialCacheSet(cacheKey, payload, 5 * 60 * 1000);
    return res.json({ ok: true, source: "live", user, ...payload });
  } catch (err) {
    return res.status(404).json({ ok: false, error: err.message });
  }
});

app.get("/api/tiktok/tag", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const tag = String(req.query.tag || "").replace(/^#/, "").trim();
  if (!tag || tag.length > 60) return res.status(400).json({ ok: false, error: "ハッシュタグを入力してください" });
  const cacheKey = "tt-tag:" + tag.toLowerCase();
  const cached = socialCacheGet(cacheKey);
  if (cached) return res.json({ ok: true, source: "cache", tag, videos: cached });
  try {
    const { videos } = await fetchTiktokEmbedList(`https://www.tiktok.com/embed/tag/${encodeURIComponent(tag)}`);
    if (!videos.length) throw new Error("このハッシュタグの動画が見つかりません");
    socialCacheSet(cacheKey, videos, 5 * 60 * 1000);
    return res.json({ ok: true, source: "live", tag, videos });
  } catch (err) {
    return res.status(404).json({ ok: false, error: err.message });
  }
});

app.get("/api/tiktok/item", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const raw = String(req.query.url || req.query.id || "").trim();
  if (!raw) return res.status(400).json({ ok: false, error: "TikTokのURLを入力してください" });
  let target = raw;
  if (/^\d{6,}$/.test(raw)) {
    target = "https://www.tiktok.com/@i/video/" + raw;
  } else if (!/^https?:\/\//i.test(raw)) {
    target = "https://www.tiktok.com/" + raw.replace(/^\/+/, "");
  }
  try {
    const r = await fetch(`https://www.tikwm.com/api/?url=${encodeURIComponent(target)}&hd=1`, {
      headers: { "User-Agent": TK_UA, "Accept": "application/json" },
      signal: AbortSignal.timeout(25000)
    });
    const text = await r.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch (_) {
      data = null;
    }
    if (!data || !data.data || !data.data.id) {
      // フォールバック：TikTokの動画ページ（サーバー側に埋め込まれたJSON）から直接取り出す
      const page = await fetch(target, {
        headers: {
          "User-Agent": TK_UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
        },
        redirect: "follow",
        signal: AbortSignal.timeout(20000)
      });
      const html = await page.text();
      const item = extractJsonAfter(html, "itemStruct");
      let playAddr = item && item.video ? (item.video.playAddr || null) : null;
      if (!playAddr) {
        const mm = html.match(/"playAddr":"([^"]+)"/);
        if (mm) playAddr = mm[1].replace(/\\u002F/gi, "/").replace(/\\\//g, "/");
      }
      if (!playAddr) throw new Error("動画を解決できませんでした。URLを確認してください（非公開・削除済みの可能性）");
      const v = item || {};
      return res.json({
        ok: true,
        source: "page-fallback",
        video: {
          id: (v.id && String(v.id)) || (target.match(/video\/(\d+)/) || [])[1] || "",
          desc: v.desc || "",
          cover: (v.video && (v.video.cover || v.video.originCover)) || "",
          play: playAddr,
          author: (v.author && v.author.uniqueId) || "",
          nickname: (v.author && v.author.nickname) || "",
          avatar: (v.author && v.author.avatarLarger) || (v.author && v.author.avatarThumb) || "",
          plays: v.stats ? v.stats.playCount : null,
          likes: v.stats ? v.stats.diggCount : null,
          duration: v.video ? v.video.duration : null
        }
      });
    }
    const v = data.data;
    return res.json({
      ok: true,
      video: {
        id: String(v.id),
        desc: v.title || "",
        cover: v.cover || v.origin_cover || "",
        play: v.play || v.wmplay || "",
        author: (v.author && v.author.unique_id) || "",
        nickname: (v.author && v.author.nickname) || "",
        avatar: (v.author && v.author.avatar) || "",
        plays: v.play_count || null,
        likes: v.digg_count || null,
        duration: v.duration || null
      }
    });
  } catch (err) {
    return res.status(404).json({ ok: false, error: err.message });
  }
});

// ====================================================
// 📸 Instagram ビューア用API（公式embedからメディアを取得）
// ====================================================
function deepUnescape(s) {
  let cur = s;
  for (let i = 0; i < 3; i++) {
    const next = cur
      .replace(/\\u([0-9a-fA-F]{4})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\\//g, "/")
      .replace(/\\"/g, '"');
    if (next === cur) break;
    cur = next;
  }
  return cur;
}

// embedページ内の本文は多層エスケープ（\\\\ud83e 等）なので、層がなくなるまでデコードする
function decodeEscapedText(input) {
  if (!input) return "";
  let s = String(input);
  // 先に化けたバックスラッシュを落とす（絵文字の直前に入るので、残すとサロゲートがぱらぱらになる）
  s = s.replace(/\\+(?=[^\x00-\x7F])/g, "");
  for (let i = 0; i < 5; i++) {
    const before = s;
    s = s
      .replace(/\\+u([0-9a-fA-F]{4})/g, (m, hex) => String.fromCharCode(parseInt(hex, 16)))
      .replace(/\\+n/g, "\n")
      .replace(/\\+r/g, "")
      .replace(/\\+t/g, "\t")
      .replace(/\\+\//g, "/")
      .replace(/\\+"/g, '"')
      .replace(/\\+(?=[^\x00-\x7F])/g, "");
    if (s === before) break;
  }
  return s
    .replace(/\\n/g, "\n")
    .replace(/\\/g, "")
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, "")
    .replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .replace(/\u0000/g, "")
    .trim();
}

// Instagramのキーワード別リール集（ログイン不要の公開ページ）をサーバー側で取得する
// Googlebot向けにはJSなしの完全データ（SSR JSON）が返るので、それをパースして自前のUIで描画する
function findKeyDeep(obj, key) {
  if (!obj || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    for (const v of obj) {
      const hit = findKeyDeep(v, key);
      if (hit) return hit;
    }
    return null;
  }
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const hit = findKeyDeep(v, key);
    if (hit) return hit;
  }
  return null;
}

function parseInstagramPopular(html) {
  const blocks = html.match(/<script type="application\/json"[^>]*>([\s\S]*?)<\/script>/g) || [];
  for (const block of blocks) {
    const raw = block.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (_) {
      continue;
    }
    const info = findKeyDeep(parsed, "xig_logged_out_popular_search_media_info");
    if (!info || !Array.isArray(info.edges)) continue;
    return info.edges.map((e) => {
      const n = (e && e.node) || {};
      const vv = Array.isArray(n.video_versions) ? n.video_versions : [];
      const play = vv.length ? vv[vv.length - 1].url : null;
      return {
        code: n.code || "",
        cover: n.display_uri || null,
        caption: (n.caption && n.caption.text) || "",
        author: (n.user && n.user.username) || "",
        avatar: (n.user && n.user.profile_pic_url) || null,
        verified: !!(n.user && n.user.is_verified),
        plays: typeof n.play_count === "number" ? n.play_count : null,
        likes: typeof n.like_count === "number" ? n.like_count : null,
        isVideo: !!play,
        video: play
      };
    }).filter((v) => v.code);
  }
  return [];
}

app.get("/api/instagram/popular", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const q = String(req.query.q || "").replace(/^#/, "").trim();
  if (!q) return res.status(400).json({ ok: false, error: "キーワードを入力してください" });
  const slug = q.toLowerCase().replace(/[^0-9a-z\u3040-\u30ff\u4e00-\u9fff_\- ]/g, "").replace(/\s+/g, "-");
  if (!slug) return res.status(400).json({ ok: false, error: "キーワードを入力してください" });
  const cacheKey = "ig-popular:" + slug;
  const cached = socialCacheGet(cacheKey);
  if (cached) return res.json({ ok: true, source: "cache", keyword: slug, posts: cached });
  try {
    const r = await fetch(`https://www.instagram.com/popular/${encodeURIComponent(slug)}/`, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "ja,en-US;q=0.9,en;q=0.8"
      },
      redirect: "follow",
      signal: AbortSignal.timeout(25000)
    });
    if (!r.ok) throw new Error("Instagram status " + r.status);
    const posts = parseInstagramPopular(await r.text());
    if (!posts.length) throw new Error("このキーワードのリールが見つかりませんでした");
    socialCacheSet(cacheKey, posts, 10 * 60 * 1000);
    return res.json({ ok: true, source: "live", keyword: slug, posts });
  } catch (err) {
    return res.status(502).json({ ok: false, error: err.message });
  }
});

app.get("/api/instagram/item", async (req, res) => {  res.setHeader("Access-Control-Allow-Origin", "*");
  const raw = String(req.query.url || req.query.code || "").trim();
  if (!raw) return res.status(400).json({ ok: false, error: "Instagramの投稿・リールURLを入力してください" });
  let code = raw;
  let kind = "p";
  const m = raw.match(/instagram\.com\/(?:[^/]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]{5,})/i);
  if (m) {
    kind = m[1].toLowerCase();
    code = m[2];
  } else if (/^[A-Za-z0-9_-]{5,}$/.test(raw)) {
    code = raw;
  } else {
    return res.status(400).json({ ok: false, error: "URLの形式が正しくありません" });
  }
  if (kind === "reels") kind = "reel";
  const cacheKey = "ig-item:" + kind + ":" + code;
  const cached = socialCacheGet(cacheKey);
  if (cached) return res.json({ ok: true, source: "cache", post: cached });
  const paths = kind === "reel" ? ["reel", "p"] : [kind, "reel"];
  let lastErr = null;
  for (const p of paths) {
    try {
      const url = `https://www.instagram.com/${p}/${code}/embed/captioned/`;
      const r = await fetch(url, {
        headers: {
          "User-Agent": IG_UA,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "ja,en-US;q=0.9,en;q=0.8",
          "Referer": "https://www.instagram.com/"
        },
        redirect: "follow",
        signal: AbortSignal.timeout(20000)
      });
      if (!r.ok) throw new Error("Instagram status " + r.status);
      const html = deepUnescape(await r.text());
      const grab = (re) => {
        const mm = html.match(re);
        return mm ? mm[1] : null;
      };
      const videoUrl = grab(/"video_url":"(https:[^"]+?)"/);
      const displayUrl = grab(/"display_url":"(https:[^"]+?)"/);
      const username = grab(/"owner":\{"username":"([^"]+)"/) || grab(/"username":"([^"]+)"/);
      const caption = grab(/"edge_media_to_caption":\{"edges":\[\{"node":\{"text":"([\s\S]*?)"\}\}\]\}/);
      const likes = grab(/"edge_media_preview_like":\{"count":(\d+)/) || grab(/"edge_liked_by":\{"count":(\d+)/) || grab(/"like_count":(\d+)/);
      if (!videoUrl && !displayUrl) throw new Error("メディアを取得できませんでした（非公開・削除済みの可能性）");
      const post = {
        code,
        kind,
        isVideo: !!videoUrl,
        video: videoUrl || null,
        image: displayUrl || null,
        username: username || "",
        caption: decodeEscapedText(caption || ""),
        likes: likes ? Number(likes) : null,
        url: `https://www.instagram.com/${kind === "reel" ? "reel" : "p"}/${code}/`
      };
      socialCacheSet(cacheKey, post, 10 * 60 * 1000);
      return res.json({ ok: true, source: "live", post });
    } catch (err) {
      lastErr = err;
    }
  }
  return res.status(404).json({ ok: false, error: lastErr ? lastErr.message : "取得できませんでした" });
});

// ====================================================
// ⭐ 若雪幸せTube (YouTube MP4 プレイヤー中継 & 検索)
// ====================================================
app.get("/api/tube/search", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const query = String(req.query.q || "STUTS").trim();
  if (!query) return res.json({ ok: true, videos: [] });

  try {
    const url = "https://www.youtube.com/youtubei/v1/search?prettyPrint=false";
    const payload = {
      context: {
        client: {
          clientName: "WEB",
          clientVersion: "2.20240101.00.00",
          hl: "ja",
          gl: "JP"
        }
      },
      query
    };
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(6000)
    });
    if (resp.ok) {
      const data = await resp.json();
      const contents = data?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
      const videos = [];
      for (const c of contents) {
        const items = c?.itemSectionRenderer?.contents || [];
        for (const it of items) {
          const vr = it.videoRenderer;
          if (vr && vr.videoId) {
            const thumbs = vr.thumbnail?.thumbnails || [];
            const thumb = thumbs.length > 0 ? thumbs[thumbs.length - 1].url : `https://i.ytimg.com/vi/${vr.videoId}/hqdefault.jpg`;
            videos.push({
              id: vr.videoId,
              videoId: vr.videoId,
              title: vr.title?.runs?.[0]?.text || "動画",
              author: vr.ownerText?.runs?.[0]?.text || "",
              views: vr.viewCountText?.simpleText || "",
              lengthText: vr.lengthText?.simpleText || "",
              thumbnail: thumb
            });
          }
        }
      }
      if (videos.length > 0) {
        return res.json({ ok: true, videos });
      }
    }
  } catch (err) {
    console.error("YouTube search error:", err.message);
  }

  // フォールバック
  return res.json({
    ok: true,
    videos: [
      { id: "_PHDivmHk_0", videoId: "_PHDivmHk_0", title: "STUTS - Rock The Bells feat. KMC", author: "STUTS", views: "4.7万回視聴", thumbnail: "https://i.ytimg.com/vi/_PHDivmHk_0/hqdefault.jpg" },
      { id: "m5SGc0DrenM", videoId: "m5SGc0DrenM", title: "Kaneee - Feel Missing feat. Yo-Sea", author: "Kaneee", views: "180万回視聴", thumbnail: "https://i.ytimg.com/vi/m5SGc0DrenM/hqdefault.jpg" },
      { id: "M7lc1UVf-VE", videoId: "M7lc1UVf-VE", title: "YouTube Developer Intro", author: "YouTube", views: "1000万回視聴", thumbnail: "https://i.ytimg.com/vi/M7lc1UVf-VE/hqdefault.jpg" }
    ]
  });
});

// ==========================================
// 音楽・動画ストリーミング & 学タブ（学校iPad）プロキシ
// ==========================================

// 1. 音楽ストリーミングプロキシ (Render経由・Rangeヘッダー完全対応・iOS/iPad Safari対応)
app.get("/api/music/stream", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  const targetUrl = String(req.query.url || "").trim();
  if (!targetUrl) return res.status(400).send("url parameter required");

  try {
    const range = req.headers.range;
    const fetchHeaders = {
      "User-Agent": "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
      ...(range ? { Range: range } : {})
    };
    const upstream = await fetch(targetUrl, {
      headers: fetchHeaders,
      signal: AbortSignal.timeout(15000)
    });

    res.status(upstream.status);
    for (const [k, v] of upstream.headers.entries()) {
      const lk = k.toLowerCase();
      if (["content-type", "content-length", "content-range", "accept-ranges", "cache-control"].includes(lk)) {
        if (lk === "content-type") {
          // iOS Safariのaudio/x-m4p非対応エラーを根絶し、ネイティブ再生可能なaudio/mp4へ統一
          const ct = v.toLowerCase();
          if (ct.includes("m4p") || ct.includes("m4a") || ct.includes("aac")) {
            res.setHeader("Content-Type", "audio/mp4");
          } else {
            res.setHeader(k, v);
          }
        } else {
          res.setHeader(k, v);
        }
      }
    }
    if (!res.getHeader("Accept-Ranges")) {
      res.setHeader("Accept-Ranges", "bytes");
    }

    if (!upstream.body) {
      return res.end();
    }
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    if (!res.headersSent) {
      res.status(500).send("Music stream failed: " + err.message);
    }
  }
});

// 2. 学校Educationパラメータ（Kahoot encトークン動的自動更新・学タブ完全対応）
let cachedEduParam = null;
let lastEduFetchTime = 0;

async function getLiveEduParam() {
  const now = Date.now();
  if (cachedEduParam && (now - lastEduFetchTime < 1800000)) {
    return cachedEduParam;
  }

  const sources = [
    { url: "https://raw.githubusercontent.com/toka-kun/Education/refs/heads/main/keys/key1.json", type: "json" },
    { url: "https://raw.githubusercontent.com/wakame02/wktopu/refs/heads/main/edu.text", type: "text" },
    { url: "https://raw.githubusercontent.com/siawaseok3/wakame/master/video_config.json", type: "sia" }
  ];

  for (const src of sources) {
    try {
      const resp = await fetch(src.url, {
        headers: { "User-Agent": "Mozilla/5.0" },
        signal: AbortSignal.timeout(4000)
      });
      if (!resp.ok) continue;
      let paramStr = "";
      if (src.type === "json") {
        const j = await resp.json();
        paramStr = j.result || "";
      } else if (src.type === "sia") {
        const j = await resp.json();
        paramStr = j.params || "";
      } else {
        paramStr = await resp.text();
      }
      if (paramStr && paramStr.includes("embed_config")) {
        paramStr = paramStr.replace(/&amp;/g, "&").trim();
        cachedEduParam = paramStr;
        lastEduFetchTime = now;
        return paramStr;
      }
    } catch (_) {}
  }

  const fallback = "?autoplay=1&mute=0&controls=1&start=0&origin=https%3A%2F%2Fcreate.kahoot.it&playsinline=1&showinfo=0&rel=0&iv_load_policy=3&modestbranding=1&fs=1&cc_load_policy=0&enablejsapi=1&widgetid=1&forigin=https%3A%2F%2Fcreate.kahoot.it%2Flearner%2Fcb8cb5ae-d835-4c4a-bc2d-9cc78519d646%2Fcourse%2F6fba06e3-1f76-47a8-9a4a-53c53eb86286%2F0&aoriginsup=1&vf=6&embed_config=%7B%22enc%22%3A%22AXH1ezmGkMf2FLv0BY163EhJHuZ7l-eqFdNKi-qqyyuWZ4ocVXbnfgWJAKgkE9Jn93hXkK3xo4n7q68b750DYQJ1MI07Fu_t7iQSF6CVUg5jx-oGzkIa688Nrse8VNYp8pl1JaBrLbvstbMKzRBnfm2h46Wf28CKkQ%3D%3D%22%2C%22hideTitle%22%3Afalse%7D";
  cachedEduParam = fallback;
  return fallback;
}

app.get("/api/tube/edu-param", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=1800");
  const params = await getLiveEduParam();
  res.json({ ok: true, params });
});

// 動画の先頭部分は iOS Safari が再生開始前・シーク時に何度も取りに来る。
// 毎回 Invidious まで取りに行くと、遅いインスタンスのときに「読み込みが停滞」に
// なるため、先頭1MBだけ自前でキャッシュして即返す。
const tubeHeadCache = new Map();
const TUBE_HEAD_CACHE_BYTES = 1048576;
const TUBE_HEAD_CACHE_MAX = 8;

// 3. 動画ストリームプロキシ (Range対応・Render中継)
//
// ⚠ iOS Safari は再生前に必ず `Range: bytes=0-1` を投げ、その直後に `Range: bytes=0-` を
//    投げる。以前は 0-1 の2バイトを先頭キャッシュに載せ、続く bytes=0- にもその2バイトだけを
//    206 で返していたため、Safari は「2バイトの動画」として扱い、再生を始められずに
//    `⏳ バッファリング中` のまま固まっていた（Chromium は最初から bytes=0- を投げるので
//    この経路を通らず、PC では再生できていた＝端末差の正体）。
//    キャッシュは「要求された範囲を完全に満たせるとき」だけ使い、満たせないときは
//    上流へそのまま中継する。
app.get("/api/tube/proxy-stream", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  const targetUrl = String(req.query.url || "").trim();
  if (!targetUrl) return res.status(400).send("url parameter required");

  const rangeHeader = String(req.headers.range || "").trim();
  const rangeMatch = /^bytes=(\d+)-(\d*)$/i.exec(rangeHeader);
  const rangeStart = rangeMatch ? parseInt(rangeMatch[1], 10) : -1;
  const rangeEnd = rangeMatch && rangeMatch[2] ? parseInt(rangeMatch[2], 10) : -1;

  // 先頭キャッシュは「0バイト目から始まり、かつ要求された終端まで持っている」ときだけ使う。
  // 終端が指定されない要求（bytes=0-）には絶対に短い範囲を返さない（Safari が固まる）。
  if (rangeStart === 0 && rangeEnd >= 0) {
    const hit = tubeHeadCache.get(targetUrl);
    if (hit && Date.now() - hit.time < 300000 && rangeEnd < hit.buf.length) {
      const want = rangeEnd + 1;
      res.status(206);
      res.setHeader("Content-Type", hit.contentType);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Content-Range", `bytes 0-${want - 1}/${hit.total}`);
      res.setHeader("Content-Length", String(want));
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.end(hit.buf.subarray(0, want));
    }
  }

  // クライアントが切れたら上流の取得も止める（放置すると接続が枯れて
  // 後続の Range 要求が詰まり、映像だけ固まる原因になる）
  const ac = new AbortController();
  res.on("close", () => {
    try { ac.abort(); } catch (_) {}
  });

  try {
    const fetchHeaders = {
      "User-Agent": "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15",
      "Referer": "https://www.youtube.com/",
      ...(rangeHeader ? { Range: rangeHeader } : {})
    };
    let upstream = await fetch(targetUrl, {
      headers: fetchHeaders,
      signal: ac.signal
    });
    // Invidious経由のURLは時々 403/410 を返す（発行元の一時的な制限）。
    // その1回で「Format error」にしないよう、少し待って同じURLを引き直す。
    if ([403, 410, 429, 502, 503].includes(upstream.status)) {
      try {
        await new Promise((r) => setTimeout(r, 500));
        upstream = await fetch(targetUrl, { headers: fetchHeaders, signal: ac.signal });
      } catch (_) {}
    }

    const ct = String(upstream.headers.get("content-type") || "video/mp4");
    const clen = parseInt(String(upstream.headers.get("content-length") || "0"), 10) || 0;
    const upstreamRangeHeader = upstream.headers.get("content-range") || "";
    const upstreamRanges = upstream.status === 206 || !!upstream.headers.get("accept-ranges");

    // 先頭部分（1MB以内）は読み切ってキャッシュに載せる
    const bufferable =
      rangeStart === 0 &&
      upstream.ok &&
      !!upstream.body &&
      rangeEnd >= 0 &&
      rangeEnd + 1 <= TUBE_HEAD_CACHE_BYTES &&
      (upstream.status === 206 || (clen > 0 && clen <= TUBE_HEAD_CACHE_BYTES));

    if (bufferable) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      const totalMatch = /\/(\d+)\s*$/.exec(upstreamRangeHeader);
      const total = totalMatch ? parseInt(totalMatch[1], 10) : clen;
      // キャッシュに載せるのは「十分に大きい先頭ブロック」だけ。
      // 2バイトのプローブを載せると、次の bytes=0- に 2 バイトしか返せなくなる。
      if (total > buf.length && buf.length >= 65536) {
        tubeHeadCache.set(targetUrl, { time: Date.now(), buf, total, contentType: ct });
        while (tubeHeadCache.size > TUBE_HEAD_CACHE_MAX) {
          tubeHeadCache.delete(tubeHeadCache.keys().next().value);
        }
      }
      // total が不明（Content-Range も Content-Length も無い）ときは 206 を組み立てず
      // 上流の応答をそのまま流す（Content-Range の無い 206 は iOS で再生できない）。
      if (total <= 0) {
        res.status(upstream.status);
        for (const [k, v] of upstream.headers.entries()) {
          if (["content-type", "content-length", "content-range", "accept-ranges", "cache-control"].includes(k.toLowerCase())) {
            res.setHeader(k, v);
          }
        }
        return res.end(buf);
      }
      res.status(206);
      res.setHeader("Content-Type", ct);
      res.setHeader("Accept-Ranges", "bytes");
      if (total > 0) res.setHeader("Content-Range", `bytes 0-${buf.length - 1}/${total}`);
      res.setHeader("Content-Length", String(buf.length));
      res.setHeader("Cache-Control", "public, max-age=300");
      return res.end(buf);
    }

    res.status(upstream.status);
    for (const [k, v] of upstream.headers.entries()) {
      const lk = k.toLowerCase();
      if (["content-type", "content-length", "content-range", "accept-ranges", "cache-control"].includes(lk)) {
        res.setHeader(k, v);
      }
    }
    // ⚠ 上流が Range を無視して 200 を返したときに「Accept-Ranges: bytes」を
    // 名乗ると、iOS Safari は 206 が来る前提で待ち続け、映像が固まる。
    // 実際に対応しているときだけ名乗る。
    if (upstreamRanges) res.setHeader("Accept-Ranges", "bytes");
    if (!upstream.body) return res.end();

    const stream = Readable.fromWeb(upstream.body);
    // 途中で上流が切れてもサーバーごと落ちないようにする（落ちると全員の再生が止まる）
    stream.on("error", () => { try { res.end(); } catch (_) {} });
    res.on("error", () => { try { stream.destroy(); } catch (_) {} });
    stream.pipe(res);
  } catch (err) {
    if (ac.signal.aborted) return;
    if (!res.headersSent) res.status(500).send("Video stream error: " + err.message);
  }
});

// 4. サムネイル中継 (i.ytimg.com ブロック回避)
app.get("/api/tube/thumb", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "public, max-age=86400");
  const videoId = String(req.query.v || "").trim();
  if (!videoId) return res.status(400).send("v required");

  try {
    const upstream = await fetch(`https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(5000)
    });
    if (upstream.ok && upstream.body) {
      res.setHeader("Content-Type", "image/jpeg");
      return Readable.fromWeb(upstream.body).pipe(res);
    }
  } catch (_) {}
  // 代替ホスト（img.youtube.com は別CDN）をサーバー側で取りに行く
  try {
    const alt = await fetch(`https://img.youtube.com/vi/${videoId}/hqdefault.jpg`, {
      headers: { "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(5000)
    });
    if (alt.ok && alt.body) {
      res.setHeader("Content-Type", "image/jpeg");
      return Readable.fromWeb(alt.body).pipe(res);
    }
  } catch (_) {}
  // ⚠ 外部（i.ytimg.com 等）へ 302 リダイレクトしない。学校iPadのフィルターは
  // 「外部ドメインへ取りに行った」時点でフィルター画面を出すため、サムネイル1枚でも
  // 外へ出さず、自ドメインのプレースホルダー画像を返す。
  res.setHeader("Content-Type", "image/svg+xml; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=300");
  return res.send(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="270" viewBox="0 0 480 270"><rect width="480" height="270" fill="#0f172a"/><circle cx="240" cy="118" r="34" fill="#0284c7"/><path d="M229 100l26 18-26 18z" fill="#fff"/><text x="240" y="186" fill="#38bdf8" font-family="-apple-system,sans-serif" font-size="20" text-anchor="middle">若雪幸せTube</text></svg>`);
});

const streamInfoCache = new Map();
// 直近で動画情報を返せたInvidiousインスタンス。次の検索ではここを先に試す。
let tubeWorkingHost = "";
let tubeMuxedHost = "";

// Invidious 1インスタンスから動画フォーマットを取得し、再生に使う1本を選ぶ。
// 返り値: { host, muxed, videoUrl, audioUrl, quality, title, author, duration, hlsUrl } | null
async function fetchInvidiousInfo(host, videoId, timeoutMs = 6000) {
  try {
    // local=true: 動画URLをインスタンス自身のプロキシで返させる
    // （googlevideo 直リンクは PO Token 必須で 403 になるため）。
    const apiUrl = `https://${host}/api/v1/videos/${videoId}?local=true`;
    const reqHeaders = { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15" };
    let invResp = await fetch(apiUrl, { headers: reqHeaders, signal: AbortSignal.timeout(timeoutMs) });
    // インスタンスは一時的に 429/500/503 を返すことがある（＝「たまに再生できない」の正体）。
    // 1回だけ間を置いて引き直す。
    if ([401, 403, 404, 429, 500, 502, 503, 504].includes(invResp.status)) {
      try {
        await new Promise((r) => setTimeout(r, 400));
        invResp = await fetch(apiUrl, { headers: reqHeaders, signal: AbortSignal.timeout(timeoutMs) });
      } catch (_) {}
    }
    if (!invResp.ok) return null;
    const invData = await invResp.json();
    if (!invData || invData.error) return null;

    const abs = (u) => {
      if (!u || typeof u !== "string") return "";
      if (/^https?:\/\//i.test(u)) return u;
      return `https://${host}` + (u.startsWith("/") ? u : "/" + u);
    };
    const norm = (list) => (Array.isArray(list) ? list.map((f) => (f && f.url ? { ...f, url: abs(f.url) } : f)) : []);
    const formatStreams = norm(invData.formatStreams);
    const adaptive = norm(invData.adaptiveFormats);

    // iOS Safari が確実に再生できるのは H.264(+AAC) の MP4 だけ。
    // VP9 / AV1 / HEVC / Dolby Vision は音声だけ鳴って映像が出ない原因になるので除外。
    const compatible = (f) =>
      f &&
      f.url &&
      typeof f.type === "string" &&
      f.type.includes("video/mp4") &&
      !/\b(vp0?9|av0?1|hev1|hvc1|dvh1|dvhe)\b/i.test(f.type);

    // 画質の好み：まず「確実に再生できる」ことを優先して 360p から。
    // 高画質ほど帯域を食い、Render 中継では詰まりやすい（＝映像が止まる原因）。
    const QUALITY_ORDER = ["360p", "480p", "720p", "240p", "144p", "1080p"];
    const pick = (list) => {
      if (!list || !list.length) return null;
      for (const q of QUALITY_ORDER) {
        const f = list.find((x) => x.qualityLabel === q);
        if (f) return f;
      }
      return list[0];
    };

    const muxedList = formatStreams.filter(compatible);
    let chosen = null;
    if (muxedList.length > 0) {
      const video = pick(muxedList);
      chosen = { muxed: true, video, audio: null };
    } else {
      const video = pick(adaptive.filter(compatible));
      if (!video) return null;
      // 音声は AAC(mp4a) の mp4 を優先（Opus は iOS で再生できない）
      const audio =
        adaptive.find((f) => f && f.url && /^audio\/mp4/i.test(f.type) && /mp4a/i.test(f.type)) ||
        adaptive.find((f) => f && f.url && /^audio\/mp4/i.test(f.type)) ||
        null;
      chosen = { muxed: false, video, audio };
    }

    return {
      host,
      muxed: !!chosen.muxed,
      videoUrl: chosen.video.url,
      audioUrl: chosen.audio ? chosen.audio.url : "",
      quality: chosen.video.qualityLabel || "",
      title: invData.title || "動画",
      author: invData.author || "",
      duration: invData.lengthSeconds || 180,
      hlsUrl: invData.hlsUrl || ""
    };
  } catch (_) {
    return null;
  }
}

// 最後の手段：Invidious の /latest_version は「音声込みの1本(既定 itag18)」を
// インスタンス自身が返す。formatStreams が空のインスタンス（例: chocolatemoo53）でも
// これが通れば muxed 再生できる。
// 返されたURLが本当に再生できるか、先頭1KBだけ取って確認する。
// 「たまに再生できる」＝壊れたURLを返すインスタンスに当たっている状態なので、
// 再生できないURLは捨てて次のホストを試す。
async function probePlayableMedia(url) {
  if (!url) return false;
  try {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15",
        Range: "bytes=0-1023"
      },
      signal: AbortSignal.timeout(3000)
    });
    if (!resp.ok) return false;
    const ct = String(resp.headers.get("content-type") || "");
    if (!ct.includes("video/mp4") && !ct.includes("audio/mp4")) return false;
    const buf = Buffer.from(await resp.arrayBuffer());
    if (buf.length < 12) return false;
    const brand = buf.subarray(4, 8).toString("latin1");
    const playable = brand.includes("ftyp") || brand === "styp";
    // 検証で読んだ先頭データをキャッシュしておく。
    // iOS Safari は再生前に必ず Range: bytes=0-1 を投げ、この往復に上流の待ち時間が
    // そのまま出る（ホストによっては10〜20秒）ので、ここで先回りして即答できるようにする。
    if (playable && /^video\/mp4/i.test(ct)) {
      const cr = String(resp.headers.get("content-range") || "");
      const m = /\/(\d+)\s*$/.exec(cr);
      const total = m ? parseInt(m[1], 10) : parseInt(String(resp.headers.get("content-length") || "0"), 10) || 0;
      if (total > buf.length) {
        tubeHeadCache.set(url, { time: Date.now(), buf, total, contentType: "video/mp4" });
        while (tubeHeadCache.size > TUBE_HEAD_CACHE_MAX) {
          tubeHeadCache.delete(tubeHeadCache.keys().next().value);
        }
      }
    }
    return playable;
  } catch (_) {
    return false;
  }
}

async function tryLatestVersionMuxed(host, videoId) {
  try {
    const target = `https://${host}/latest_version?id=${videoId}&itag=18&local=true`;
    const resp = await fetch(target, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15",
        Range: "bytes=0-1"
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!resp.ok) return "";
    const ct = String(resp.headers.get("content-type") || "");
    if (!ct.includes("video/mp4")) return "";
    const buf = Buffer.from(await resp.arrayBuffer());
    // 先頭が ftyp で始まっていなければ動画ではない
    if (buf.length < 12 || !buf.slice(4, 8).toString("latin1").includes("ftyp")) return "";
    // リダイレクト後の実URL（/companion/videoplayback?...）を中継対象にする
    return resp.url || target;
  } catch (_) {
    return "";
  }
}


app.get("/api/tube/stream-info", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  // Signed media URLs expire; keep both server and browser caches short.
  res.setHeader("Cache-Control", "public, max-age=300");
  let videoId = String(req.query.v || "").trim();
  const searchQuery = String(req.query.q || "").trim();

  if (!videoId && searchQuery) {
    try {
      const sUrl = "https://www.youtube.com/youtubei/v1/search?prettyPrint=false";
      const sResp = await fetch(sUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": "Mozilla/5.0" },
        body: JSON.stringify({
          context: { client: { clientName: "WEB", clientVersion: "2.20240101.00.00", hl: "ja", gl: "JP" } },
          query: searchQuery
        }),
        signal: AbortSignal.timeout(5000)
      });
      if (sResp.ok) {
        const sData = await sResp.json();
        const contents = sData?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
        for (const c of contents) {
          const items = c?.itemSectionRenderer?.contents || [];
          for (const it of items) {
            if (it.videoRenderer?.videoId) {
              videoId = it.videoRenderer.videoId;
              break;
            }
          }
          if (videoId) break;
        }
      }
    } catch (_) {}
  }

  if (!videoId) {
    return res.status(400).json({ ok: false, error: "videoId or query required" });
  }

  const eduParams = cachedEduParam || "";
  const eduEmbedUrl = `https://www.youtubeeducation.com/embed/${videoId}${eduParams}${eduParams ? "&" : "?"}playlist=${videoId}`;

  // ⚠ iPhone Safari は「映像だけのストリーム（DASH）」＋「別要素の音声」という
  //    2要素再生がとても不安定で、音だけ鳴って映像が出ないまま waiting/stalled に
  //    なることがある。だから「音声込みの1本（progressive MP4 / itag18 等）」を
  //    最優先で取る。muxed が取れたときは <video> 1個で完結する。
  const cacheEntry = streamInfoCache.get(videoId);
  const wantsRefresh = String(req.query.refresh || "") === "1";
  if (cacheEntry && !wantsRefresh) {
    const ttl = cacheEntry.data && cacheEntry.data.muxed ? 600000 : 60000;
    if (Date.now() - cacheEntry.time < ttl) {
      return res.json({ ok: true, eduEmbedUrl, ...cacheEntry.data });
    }
  }

  const INV_HOSTS = [
    "echostreamz.com",
    "yt.chocolatemoo53.com",
    "invidious.nerdvpn.de",
    "inv.nadeko.net",
    "invidious.tiekoetter.com",
    "iv.melmac.space",
    "invidious.privacydev.net",
    "yewtu.be"
  ];
  // muxed を返せたホスト → 通常のホスト の順に先頭へ。
  const hostOrder = [];
  for (const h of [tubeMuxedHost, tubeWorkingHost, ...INV_HOSTS]) {
    if (h && !hostOrder.includes(h)) hostOrder.push(h);
  }

  const buildResult = (info) => {
    const proxiedVideoUrl = `/api/tube/proxy-stream?url=${encodeURIComponent(info.videoUrl)}`;
    const proxiedAudioUrl = info.audioUrl ? `/api/tube/proxy-stream?url=${encodeURIComponent(info.audioUrl)}` : "";
    const musicSourceUrl = info.audioUrl || info.videoUrl;
    const proxiedMusicUrl = `/api/tube/proxy-stream?url=${encodeURIComponent(musicSourceUrl)}`;
    return {
      videoId,
      title: info.title || "動画",
      author: info.author || "",
      duration: info.duration || 180,
      muxed: !!info.muxed,
      videoOnly: !info.muxed && !!info.audioUrl,
      noAudio: !!info.noAudio,
      quality: info.quality || "",
      sourceHost: info.host,
      videoUrl: proxiedVideoUrl,
      audioUrl: proxiedAudioUrl,
      musicUrl: proxiedMusicUrl,
      rawVideoUrl: info.videoUrl,
      rawAudioUrl: info.audioUrl || "",
      eduEmbedUrl,
      hlsUrl: info.hlsUrl || "",
      thumbnail: `/api/tube/thumb?v=${videoId}`
    };
  };

  const finish = (info) => {
    if (info.muxed) {
      tubeMuxedHost = info.host;
      tubeWorkingHost = info.host;
    } else {
      tubeWorkingHost = info.host;
    }
    const resultData = buildResult(info);
    streamInfoCache.set(videoId, { time: Date.now(), data: resultData });
    return res.json({ ok: true, ...resultData });
  };

  // 1ホストぶん：フォーマット取得＋実際に先頭が取れるかの確認
  const probeHost = async (host) => {
    const info = await fetchInvidiousInfo(host, videoId, 5000);
    if (!info) return null;
    const [videoOk, audioOk] = await Promise.all([
      probePlayableMedia(info.videoUrl),
      info.audioUrl ? probePlayableMedia(info.audioUrl) : Promise.resolve(true)
    ]);
    return { ...info, videoOk, audioOk };
  };

  const deadline = Date.now() + 18000;
  let bestAdaptive = null;
  let bestVideoOnly = null; // 映像は取れるが音声が取れない候補（最後の手段）

  // インスタンスは「たまに」失敗する（404/500/403）。順番に待つと遅いので並列に試し、
  // 音声込みの1本が見つかった時点で返す（遅いホストを待たない）。
  const runBatch = (batch) => new Promise((resolve) => {
    const results = new Array(batch.length).fill(null);
    let left = batch.length;
    let winner = null;
    let settled = false;
    const finishBatch = () => {
      if (settled) return;
      settled = true;
      resolve({ winner, results });
    };
    batch.forEach((h, i) => {
      probeHost(h)
        .then((r) => {
          results[i] = r;
          if (r && r.muxed && r.videoOk && r.audioOk && !winner) {
            winner = r;
            finishBatch();
            return;
          }
          if (--left === 0) finishBatch();
        })
        .catch(() => {
          if (--left === 0) finishBatch();
        });
    });
    if (!batch.length) finishBatch();
  });

  const batches = [hostOrder.slice(0, 3), hostOrder.slice(3, 6)];
  for (const batch of batches) {
    if (!batch.length || Date.now() > deadline) break;
    const { winner, results } = await runBatch(batch);
    if (winner) return finish(winner);
    for (const r of results) {
      if (r && r.videoOk && r.audioOk && !bestAdaptive) bestAdaptive = r;
      if (r && r.videoOk && !r.audioOk && !bestVideoOnly) bestVideoOnly = r;
    }
    if (bestAdaptive && Date.now() > deadline - 6000) break;
  }

  // 音声込み1本がどのホストの一覧にも無い（or 一覧のURLが壊れている）場合の最後の手段。
  // /latest_version・itag18 はインスタンス自身が返すので、これが通れば muxed 再生できる。
  if (Date.now() < deadline) {
    const muxedHosts = [];
    for (const h of [tubeMuxedHost, "echostreamz.com", ...hostOrder]) {
      if (h && !muxedHosts.includes(h)) muxedHosts.push(h);
    }
    for (const h of muxedHosts) {
      if (Date.now() > deadline) break;
      const muxedUrl = await tryLatestVersionMuxed(h, videoId);
      if (muxedUrl) {
        return finish({ ...(bestAdaptive || {}), host: h, muxed: true, videoUrl: muxedUrl, audioUrl: "", quality: "360p" });
      }
    }
  }

  if (bestAdaptive) return finish(bestAdaptive);

  // ここまで全滅：インスタンス側の一時的な失敗であることが多いので、
  // 少し待って先頭バッチ（音声込みを返すホスト）をもう一度だけ試す。
  if (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 400));
    const retryResults = await Promise.all(hostOrder.slice(0, 3).map((h) => probeHost(h).catch(() => null)));
    const retryMuxed = retryResults.find((r) => r && r.muxed && r.videoOk && r.audioOk);
    if (retryMuxed) return finish(retryMuxed);
    for (const r of retryResults) {
      if (r && r.videoOk && r.audioOk) return finish(r);
      if (r && r.videoOk) return finish(r);
    }
  }

  // 音声がどうしても取れない場合でも、映像が出るならそちらを返す
  // （無音でも「真っ白な失敗画面」よりは見られる）。
  if (bestVideoOnly) {
    return finish({ ...bestVideoOnly, audioUrl: "", noAudio: true });
  }

  // 全部だめでも、直前に返せていたストリームURLがあればそれを使う
  // （署名URLは数時間有効。真っ白な失敗画面より再生できたほうがよい）。
  if (cacheEntry && cacheEntry.data && cacheEntry.data.videoUrl) {
    return res.json({ ok: true, stale: true, eduEmbedUrl, ...cacheEntry.data });
  }

  return res.json({
    ok: true,
    videoId,
    title: "動画",
    duration: 180,
    videoUrl: "",
    audioUrl: "",
    eduEmbedUrl,
    embedUrl: `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&playsinline=1`,
    thumbnail: `/api/tube/thumb?v=${videoId}`
  });
});

// 2.5 再生の入口（iOS Safari のユーザー操作権を失わないための302ゲート）
//
// iPhone Safari は「タップと同じタスク内に呼んだ video.play()」しか許可しない。
// 画面側で await fetch('/api/tube/stream-info') を挟んでから src を入れると、その間に
// 操作権が失効し、play() が NotAllowedError になって `バッファリング中` のまま止まる。
// そこで <video src="/api/tube/play?v=..."> にしておき、このエンドポイントがURLを解決して
// 同じドメインの proxy-stream へ 302 で回す（外部ドメインへは出ない）。
app.get("/api/tube/play", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  const videoId = String(req.query.v || "").trim();
  const wantsRefresh = String(req.query.refresh || "") === "1";
  if (!videoId) return res.status(400).send("v required");

  // リダイレクト先は絶対URLで返す（AVFoundation が相対 Location を扱わない場合の保険）
  const host = String(req.get("host") || "");
  const ownOrigin = host ? `${/^(localhost|127\.|0\.0\.0\.0)/.test(host) ? String(req.protocol) : "https"}://${host}` : "";
  const toStream = (rawUrl) => `${ownOrigin}/api/tube/proxy-stream?url=${encodeURIComponent(rawUrl)}`;

  const cached = streamInfoCache.get(videoId);
  if (!wantsRefresh && cached && cached.data && cached.data.rawVideoUrl) {
    return res.redirect(302, toStream(cached.data.rawVideoUrl));
  }
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/tube/stream-info?v=${encodeURIComponent(videoId)}${wantsRefresh ? "&refresh=1" : ""}`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(20000)
    });
    const d = await r.json();
    if (d && d.rawVideoUrl) {
      return res.redirect(302, toStream(d.rawVideoUrl));
    }
  } catch (_) {}
  // 解決できなかった → <video> の error を発火させ、画面側が案内を出す
  return res.status(502).send("stream unavailable");
});

app.get("/api/tube/stream", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const videoId = String(req.query.v || "").trim();
  if (!videoId) return res.status(400).send("Video ID required");
  // ⚠ 外部（youtubeeducation.com）へ飛ばさない。学校iPadのフィルターで止められ、
  // フィルター画面に遷移してしまうため、自ドメイン内のプレイヤーへ回す。
  return res.redirect(`/tube/embed.html?v=${encodeURIComponent(videoId)}`);
});

// 5. 各種YouTube代替ミラー中継（しあTube、わかめTube、YukiTube、YouTube＋）
app.get("/api/tube/mirror/:service", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const service = String(req.params.service || "shiatube").toLowerCase();
  const videoId = String(req.query.v || "_PHDivmHk_0").trim();

  const themes = {
    shiatube: {
      name: "しあTube (SiaTube)",
      icon: "⚡",
      color: "#38bdf8",
      bg: "#0b1329",
      accent: "#0284c7",
      desc: "学校i-フィルター完全回避・しあTube中継プレイヤー",
      externalUrl: `https://script.google.com/macros/s/AKfycbzA0pSEaCuLy0I7sZnZdvLKHCgcGbSCPbVLNVLxkj8aWWKMrHpsEDBGcx-cOhk4jwP2/exec?v=${videoId}`
    },
    wakametube: {
      name: "わかめTube (wkt-Plus)",
      icon: "🥬",
      color: "#10b981",
      bg: "#062817",
      accent: "#059669",
      desc: "wakame02 わかめtube Plus MP4ストリームプレイヤー",
      externalUrl: `https://wkt-hkg4.onrender.com/wkt/watch?v=${videoId}`
    },
    yukitube: {
      name: "YukiTube (雪Tube)",
      icon: "❄️",
      color: "#a78bfa",
      bg: "#160b2b",
      accent: "#7c3aed",
      desc: "Yuki-YouTube ステルス動画プレイヤー",
      externalUrl: `https://yuki-youtube.onrender.com/watch?v=${videoId}`
    },
    youtubeplus: {
      name: "YouTube Plus+ (YT++)",
      icon: "➕",
      color: "#ef4444",
      bg: "#2b0b0b",
      accent: "#dc2626",
      desc: "YouTube Plus+ アンブロック動画プレイヤー",
      externalUrl: `https://youtube-plus-plus.vercel.app/watch?v=${videoId}`
    }
  };

  const currentTheme = themes[service] || themes.shiatube;
  // 学校iPad向けEducation埋め込みURL（以前は未定義のまま参照していて500になっていた）
  let eduPassParams = "";
  try {
    eduPassParams = (await getLiveEduParam()) || "";
  } catch (_) {
    eduPassParams = "";
  }
  const eduEmbedUrl = `https://www.youtubeeducation.com/embed/${videoId}${eduPassParams}${eduPassParams ? "&" : "?"}playlist=${videoId}`;
  const serviceEmbeds = {
    shiatube: `https://piped.video/embed/${videoId}`,
    wakametube: `https://inv.nadeko.net/embed/${videoId}`,
    yukitube: `https://yewtu.be/embed/${videoId}`,
    youtubeplus: `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&playsinline=1&rel=0`
  };
  const defaultEmbedRaw = serviceEmbeds[service] || `https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&playsinline=1&rel=0`;
  // 埋め込みは必ず自ドメイン（/api/proxy）経由で読む。
  // 学校iPadのフィルターは youtube-nocookie / piped / yewtu などの外部ドメイン自体を
  // 止めてしまうため、iframe の src を外部URLにするとフィルター画面へ飛ばされる。
  const proxiedEmbed = (u) => `/api/proxy?url=${encodeURIComponent(u)}`;
  const defaultEmbedSrc = proxiedEmbed(defaultEmbedRaw);
  // iframe からトップページを書き換えさせない（学校フィルター等の外部画面へ飛ばす妨害）
  const FRAME_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-presentation allow-modals";

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${currentTheme.icon} ${currentTheme.name} · アンブロックプレイヤー</title>
  <meta name="referrer" content="no-referrer">
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: ${currentTheme.bg}; color: #fff; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
    .header { height: 42px; background: rgba(0,0,0,0.85); backdrop-filter: blur(10px); display: flex; align-items: center; justify-content: space-between; padding: 0 14px; border-bottom: 1px solid rgba(255,255,255,0.1); font-size: 13px; z-index: 10; }
    .header-title { font-weight: bold; color: ${currentTheme.color}; display: flex; align-items: center; gap: 6px; }
    .btn-group { display: flex; gap: 6px; align-items: center; }
    .head-btn { background: rgba(255,255,255,0.12); color: #fff; text-decoration: none; border: 0; border-radius: 6px; padding: 5px 10px; font-size: 11px; font-weight: 600; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
    .head-btn:hover { background: rgba(255,255,255,0.22); }
    .player-container { flex: 1; width: 100%; height: 100%; position: relative; background: #000; display: flex; align-items: center; justify-content: center; }
    iframe { width: 100%; height: 100%; border: none; }
    .notice-bar { padding: 10px 14px; background: rgba(0,0,0,0.85); display: flex; justify-content: space-between; align-items: center; font-size: 12px; color: #94a3b8; border-top: 1px solid rgba(255,255,255,0.08); }
    .ext-btn { background: ${currentTheme.accent}; color: #fff; text-decoration: none; border-radius: 8px; padding: 6px 14px; font-weight: bold; font-size: 12px; }
  </style>
</head>
<body>
  <div class="header">
    <div class="header-title">
      <span>${currentTheme.icon}</span>
      <span>${currentTheme.name}</span>
      <span style="font-size:10px; background:rgba(255,255,255,0.15); padding:2px 6px; border-radius:4px; margin-left:4px;">アンブロック中継</span>
    </div>
    <div class="btn-group">
      <a href="/tube/?v=${videoId}" class="head-btn">📺 若雪Tube</a>
      <button onclick="switchMode('edu')" class="head-btn" style="background:#0284c7;">🎓 教育モード</button>
      <button onclick="switchMode('mirror')" class="head-btn" style="background:${currentTheme.accent};">🚀 ミラー切替</button>
      <a href="${currentTheme.externalUrl}" target="_blank" rel="noopener" class="head-btn">別タブ直通</a>
      <button onclick="toggleFullscreen()" class="head-btn">⛶ 全画面</button>
      <button onclick="parent.toggleStealth ? parent.toggleStealth() : window.location.href='https://www.google.com'" class="head-btn" style="background:#dc2626;">🚨</button>
    </div>
  </div>
  <div class="player-container">
    <iframe id="mainPlayerFrame" src="${defaultEmbedSrc}" sandbox="${FRAME_SANDBOX}" allow="autoplay; fullscreen; encrypted-media; picture-in-picture; accelerometer; gyroscope"></iframe>
  </div>
  <div class="notice-bar">
    <div>${currentTheme.desc} · 🛡️ i-フィルター@cloud完全回避</div>
    <a href="${currentTheme.externalUrl}" target="_blank" rel="noopener" class="ext-btn">🌐 本家サイトで開く</a>
  </div>
  <script>
    const eduSrc = "${proxiedEmbed(eduEmbedUrl)}";
    const mirrorSrc = "${proxiedEmbed(currentTheme.externalUrl)}";
    let currentIsEdu = ${proxiedEmbed(defaultEmbedRaw) === proxiedEmbed(eduEmbedUrl) ? "true" : "false"};

    function switchMode(m) {
      const f = document.getElementById("mainPlayerFrame");
      if (m === 'edu') {
        f.src = eduSrc;
        currentIsEdu = true;
      } else {
        f.src = mirrorSrc;
        currentIsEdu = false;
      }
    }

    function toggleFullscreen() {
      const f = document.getElementById("mainPlayerFrame");
      if (f.requestFullscreen) f.requestFullscreen().catch(()=>{});
      else if (f.webkitRequestFullscreen) f.webkitRequestFullscreen();
    }
  </script>
</body>
</html>`;

  res.setHeader("Content-Type", "text/html; charset=utf-8");
  return res.send(html);
});

// ====================================================
// 📬 捨てメアド (インスタ・TikTok登録用 臨時メールAPI)
// ====================================================
app.post("/api/tempmail/create", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");

  // 1. まず Mail.tm を試行
  try {
    const domRes = await fetch("https://api.mail.tm/domains", { signal: AbortSignal.timeout(4000) });
    if (domRes.ok) {
      const domData = await domRes.json();
      const domains = (domData["hydra:member"] || []).filter(d => d.isActive).map(d => d.domain);
      if (domains.length > 0) {
        const domain = domains[0];
        const randId = Math.random().toString(36).substring(2, 9) + Math.floor(Math.random() * 900 + 100);
        const address = `user_${randId}@${domain}`;
        const password = "Pass_" + Math.random().toString(36).substring(2, 10);

        const accRes = await fetch("https://api.mail.tm/accounts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ address, password }),
          signal: AbortSignal.timeout(4000)
        });

        if (accRes.ok) {
          const accData = await accRes.json();
          const tokRes = await fetch("https://api.mail.tm/token", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ address, password }),
            signal: AbortSignal.timeout(4000)
          });
          if (tokRes.ok) {
            const tokData = await tokRes.json();
            return res.json({
              ok: true,
              provider: "mailtm",
              email: address,
              token: tokData.token,
              id: accData.id
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn("Mail.tm fallback to GuerrillaMail:", err.message);
  }

  // 2. フォールバック: GuerrillaMail (即時発行・レート制限なし)
  try {
    const gRes = await fetch("https://api.guerrillamail.com/ajax.php?f=get_email_address", {
      headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" },
      signal: AbortSignal.timeout(4000)
    });
    if (gRes.ok) {
      const gData = await gRes.json();
      return res.json({
        ok: true,
        provider: "guerrilla",
        email: gData.email_addr,
        token: gData.sid_token,
        id: gData.alias
      });
    }
  } catch (gErr) {
    console.error("GuerrillaMail error:", gErr.message);
  }

  return res.status(500).json({ ok: false, error: "メアド発行サービスが混雑しています。数秒後に再試行してください。" });
});

app.get("/api/tempmail/messages", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const token = req.query.token;
  const provider = req.query.provider || (token && token.length > 50 ? "mailtm" : "guerrilla");
  if (!token) return res.status(400).json({ ok: false, error: "トークンが必要です" });

  try {
    if (provider === "guerrilla") {
      const gRes = await fetch(`https://api.guerrillamail.com/ajax.php?f=check_email&seq=0&sid_token=${encodeURIComponent(token)}`, {
        headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" },
        signal: AbortSignal.timeout(5000)
      });
      if (!gRes.ok) throw new Error("Guerrilla check_email failed");
      const gData = await gRes.json();
      const list = (gData.list || []).map(m => {
        const combined = `${m.mail_subject || ""} ${m.mail_excerpt || ""}`;
        const codeMatch = combined.match(/(?:コード|code|verification|認証|pin)[\s:：#\-_]*([0-9]{4,8})/i) ||
                          combined.match(/\b([0-9]{6})\b/) ||
                          combined.match(/\b([0-9]{4,8})\b/);
        return {
          id: String(m.mail_id),
          from: m.mail_from || "不明",
          subject: m.mail_subject || "（件名なし）",
          intro: m.mail_excerpt || "",
          createdAt: m.mail_timestamp ? new Date(m.mail_timestamp * 1000).toISOString() : new Date().toISOString(),
          code: codeMatch ? codeMatch[1] : null
        };
      });
      return res.json({ ok: true, messages: list, total: list.length });
    } else {
      const msgRes = await fetch("https://api.mail.tm/messages", {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000)
      });
      if (!msgRes.ok) throw new Error("Mail.tm messages failed");
      const msgData = await msgRes.json();
      const list = (msgData["hydra:member"] || []).map(m => {
        const combined = `${m.subject || ""} ${m.intro || ""}`;
        const codeMatch = combined.match(/(?:コード|code|verification|認証|pin)[\s:：#\-_]*([0-9]{4,8})/i) ||
                          combined.match(/\b([0-9]{6})\b/) ||
                          combined.match(/\b([0-9]{4,8})\b/);
        return {
          id: m.id,
          from: m.from ? (m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address) : "不明",
          subject: m.subject || "（件名なし）",
          intro: m.intro || "",
          createdAt: m.createdAt,
          code: codeMatch ? codeMatch[1] : null
        };
      });
      return res.json({ ok: true, messages: list, total: list.length });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get("/api/tempmail/messages/:id", async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  const token = req.query.token;
  const msgId = req.params.id;
  const provider = req.query.provider || (token && token.length > 50 ? "mailtm" : "guerrilla");
  if (!token || !msgId) return res.status(400).json({ ok: false, error: "パラメータが不足しています" });

  try {
    if (provider === "guerrilla") {
      const gRes = await fetch(`https://api.guerrillamail.com/ajax.php?f=fetch_email&email_id=${encodeURIComponent(msgId)}&sid_token=${encodeURIComponent(token)}`, {
        headers: { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)" },
        signal: AbortSignal.timeout(5000)
      });
      if (!gRes.ok) throw new Error("Guerrilla fetch_email failed");
      const m = await gRes.json();
      const combined = `${m.mail_subject || ""} ${m.mail_body || ""}`;
      const codeMatch = combined.match(/(?:コード|code|verification|認証|pin)[\s:：#\-_]*([0-9]{4,8})/i) ||
                        combined.match(/\b([0-9]{6})\b/) ||
                        combined.match(/\b([0-9]{4,8})\b/);
      return res.json({
        ok: true,
        message: {
          id: String(m.mail_id),
          from: m.mail_from || "不明",
          subject: m.mail_subject || "（件名なし）",
          intro: m.mail_excerpt || "",
          text: m.mail_body || "",
          html: m.mail_body || "",
          createdAt: m.mail_timestamp ? new Date(m.mail_timestamp * 1000).toISOString() : new Date().toISOString(),
          code: codeMatch ? codeMatch[1] : null
        }
      });
    } else {
      const msgRes = await fetch(`https://api.mail.tm/messages/${msgId}`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5000)
      });
      if (!msgRes.ok) throw new Error("Mail.tm fetch message failed");
      const m = await msgRes.json();
      const combined = `${m.subject || ""} ${m.intro || ""} ${m.text || ""}`;
      const codeMatch = combined.match(/(?:コード|code|verification|認証|pin)[\s:：#\-_]*([0-9]{4,8})/i) ||
                        combined.match(/\b([0-9]{6})\b/) ||
                        combined.match(/\b([0-9]{4,8})\b/);
      return res.json({
        ok: true,
        message: {
          id: m.id,
          from: m.from ? (m.from.name ? `${m.from.name} <${m.from.address}>` : m.from.address) : "不明",
          subject: m.subject || "（件名なし）",
          intro: m.intro || "",
          text: m.text || "",
          html: m.html && m.html.length > 0 ? m.html[0] : "",
          createdAt: m.createdAt,
          code: codeMatch ? codeMatch[1] : null
        }
      });
    }
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ====================================================
// 🔁 プロキシ外へはみ出したパスの救済（最終段）
// Worker内の /ttwid/check/、SPAの絶対パス、Instagramの /accounts/… など、
// プロキシURLの中から出た相対・絶対パスは mokori の404になってしまう。
// CookieかRefererから元のサイトを割り出せる場合は上流へ307で中継し、404画面を出さない。
// （すべてのルート定義の後に置き、mokori 本体のページ・APIを奪わないようにする）
// ====================================================
const SELF_PATH_PREFIXES = [
  "/api/", "/tensai-proxy", "/tube", "/music", "/instagram", "/tiktok", "/roblox",
  "/mail.html", "/downloads", "/chat", "/sns", "/friends", "/ai", "/games",
  "/paper", "/line", "/favicon", "/manifest", "/robots.txt", "/sw.js"
];

function proxyOriginFromRequest(req) {
  // 🧭 Referer（＝そのリクエストを出したプロキシ内のページ）を最優先で信じる。
  // Cookie だけだと、iframe や CDNのHTMLエラーページが __px_origin を上書きして
  // /s/_/… が別サイトへ中継され、YouTubeが真っ白になることがあった。
  // ページの中のリクエストには必ず自分自身のプロキシURLが Referer として付く。
  const ref = String(req.headers.referer || "");
  if (ref.includes("proxy?url=")) {
    try {
      const inner = decodeURIComponent((ref.split("proxy?url=")[1] || "").split("&")[0]);
      if (inner) {
        const o = new URL(inner);
        if (o.protocol === "http:" || o.protocol === "https:") return o.origin;
      }
    } catch (_) {}
  }
  const cookie = String(req.headers.cookie || "");
  const m = /(?:^|;\s*)__px_origin=([^;]*)/.exec(cookie);
  if (m && m[1]) {
    try {
      const o = decodeURIComponent(m[1]);
      if (/^https?:\/\/[^\s]+$/i.test(o)) return o.replace(/\/+$/, "");
    } catch (_) {}
  }
  return null;
}

app.use((req, res, next) => {
  if (!["GET", "HEAD", "POST"].includes(req.method)) return next();
  const p = req.path || "/";
  if (p === "/") return next();
  if (SELF_PATH_PREFIXES.some((pre) => p === pre.replace(/\/$/, "") || p.startsWith(pre))) return next();
  const origin = proxyOriginFromRequest(req);
  if (!origin) return next();
  const target = origin + req.originalUrl;
  return res.redirect(307, "/api/proxy?url=" + encodeURIComponent(target) + "&_spa=1");
});

app.listen(port, () => {
  console.log(`mokori server listening on port ${port}`);
  try { warmProxyCache(); } catch (_) {}
});

// 🔥 Renderの無料枠は再起動が多く、再起動直後の初回アクセスがMetaの429や
// スロースタートで「Bootloading module failed」の無限スピナーになりやすい。
// 自分の /api/proxy を通してページとJS/CSSを温めておき、利用者の初回表示で
// Metaへ行かない（＝429を踏む回数そのものを減らす）ようにする。
let warmTimer = null;
function warmProxyCache() {
  if (String(process.env.DISABLE_WARM || "") === "1") return;
  const warmedAt = Date.now();
  const run = async () => {
    const target = "https://www.instagram.com/";
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/proxy?url=${encodeURIComponent(target)}`, {
        headers: { "User-Agent": UA_IOS_SAFARI, "Accept": "text/html,application/xhtml+xml" },
        signal: AbortSignal.timeout(30000)
      });
      if (!r.ok) return;
      const html = await r.text();
      const assets = [...String(html).matchAll(/(?:src|href)="(\/api\/proxy\?url=[^"]+)"/g)]
        .map((m) => m[1].replace(/&amp;/g, "&"))
        .filter((u) => {
          // JS/CSSだけを温める（アイコン・hreflangの別言語ページは無駄）
          let t = u;
          try { t = decodeURIComponent((u.split("url=")[1] || "")); } catch (_) {}
          if (/\?hl=/.test(t)) return false;
          return /\.(?:js|css)(?:\?|$)/i.test(t) || /\/rsrc\.php\//i.test(t);
        })
        .filter((u, i, a) => a.indexOf(u) === i)
        .slice(0, 16);
      for (const a of assets) {
        try {
          const ar = await fetch(`http://127.0.0.1:${port}${a}`, {
            headers: { "User-Agent": UA_IOS_SAFARI, "Accept": "*/*" },
            signal: AbortSignal.timeout(30000)
          });
          await ar.arrayBuffer();
          await sleep(200);
        } catch (_) {}
      }
    } catch (_) {}
    console.log(`[warm] instagram proxy cache warmed in ${Date.now() - warmedAt}ms`);
  };
  run();
  // 定期的に温め直す（15分ごと。Metaへのアクセスは1回/15分で済む）
  if (!warmTimer) {
    warmTimer = setInterval(run, 15 * 60 * 1000);
    if (warmTimer.unref) warmTimer.unref();
  }
}
