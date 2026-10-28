
const express = require("express");
const admin = require("firebase-admin");
const bcrypt = require("bcryptjs");

const app = express();
app.use(express.json());

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
  } else {
    console.warn("Firebase is not configured yet.");
  }
} catch (error) {
  console.error("Firebase setup error:", error.message);
}

app.get("/api/health", (req, res) => {
  res.json({
    ok: true,
    app: "mokori",
    firebaseConfigured: Boolean(db && auth)
  });
});

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

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`mokori server listening on port ${port}`);
});
