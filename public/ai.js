const firebaseConfig = {
  apiKey: "AIzaSyAXv7r2M0q22JLa0s4XcpPomf-KW19CPPE",
  authDomain: "mokori-by-riona-iwakami.firebaseapp.com",
  projectId: "mokori-by-riona-iwakami",
  storageBucket: "mokori-by-riona-iwakami.firebasestorage.app",
  messagingSenderId: "78875890394",
  appId: "1:78875890394:web:ee631706d895893ec10be3"
};

if (!firebase.apps || !firebase.apps.length) {
  firebase.initializeApp(firebaseConfig);
}
const auth = firebase.auth();

// Cloudflare Worker API URL
const WORKER_URL = window.MYYAJUU_AI_WORKER_URL || "https://myyajuu-ai-worker.harumei-260329.workers.dev";
// 同じサイト（mokori01.onrender.com / mokori.onrender.com / ローカル）から配信されるので、
// プロキシは必ず同一オリジンを使う。固定ホスト名だと別ドメインで開いたときにCORS/接続で詰まる。
const PROXY_URL = (typeof location !== "undefined" && location.origin ? location.origin : "https://mokori01.onrender.com") + "/api/ai";
const ENDPOINT_STORAGE_KEY = "mokori_ai_endpoint";
const CHAT_TIMEOUT_MS = 60000;   // AIの返事待ち（GPT-OSSは長文で40秒近くかかる）
const REQUEST_TIMEOUT_MS = 20000; // 会話一覧・履歴など

// 既定は同一オリジンの /api/ai（mokoriサーバー）経由。
// iPhone・学校iPadのフィルターや回線では workers.dev への直接通信が失敗し、
// 画面にSafariの「Load failed」がそのまま出たまま数十秒固まることがあった。
// 同一オリジンはその影響を受けず、経路が落ちているときだけ workers.dev へ切り替える。
let activeApiUrl = (function() {
  try {
    if (sessionStorage.getItem(ENDPOINT_STORAGE_KEY) === "worker") return WORKER_URL;
  } catch (_) {}
  return PROXY_URL;
})();

function rememberEndpoint(url) {
  activeApiUrl = url;
  try { sessionStorage.setItem(ENDPOINT_STORAGE_KEY, url === WORKER_URL ? "worker" : "proxy"); } catch (_) {}
}

function endpointLabel(url) {
  return url === WORKER_URL ? "workers.dev" : "mokoriサーバー";
}

function makeTimeoutSignal(userSignal, ms) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try { controller.abort(new DOMException("timeout", "TimeoutError")); } catch (_) { controller.abort(); }
  }, ms);
  const onAbort = () => {
    try { controller.abort(userSignal.reason); } catch (_) { controller.abort(); }
  };
  if (userSignal) {
    if (userSignal.aborted) onAbort();
    else userSignal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      if (userSignal) userSignal.removeEventListener("abort", onAbort);
    },
    get timedOut() { return timedOut; }
  };
}

// 通信エラーをそのまま「Load failed」と出さず、日本語で伝える
function networkErrorMessage(err) {
  if (err && err.name === "TimeoutError") {
    return "AIの返事が時間内に返ってきませんでした。電波のいい場所でもう一度送ってみてください。";
  }
  if (err && err.name === "AbortError") return "送信を中止しました。";
  return "AIにつながりませんでした。電波の状態を確かめて、もう一度送ってみてください。";
}

async function workerFetch(path, options = {}) {
  const isChat = path.startsWith("/v1/chat") || path.startsWith("/v1/image");
  const timeoutMs = isChat ? CHAT_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
  const order = activeApiUrl === WORKER_URL ? [WORKER_URL, PROXY_URL] : [PROXY_URL, WORKER_URL];
  let lastError = null;

  for (let i = 0; i < order.length; i += 1) {
    const base = order[i];
    const timeout = makeTimeoutSignal(options.signal, timeoutMs);
    try {
      const res = await fetch(`${base}${path}`, { ...options, signal: timeout.signal });
      timeout.cleanup();
      // フィルターがHTTP 200のままHTMLのブロックページを返す場合（JSONでない応答）も
      // そのまま渡すと「Unexpected token <」で壊れるため、もう一方の経路で取り直す
      const contentType = (res.headers.get("content-type") || "").toLowerCase();
      if (res.ok && !contentType.includes("application/json")) {
        console.warn(`Non-JSON response from ${endpointLabel(base)}:`, path);
        lastError = new Error("non-json");
        continue;
      }
      // 経路側の一時障害（ゲートウェイエラー）だけ、もう一方の経路で取り直す
      if (!res.ok && [502, 504].includes(res.status) && i < order.length - 1) {
        console.warn(`Upstream ${res.status} from ${endpointLabel(base)}:`, path);
        lastError = new Error("upstream");
        continue;
      }
      if (base !== activeApiUrl) rememberEndpoint(base);
      return res;
    } catch (err) {
      timeout.cleanup();
      if (options.signal && options.signal.aborted) throw err; // 利用者が中止した場合はそのまま
      if (timeout.timedOut) {
        // 待たせ続けない: タイムアウトはそのまま日本語のエラーにする
        const timeoutError = new Error(networkErrorMessage({ name: "TimeoutError" }));
        timeoutError.name = "TimeoutError";
        throw timeoutError;
      }
      lastError = err;
      console.warn(`Request to ${endpointLabel(base)} failed:`, path, err && err.name);
    }
  }
  throw new Error(networkErrorMessage(lastError));
}

// Workerが返す英語のエラーを、アプリで読める日本語にする
function friendlyAiError(status, errData) {
  const code = (errData && (errData.error || errData.code)) || "";
  const message = (errData && errData.message) || "";
  if (code === "user_daily_limit") return "今日AIを使える回数の上限（20回）に達しました。明日の朝9時以降にまた使えます。";
  if (code === "daily_budget_reached") return "今日のAIの無料枠がいっぱいです。しばらく時間をおいてから試してください。";
  if (code === "request_in_progress") return "前の返事をまだ作っています。10秒ほど待ってから、もう一度送ってください。";
  if (code === "conversation_full") return "この会話が長くなりすぎました。上の「➕ 新規」で新しい会話を始めてください。";
  if (code === "conversation_limit") return "会話の数が上限（50件）に達しました。「📁 会話一覧」から使わない会話を削除してください。";
  if (code === "empty_model_response" || code === "service_unavailable") {
    return "AIがいま混み合っていて答えを返せませんでした。少し待って、もう一度送ってください。";
  }
  if (status === 401) return "ログインの有効期限が切れたようです。アプリを開き直してから、もう一度送ってください。";
  if (status === 413) return "メッセージが長すぎます。短くしてから送ってください。";
  if (message && !/[\u3040-\u30ff\u4e00-\u9fff]/.test(message)) {
    return `AIの返事を取得できませんでした（${status || "通信エラー"}）。もう一度送ってください。`;
  }
  return message || `AIの返事を取得できませんでした（${status || "通信エラー"}）。もう一度送ってください。`;
}

const MODEL_CATALOG = {
  "@cf/openai/gpt-oss-20b": { name: "GPT-OSS 20B" },
  "@cf/meta/llama-3.2-3b-instruct": { name: "Llama 3.2 3B" },
  "@cf/google/gemma-4-26b-a4b-it": { name: "Gemma 4 26B" },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { name: "Llama 3.3 70B" },
  "@cf/qwen/qwen3-30b-a3b-fp8": { name: "Qwen3 30B" },
};

const $ = (id) => document.getElementById(id);

// AIの返答に混ぎる Markdown / LaTeX を、そのまま読める文字に直して表示する。
// （\( ... \), \frac{a}{b}, **強調** が生の記号で出ると「壊れて見える」ため）
function escapeHtmlText(str) {
  return String(str || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatAiText(input) {
  let s = escapeHtmlText(String(input || ""));
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\\\[|\\\]|\\\(|\\\)/g, "");
  for (const cmd of ["boxed", "text", "textrm", "mathrm", "operatorname", "overline", "underline"]) {
    s = stripLatexBraced(s, cmd);
  }
  for (let i = 0; i < 2; i++) {
    s = s.replace(/\\(?:d|t)?frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1)/($2)");
    s = s.replace(/\\sqrt\{([^{}]*)\}/g, "√($1)");
  }
  s = s.replace(/\\left|\\right/g, "");
  s = s.replace(/\\times/g, "×").replace(/\\div/g, "÷").replace(/\\pm/g, "±");
  s = s.replace(/\\leq|\\le(?![a-z])/g, "≤").replace(/\\geq|\\ge(?![a-z])/g, "≥");
  s = s.replace(/\\neq|\\ne(?![a-z])/g, "≠").replace(/\\cdot/g, "・");
  s = s.replace(/\\Rightarrow|\\implies/g, "⇒").replace(/\\rightarrow|\\to(?![a-z])/g, "→");
  s = s.replace(/\\(?:quad|qquad)/g, "  ");
  s = s.replace(/\\[;,!: ]/g, " ");
  s = s.replace(/\\\\/g, "\n");
  s = s.replace(/\\([a-zA-Z]+)/g, "$1");
  s = s.replace(/^#{1,6}\s*/gm, "");
  s = s.replace(/^[-—]{3,}$/gm, "");
  return s;
}

// \cmd{...} の中身だけ残す（括弧の入れ子に対応）
function stripLatexBraced(str, cmd) {
  const token = "\\" + cmd + "{";
  let s = str;
  let idx;
  while ((idx = s.indexOf(token)) !== -1) {
    let depth = 0;
    let end = -1;
    for (let i = idx + token.length - 1; i < s.length; i++) {
      if (s[i] === "\\") { i++; continue; }
      if (s[i] === "{") depth++;
      else if (s[i] === "}") {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) {
      s = s.slice(0, idx) + s.slice(idx + token.length);
      break;
    }
    s = s.slice(0, idx) + s.slice(idx + token.length, end) + s.slice(end + 1);
  }
  return s;
}
let statusEl = $("status");
let errorEl = $("error");
let promptEl = $("prompt");
let sendButton = $("sendButton");
let messagesEl = $("messages");
let welcomeEl = $("welcome");
let authGateEl = $("authGate");
let authGateTitleEl = $("authGateTitle");
let authMessageEl = $("authMessage");
let modelSelectEl = $("modelSelect");
let authLoginLinkEl = $("authLoginLink");
let chatAreaEl = $("chatArea");

// Sessions / Project elements
let sessionTitleDisplay = $("sessionTitleDisplay");
let sessionsBtn = $("sessionsBtn");
let newChatBtn = $("newChatBtn");
let sessionsDrawer = $("sessionsDrawer");
let drawerOverlay = $("drawerOverlay");
let closeDrawerBtn = $("closeDrawerBtn");
let drawerNewChatBtn = $("drawerNewChatBtn");
let sessionsList = $("sessionsList");

// Toolbar elements
let webSearchToggle = $("webSearchToggle");
let webSearchState = $("webSearchStatus") || $("webSearchState");
let imageGenBtn = $("genImageBtn") || $("imageGenBtn");
let attachBtn = $("attachBtn");
let fileInput = $("fileInput");
let clearChatBtn = $("clearChatBtn");
// HTML側のIDは attachmentPreview（旧版のattachmentPreviewAreaも拾う）
let attachmentPreviewArea = $("attachmentPreviewArea") || $("attachmentPreview");
let attachmentName = $("attachmentName");
let removeAttachmentBtn = $("removeAttachmentBtn");

function ensureDomElements() {
  if (!statusEl) statusEl = $("status");
  if (!errorEl) errorEl = $("error");
  if (!promptEl) promptEl = $("prompt");
  if (!sendButton) sendButton = $("sendButton");
  if (!messagesEl) messagesEl = $("messages");
  if (!welcomeEl) welcomeEl = $("welcome");
  if (!authGateEl) authGateEl = $("authGate");
  if (!authGateTitleEl) authGateTitleEl = $("authGateTitle");
  if (!authMessageEl) authMessageEl = $("authMessage");
  if (!modelSelectEl) modelSelectEl = $("modelSelect");
  if (!authLoginLinkEl) authLoginLinkEl = $("authLoginLink");
  if (!chatAreaEl) chatAreaEl = $("chatArea");
  initModelSelect();
  if (!sessionTitleDisplay) sessionTitleDisplay = $("sessionTitleDisplay");
  if (!sessionsBtn) sessionsBtn = $("sessionsBtn");
  if (!newChatBtn) newChatBtn = $("newChatBtn");
  if (!sessionsDrawer) sessionsDrawer = $("sessionsDrawer");
  if (!drawerOverlay) drawerOverlay = $("drawerOverlay");
  if (!closeDrawerBtn) closeDrawerBtn = $("closeDrawerBtn");
  if (!drawerNewChatBtn) drawerNewChatBtn = $("drawerNewChatBtn");
  if (!sessionsList) sessionsList = $("sessionsList");
  if (!webSearchToggle) webSearchToggle = $("webSearchToggle");
  if (!webSearchState) webSearchState = $("webSearchStatus") || $("webSearchState");
  if (!imageGenBtn) imageGenBtn = $("genImageBtn") || $("imageGenBtn");
  if (!attachBtn) attachBtn = $("attachBtn");
  if (!fileInput) fileInput = $("fileInput");
  if (!clearChatBtn) clearChatBtn = $("clearChatBtn");
  if (!attachmentPreviewArea) attachmentPreviewArea = $("attachmentPreviewArea") || $("attachmentPreview");
  if (!attachmentName) attachmentName = $("attachmentName");
  if (!removeAttachmentBtn) removeAttachmentBtn = $("removeAttachmentBtn");
}
document.addEventListener("DOMContentLoaded", ensureDomElements);

// 会話データ・セッションデータはメモリ上にのみ保持（LocalStorage, SessionStorage, IndexedDB, Cache API には一切保存しない）
let history = [];
let sessions = [];
let currentSessionId = null;
let currentSessionTitle = "新しいチャット";
let currentUser = null;
let currentUid = null;
let generating = false;
let loadingHistory = false;
let selectedModelId = "@cf/openai/gpt-oss-20b";
let currentAttachment = null; // { name, type, content, isImage }
let authStateVersion = 0;
let historyRequestVersion = 0;
let sessionsRequestVersion = 0;
let navigationRequestVersion = 0;
let sessionOperationVersion = 0;
let sessionMutationPending = false;
let generationRequestVersion = 0;
let generationAbortController = null;
let attachmentReadVersion = 0;

// Remove only legacy AI chat keys; do not clear sessionStorage shared with the SNS.
function purgeLegacyLocalData() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i);
      if (key && (key.startsWith("myyajuu_ai") || key.includes("ai_test_history"))) {
        localStorage.removeItem(key);
      }
    }
  } catch (error) {
    console.warn("古いAI履歴を削除できませんでした:", error);
  }
}
purgeLegacyLocalData();

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

// モデル選択の選択肢を生成（HTML側の <select> は空なのでJSで埋める）
function initModelSelect() {
  if (!modelSelectEl) modelSelectEl = $("modelSelect");
  if (!modelSelectEl) return;
  if (modelSelectEl.options.length === 0) {
    for (const [id, info] of Object.entries(MODEL_CATALOG)) {
      const option = document.createElement("option");
      option.value = id;
      option.textContent = info.name;
      modelSelectEl.appendChild(option);
    }
  }
  if (!MODEL_CATALOG[selectedModelId]) selectedModelId = "@cf/openai/gpt-oss-20b";
  modelSelectEl.value = selectedModelId;
  modelSelectEl.disabled = false;
  if (!modelSelectEl.dataset.bound) {
    modelSelectEl.dataset.bound = "1";
    modelSelectEl.addEventListener("change", (event) => {
      if (MODEL_CATALOG[event.target.value]) selectedModelId = event.target.value;
    });
  }
}
initModelSelect();

let webSearchEnabled = false;
if (webSearchToggle) {
  webSearchToggle.disabled = false;
  webSearchToggle.addEventListener("click", () => {
    webSearchEnabled = !webSearchEnabled;
    webSearchToggle.style.background = webSearchEnabled ? "#0284c7" : "#1e293b";
    webSearchToggle.style.color = webSearchEnabled ? "#fff" : "#94a3b8";
    if (webSearchState) {
      webSearchState.textContent = webSearchEnabled ? "ON" : "OFF";
      webSearchState.style.color = webSearchEnabled ? "#38bdf8" : "#94a3b8";
    }
  });
}

if (imageGenBtn) {
  imageGenBtn.disabled = false;
  imageGenBtn.addEventListener("click", () => {
    const p = promptEl.value.trim();
    if (!p) {
      promptEl.value = "画像生成: ";
      promptEl.focus();
      return;
    }
    sendMessage(p);
  });
}

// 画像のクライアント側自動リサイズ・圧縮 (2MB制限を完全に突破)
function compressImageForAi(file, maxWidth = 1024, maxHeight = 1024, quality = 0.8) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let w = img.width;
        let h = img.height;
        if (w > maxWidth || h > maxHeight) {
          if (w > h) {
            h = Math.round((h * maxWidth) / w);
            w = maxWidth;
          } else {
            w = Math.round((w * maxHeight) / h);
            h = maxHeight;
          }
        }
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", quality));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

// ファイル添付ボタン
if (attachBtn && fileInput) {
  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    currentAttachment = null;
    if (attachmentPreviewArea) attachmentPreviewArea.hidden = true;
    if (file.type.startsWith("image/")) {
      const readVersion = ++attachmentReadVersion;
      const uidForRead = currentUid;
      const authVersionForRead = authStateVersion;
      try {
        const compressedDataUrl = await compressImageForAi(file);
        if (readVersion !== attachmentReadVersion || currentUid !== uidForRead || authStateVersion !== authVersionForRead) return;
        currentAttachment = {
          name: file.name,
          type: "image",
          content: compressedDataUrl,
          isImage: true,
        };
        showAttachmentPreview(file.name, "🖼️");
      } catch (err) {
        if (readVersion === attachmentReadVersion && currentUid === uidForRead && authStateVersion === authVersionForRead) {
          showError("画像の読み込み・最適化に失敗しました。");
        }
      }
      return;
    }

    const reader = new FileReader();
    const readVersion = ++attachmentReadVersion;
    const uidForRead = currentUid;
    const authVersionForRead = authStateVersion;
    reader.onerror = () => {
      if (readVersion === attachmentReadVersion && currentUid === uidForRead && authStateVersion === authVersionForRead) {
        showError("添付ファイルを読み込めませんでした。");
      }
    };
    reader.onload = (evt) => {
      if (readVersion !== attachmentReadVersion || currentUid !== uidForRead || authStateVersion !== authVersionForRead) return;
      if (typeof evt.target.result !== "string") {
        showError("添付ファイルをテキストとして読み込めませんでした。");
        return;
      }
      currentAttachment = {
        name: file.name,
        type: "text",
        content: evt.target.result,
      };
      showAttachmentPreview(file.name, "📄");
    };
    reader.readAsText(file);
  });
}

function showAttachmentPreview(name, icon) {
  if (attachmentName) attachmentName.textContent = `${icon} ${name}`;
  if (attachmentPreviewArea) attachmentPreviewArea.hidden = false;
}

function clearAttachment() {
  attachmentReadVersion += 1;
  currentAttachment = null;
  // 添付プレビューの要素が見つからない環境でも認証・送信処理を止めない
  if (attachmentPreviewArea) attachmentPreviewArea.hidden = true;
  if (fileInput) fileInput.value = "";
}

if (removeAttachmentBtn) {
  removeAttachmentBtn.addEventListener("click", clearAttachment);
}

// ドロワー開閉
function openDrawer() {
  sessionsDrawer.hidden = false;
  drawerOverlay.hidden = false;
  renderSessionsList();
}

function closeDrawer() {
  sessionsDrawer.hidden = true;
  drawerOverlay.hidden = true;
}

if (sessionsBtn) sessionsBtn.addEventListener("click", openDrawer);
if (closeDrawerBtn) closeDrawerBtn.addEventListener("click", closeDrawer);
if (drawerOverlay) drawerOverlay.addEventListener("click", closeDrawer);

function cancelActiveGeneration() {
  generationRequestVersion += 1;
  if (generationAbortController) {
    generationAbortController.abort();
    generationAbortController = null;
  }
  generating = false;
}

function invalidateHistoryRequest() {
  historyRequestVersion += 1;
  loadingHistory = false;
}

// 新しい会話は最初の送信時にWorker側でD1へ作成される。
function startNewChat() {
  if (!currentUser || !currentUid || sessionMutationPending) return;

  navigationRequestVersion += 1;
  closeDrawer();
  cancelActiveGeneration();
  invalidateHistoryRequest();
  currentSessionId = null;
  currentSessionTitle = "新しいチャット";
  history = [];
  clearAttachment();
  sessionTitleDisplay.textContent = currentSessionTitle;
  renderHistory();
  renderSessionsList();
  errorEl.hidden = true;
  statusEl.textContent = "新しい会話を開始しました。質問を送信するとD1に保存されます。";
  syncUI();
  promptEl.focus();
}

if (newChatBtn) newChatBtn.addEventListener("click", startNewChat);
if (drawerNewChatBtn) drawerNewChatBtn.addEventListener("click", startNewChat);

async function fetchSessionsList(user, expectedAuthVersion = authStateVersion) {
  if (!user) return false;
  const uidForRequest = user.uid;
  const requestVersion = ++sessionsRequestVersion;
  try {
    const token = await user.getIdToken();
    let response;
    try {
      response = await workerFetch(`/v1/conversations?limit=50`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch (netErr) {
      // iOS Safari等のネットワーク初期化ラグ対策: 1回だけ即時再試行
      await new Promise((r) => setTimeout(r, 350));
      const freshToken = await user.getIdToken(true);
      response = await workerFetch(`/v1/conversations?limit=50`, {
        headers: { Authorization: `Bearer ${freshToken}` },
      });
    }
    if (response.status === 401) {
      const freshToken = await user.getIdToken(true);
      response = await workerFetch(`/v1/conversations?limit=50`, {
        headers: { Authorization: `Bearer ${freshToken}` },
      });
    }
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `会話一覧を取得できませんでした (${response.status})`);
    }

    const data = await response.json();
    if (requestVersion !== sessionsRequestVersion || currentUid !== uidForRequest || authStateVersion !== expectedAuthVersion) {
      return false;
    }
    sessions = Array.isArray(data.conversations)
      ? data.conversations
          .filter((conversation) => typeof conversation?.conversationId === "string")
          .map((conversation) => ({
            id: conversation.conversationId,
            title: conversation.title || "チャット",
            updatedAt: conversation.updatedAt,
          }))
      : [];
    renderSessionsList();
    return true;
  } catch (error) {
    if (requestVersion === sessionsRequestVersion && currentUid === uidForRequest && authStateVersion === expectedAuthVersion) {
      showError(error?.message || "会話一覧を取得できませんでした。");
      console.error("会話一覧の取得に失敗しました:", error);
    }
    return false;
  }
}

function renderSessionsList() {
  if (!sessionsList) return;
  sessionsList.replaceChildren();

  if (sessions.length === 0) {
    const emptyItem = document.createElement("li");
    emptyItem.className = "session-item active";
    emptyItem.textContent = currentSessionId ? "保存済みの会話はありません" : "新しい会話（未保存）";
    sessionsList.appendChild(emptyItem);
    return;
  }

  const visibleSessions = !currentSessionId || !sessions.some((session) => session.id === currentSessionId)
    ? [{ id: currentSessionId, title: currentSessionTitle, ephemeral: true }, ...sessions]
    : sessions;

  for (const session of visibleSessions) {
    const li = document.createElement("li");
    li.className = `session-item ${session.id === currentSessionId ? "active" : ""}`;

    const titleSpan = document.createElement("span");
    titleSpan.className = "session-title-text";
    titleSpan.textContent = `💬 ${session.title || "チャット"}${session.ephemeral ? "（未保存）" : ""}`;
    titleSpan.addEventListener("click", () => {
      if (session.ephemeral) {
        closeDrawer();
        return;
      }
      switchSession(session.id, session.title);
    });
    li.appendChild(titleSpan);

    if (!session.ephemeral) {
      const delBtn = document.createElement("button");
      delBtn.className = "session-del-btn";
      delBtn.textContent = "🗑️";
      delBtn.title = "この会話を削除";
      delBtn.addEventListener("click", async (event) => {
        event.stopPropagation();
        if (!confirm(`「${session.title}」を削除しますか？`)) return;
        await deleteSession(session.id);
      });
      li.appendChild(delBtn);
    }

    sessionsList.appendChild(li);
  }
}

async function switchSession(id, title) {
  if (id === currentSessionId) {
    closeDrawer();
    return;
  }
  const user = currentUser;
  const uidForRequest = currentUid;
  const authVersionAtStart = authStateVersion;
  const navigationVersion = ++navigationRequestVersion;
  closeDrawer();
  cancelActiveGeneration();
  invalidateHistoryRequest();
  currentSessionId = id;
  currentSessionTitle = title || "チャット";
  sessionTitleDisplay.textContent = currentSessionTitle;
  history = [];
  renderHistory();
  clearAttachment();
  syncUI();

  if (!user || !uidForRequest) return;
  statusEl.textContent = "会話履歴を読み込んでいます…";
  const fetched = await fetchD1History(user, id, authVersionAtStart);
  if (!Array.isArray(fetched) || currentUid !== uidForRequest || authStateVersion !== authVersionAtStart ||
      navigationRequestVersion !== navigationVersion || currentSessionId !== id) return;
  history = fetched;
  renderHistory();
  statusEl.textContent = `会話「${currentSessionTitle}」を開きました。`;
  promptEl.focus();
}

async function deleteSession(id) {
  const user = currentUser;
  const uidForRequest = currentUid;
  const authVersionAtStart = authStateVersion;
  if (!user || !uidForRequest || sessionMutationPending) return;
  const operationVersion = ++sessionOperationVersion;
  sessionMutationPending = true;
  syncUI();

  statusEl.textContent = "会話を削除しています…";
  try {
    const token = await user.getIdToken();
    const response = await workerFetch(`/v1/conversations/${encodeURIComponent(id)}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `会話を削除できませんでした (${response.status})`);
    }
    if (currentUid !== uidForRequest || authStateVersion !== authVersionAtStart) return;

    sessions = sessions.filter((session) => session.id !== id);
    if (currentSessionId === id) {
      currentSessionId = null;
      currentSessionTitle = "新しいチャット";
      history = [];
      sessionTitleDisplay.textContent = currentSessionTitle;
      renderHistory();
    }
    renderSessionsList();
    statusEl.textContent = "会話を削除しました。新しい質問は新規会話に保存されます。";
  } catch (error) {
    if (currentUid === uidForRequest && authStateVersion === authVersionAtStart) {
      showError(error?.message || "会話の削除に失敗しました。");
      statusEl.textContent = "会話の削除に失敗しました。";
    }
  } finally {
    if (sessionOperationVersion === operationVersion) sessionMutationPending = false;
    syncUI();
  }
}

function syncUI() {
  ensureDomElements();
  const signedIn = Boolean(currentUid);
  const busy = generating || loadingHistory || sessionMutationPending;
  if (authGateEl) authGateEl.hidden = signedIn;
  if (promptEl) promptEl.disabled = !signedIn || busy;
  if (sendButton) sendButton.disabled = !signedIn || busy;
  if (modelSelectEl) modelSelectEl.disabled = !signedIn || busy;
  if (attachBtn) attachBtn.disabled = !signedIn || busy;
  if (imageGenBtn) imageGenBtn.disabled = !signedIn || busy;
  if (webSearchToggle) webSearchToggle.disabled = !signedIn || busy;
  if (sessionsBtn) sessionsBtn.disabled = !signedIn || busy;
  if (newChatBtn) newChatBtn.disabled = !signedIn || busy;
  if (drawerNewChatBtn) drawerNewChatBtn.disabled = !signedIn || busy;
  if (clearChatBtn) clearChatBtn.disabled = !signedIn || busy;

  if (!signedIn) {
    if (welcomeEl) welcomeEl.hidden = true;
    if (chatAreaEl) chatAreaEl.hidden = true;
    closeDrawer();
  } else {
    // 会話があるときは必ずチャットエリアを表示する（HTMLでは hidden のままで、
    // これを外す処理がなく会話が一切見えなかった）
    if (chatAreaEl) chatAreaEl.hidden = history.length === 0 && !currentSessionId;
  }
}

function appendMessage(role, text, modelName = null, imageUrl = null) {
  const row = document.createElement("div");
  row.className = `message ${role}`;
  const bubble = document.createElement("div");
  bubble.className = "bubble";

  if (role === "assistant" && modelName) {
    const tag = document.createElement("span");
    tag.className = "model-tag";
    tag.textContent = `✦ ${modelName}`;
    bubble.appendChild(tag);
  }

  const textNode = document.createElement("div");
  textNode.className = "text-content";
  if (role === "assistant") {
    textNode.innerHTML = formatAiText(text);
  } else {
    textNode.textContent = text;
  }
  bubble.appendChild(textNode);

  if (imageUrl) {
    const imgContainer = document.createElement("div");
    imgContainer.className = "generated-image-container";
    const img = document.createElement("img");
    img.src = imageUrl;
    img.alt = "生成された画像";
    img.className = "generated-img";
    imgContainer.appendChild(img);
    bubble.appendChild(imgContainer);
  }

  row.appendChild(bubble);
  messagesEl.appendChild(row);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
  return textNode;
}

function renderHistory() {
  messagesEl.replaceChildren();
  if (!currentUid) {
    welcomeEl.hidden = true;
    return;
  }
  for (const item of history) {
    let mName = null;
    if (item.role === "assistant") {
      const info = item.model ? MODEL_CATALOG[item.model] : null;
      mName = info ? info.name : null;
    }
    appendMessage(item.role, item.content, mName, item.image);
  }
  welcomeEl.hidden = history.length > 0;
  if (chatAreaEl) chatAreaEl.hidden = history.length === 0;
  if (history.length > 0 && messagesEl) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

// Cloudflare D1から会話履歴を取得
async function fetchD1History(user, conversationId = currentSessionId, expectedAuthVersion = authStateVersion) {
  if (!user) return null;
  if (!conversationId) return [];

  const uidForRequest = user.uid;
  const requestVersion = ++historyRequestVersion;
  loadingHistory = true;
  statusEl.textContent = "会話履歴をD1サーバーから同期しています…";
  syncUI();

  try {
    const token = await user.getIdToken();
    const response = await workerFetch(`/v1/conversations/${encodeURIComponent(conversationId)}?limit=100`, {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });

    if (!response.ok) {
      if (response.status === 401) throw new Error("認証の有効期限が切れました。ログインし直してください。");
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.message || `履歴の取得に失敗しました (${response.status})`);
    }

    const data = await response.json();
    if (requestVersion !== historyRequestVersion || currentUid !== uidForRequest ||
        authStateVersion !== expectedAuthVersion || currentSessionId !== conversationId) return null;
    return Array.isArray(data.messages) ? data.messages : [];
  } catch (error) {
    if (requestVersion === historyRequestVersion && currentUid === uidForRequest &&
        authStateVersion === expectedAuthVersion && currentSessionId === conversationId) {
      showError("会話履歴の同期に失敗しました。\n" + (error?.message || error));
      console.error("D1会話履歴の取得に失敗しました:", error);
    }
    return null;
  } finally {
    if (requestVersion === historyRequestVersion) {
      loadingHistory = false;
      syncUI();
    }
  }
}


async function generateAndShowImage(promptText) {
  if (!currentUser || generating) return;
  const user = currentUser;
  generating = true;
  syncUI();
  errorEl.hidden = true;
  welcomeEl.hidden = true;

  appendMessage("user", `🎨 画像生成: ${promptText}`);
  const statusBubble = appendMessage("assistant", "AIが画像を生成しています… 🎨 (Stable Diffusion XL)");

  try {
    const token = await user.getIdToken();
    let imgDataUrl = null;

    try {
      const resp = await workerFetch("/v1/image", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ prompt: promptText }),
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.image) imgDataUrl = data.image;
      } else {
        const errData = await resp.json().catch(() => ({}));
        throw new Error(errData.message || "現在サーバーが混雑しています");
      }
    } catch (e) {
      console.warn("Worker image endpoint error:", e);
      throw e;
    }

    if (!imgDataUrl) {
      throw new Error("画像の生成に失敗しました。少し待ってから再度お試しください。");
    }

    // 回答バブルを更新して画像を表示
    statusBubble.remove();
    appendMessage("assistant", `「${promptText}」の画像を生成しました！`, "Stable Diffusion XL", imgDataUrl);
    statusEl.textContent = "画像生成完了";
  } catch (err) {
    statusBubble.remove();
    showError("画像生成中にエラーが発生しました: " + err.message);
  } finally {
    generating = false;
    syncUI();
  }
}

// メッセージ送信
async function sendMessage(rawText) {
  if (!currentUser || generating || loadingHistory) return;

  const attachment = currentAttachment;
  let text = (rawText || "").trim();

  if (!text && attachment?.type === "image") {
    text = "この画像を送信しました。";
  } else if (!text && attachment?.type === "text") {
    text = "添付ファイルを確認してください。";
  }

  if (!text) return;

  if (text.startsWith("/image") || text.startsWith("画像生成:") || text.startsWith("画像生成：")) {
    const imgPrompt = text.replace(/^(\/image|画像生成[:：])\s*/i, "").trim();
    if (!imgPrompt) {
      showError("画像生成のプロンプトを入力してください。（例: 画像生成: かわいい猫のドット絵）");
      return;
    }
    await generateAndShowImage(imgPrompt);
    return;
  }

  const user = currentUser;
  const sendUid = currentUid;
  const sendSessionId = currentSessionId;
  const sendAuthVersion = authStateVersion;
  const targetModelId = selectedModelId;
  const targetModelInfo = MODEL_CATALOG[targetModelId] || MODEL_CATALOG["@cf/meta/llama-3.2-3b-instruct"];
  
  let fullMessageText = text;
  if (attachment?.type === "text") {
    const budget = Math.max(200, 1350 - [...text].length);
    let snippet = attachment.content;
    if ([...snippet].length > budget) {
      snippet = [...snippet].slice(0, budget).join("") + "\n…(上限のため一部抜粋)";
    }
    fullMessageText += `\n\n【添付: ${attachment.name}】\n${snippet}`;
  } else if (attachment?.type === "image") {
    fullMessageText += `\n\n【添付画像: ${attachment.name}】`;
  }

  if ([...fullMessageText].length > 1450) {
    fullMessageText = [...fullMessageText].slice(0, 1450).join("");
  }

  const requestVersion = ++generationRequestVersion;
  const controller = new AbortController();
  generationAbortController = controller;
  generating = true;
  syncUI();
  errorEl.hidden = true;
  welcomeEl.hidden = true;

  const displayUserText = attachment ? `📎 [${attachment.name}]\n${text}` : text;
  const userBubble = appendMessage("user", displayUserText, null, attachment?.isImage ? attachment.content : null);
  history.push({ role: "user", content: displayUserText });
  clearAttachment();

  const assistantBubble = appendMessage("assistant", `${targetModelInfo.name} が回答を生成しています…`, targetModelInfo.name);
  statusEl.textContent = `${targetModelInfo.name} に送信中…`;

  try {
    const modelChain = targetModelId === "@cf/meta/llama-3.2-3b-instruct"
      ? [targetModelId]
      : [targetModelId, "@cf/meta/llama-3.2-3b-instruct"];
    let data = null;
    let lastStatus = 0;
    let lastErrData = {};
    let retriedAuth = false;
    let token = await user.getIdToken();

    for (let modelIdx = 0; modelIdx < modelChain.length; modelIdx += 1) {
      const requestModel = modelChain[modelIdx];
      const buildBody = () => JSON.stringify({
        message: fullMessageText,
        model: requestModel,
        webSearch: webSearchEnabled,
        ...(sendSessionId ? { conversationId: sendSessionId } : {}),
      });
      let response;
      try {
        response = await workerFetch(`/v1/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: buildBody(),
          signal: controller.signal,
        });
      } catch (netErr) {
        if (netErr?.name === "AbortError" || netErr?.name === "TimeoutError") throw netErr;
        // iOS Safariでセッション復帰直後に失敗することがあるため、トークンを取り直して1回だけ再試行
        await new Promise((r) => setTimeout(r, 400));
        token = await user.getIdToken(true);
        response = await workerFetch(`/v1/chat`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${token}`,
          },
          body: buildBody(),
          signal: controller.signal,
        });
      }

      if (response.ok) {
        data = await response.json();
        break;
      }

      const errData = await response.json().catch(() => ({}));
      lastStatus = response.status;
      lastErrData = errData;
      // トークンの有効期限切れ（iPhoneで復帰直後によくある）は取り直して同じモデルで再試行
      if (response.status === 401 && !retriedAuth) {
        retriedAuth = true;
        token = await user.getIdToken(true);
        continue;
      }
      // 回数上限・認証・入力の問題はモデルを変えても同じなので、そこで打ち切る
      if ([400, 401, 403, 409, 413, 429].includes(response.status)) break;
      if (modelIdx < modelChain.length - 1) {
        statusEl.textContent = `${targetModelInfo.name} が応答しないため、Llama 3.2 3B で再試行しています…`;
      }
    }

    if (!data) throw new Error(friendlyAiError(lastStatus, lastErrData));
    const replyText = typeof data.assistantMessage?.content === "string"
      ? data.assistantMessage.content
      : (typeof data.reply === "string" ? data.reply : "");
    if (!replyText) throw new Error("AIから有効な回答が返されませんでした。");
    if (typeof data.conversationId !== "string" || !data.conversationId) {
      throw new Error("Workerから有効な会話IDが返されませんでした。");
    }
    if (sendSessionId && data.conversationId !== sendSessionId) {
      throw new Error("Workerから別の会話IDが返されました。");
    }
    if (data.model !== targetModelId) {
      // Workerが別モデルで応答した場合も、返答自体は見せる（以前は例外にして
      // 回答を捨てていたため「返事が来ない」ように見えていた）
      console.warn("Model mismatch:", data.model, targetModelId);
    }
    if (requestVersion !== generationRequestVersion || currentUid !== sendUid ||
        authStateVersion !== sendAuthVersion || currentSessionId !== sendSessionId) return;

    currentSessionId = data.conversationId;
    if (!sendSessionId) {
      currentSessionTitle = [...fullMessageText].slice(0, 80).join("") || "新しいチャット";
      sessionTitleDisplay.textContent = currentSessionTitle;
    }
    const replyTextEl = assistantBubble.querySelector(".text-content");
    if (replyTextEl) {
      replyTextEl.innerHTML = formatAiText(replyText);
    } else {
      assistantBubble.innerHTML = formatAiText(replyText);
    }
    history.push({ role: "assistant", content: replyText, model: data.model });    statusEl.textContent = `準備完了（${targetModelInfo.name} で回答）。会話はD1に保存されています。`;
    void fetchSessionsList(user, sendAuthVersion);
  } catch (error) {
    if (requestVersion !== generationRequestVersion || currentUid !== sendUid ||
        authStateVersion !== sendAuthVersion || currentSessionId !== sendSessionId) return;
    if (error?.name === "AbortError") return;
    history.pop();
    userBubble.parentElement?.parentElement?.remove();
    assistantBubble.parentElement?.parentElement?.remove();
    promptEl.value = text;
    if (attachment) {
      currentAttachment = attachment;
      showAttachmentPreview(attachment.name, "📄");
    }
    showError(error?.message || "通信エラーが発生しました。");
    statusEl.textContent = "回答の取得に失敗しました。";
  } finally {
    if (requestVersion === generationRequestVersion) {
      generating = false;
      generationAbortController = null;
      syncUI();
      if (currentUid) promptEl.focus();
    }
  }
}

const chatFormEl = $("inputForm") || $("chatForm");
if (chatFormEl) {
  chatFormEl.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = promptEl.value.trim();
    if ((!text && !currentAttachment) || !currentUser || generating || loadingHistory) return;
    promptEl.value = "";
    promptEl.style.height = "auto";
    await sendMessage(text || "ファイルを解析してください。");
  });
}

promptEl.addEventListener("input", () => {
  promptEl.style.height = "auto";
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 140)}px`;
});

promptEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    if (chatFormEl) chatFormEl.requestSubmit();
  }
});

// この会話をD1から削除
if (clearChatBtn) {
  clearChatBtn.addEventListener("click", async () => {
    const user = currentUser;
    const uidForRequest = currentUid;
    const conversationId = currentSessionId;
    const authVersionForRequest = authStateVersion;
    if (!user || generating || loadingHistory || sessionMutationPending) return;
    if (!window.confirm("現在の会話をCloudflare D1から削除しますか？")) return;

    if (!conversationId) {
      history = [];
      renderHistory();
      statusEl.textContent = "未保存の会話を消去しました。";
      return;
    }

    const operationVersion = ++sessionOperationVersion;
    sessionMutationPending = true;
    statusEl.textContent = "会話を削除しています…";
    syncUI();
    try {
      const token = await user.getIdToken();
      const response = await workerFetch(`/v1/conversations/${encodeURIComponent(conversationId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || `会話の削除に失敗しました (${response.status})`);
      }
      if (currentUid !== uidForRequest || authStateVersion !== authVersionForRequest || currentSessionId !== conversationId) return;

      sessions = sessions.filter((session) => session.id !== conversationId);
      currentSessionId = null;
      currentSessionTitle = "新しいチャット";
      history = [];
      sessionTitleDisplay.textContent = currentSessionTitle;
      renderHistory();
      renderSessionsList();
      statusEl.textContent = "会話をD1から削除しました。次の質問は新しい会話になります。";
    } catch (error) {
      if (currentUid === uidForRequest && authStateVersion === authVersionForRequest && currentSessionId === conversationId) {
        showError(error?.message || "会話の削除に失敗しました。");
        statusEl.textContent = "会話の削除に失敗しました。";
      }
    } finally {
      if (sessionOperationVersion === operationVersion) sessionMutationPending = false;
      syncUI();
    }
  });
}

renderHistory();
syncUI();

// 認証監視
async function handleAuthChange(user) {
  const nextUid = user?.uid || null;
  const identityChanged = nextUid !== currentUid;

  if (identityChanged) {
    authStateVersion += 1;
    navigationRequestVersion += 1;
    sessionOperationVersion += 1;
    sessionMutationPending = false;
    cancelActiveGeneration();
    invalidateHistoryRequest();
    sessionsRequestVersion += 1;
    history = [];
    sessions = [];
    currentSessionId = null;
    currentSessionTitle = "新しいチャット";
    clearAttachment();
    closeDrawer();
  }

  ensureDomElements();
  currentUser = user;
  currentUid = nextUid;
  if (identityChanged) {
    if (sessionTitleDisplay) sessionTitleDisplay.textContent = currentSessionTitle;
    renderHistory();
    renderSessionsList();
  }

  if (!currentUid || !user) {
    if (authGateTitleEl) authGateTitleEl.textContent = "SNSのログインが必要です";
    if (authMessageEl) authMessageEl.textContent = "AIスタジオを使うには、もこり（SNS）にログインしてください。ログイン後、このページに戻ると自動で使えるようになります。";
    if (authLoginLinkEl) authLoginLinkEl.hidden = false;
    if (errorEl) errorEl.hidden = true;
    if (statusEl) statusEl.textContent = "SNSへのログインが必要です。";
    syncUI();
    return;
  }
  if (authLoginLinkEl) authLoginLinkEl.hidden = true;

  const uidForRequest = currentUid;
  const authVersionForRequest = authStateVersion;
  if (authGateTitleEl) authGateTitleEl.textContent = "SNSにログインしています";
  if (authMessageEl) authMessageEl.textContent = "SNSのログインを確認しました。";
  if (authGateEl) authGateEl.hidden = true;
  if (welcomeEl && history.length === 0) welcomeEl.hidden = false;
  syncUI();

  const listLoaded = await fetchSessionsList(user, authVersionForRequest);
  if (currentUid !== uidForRequest || authStateVersion !== authVersionForRequest) return;
  if (listLoaded && !currentSessionId && sessions.length > 0) {
    currentSessionId = sessions[0].id;
    currentSessionTitle = sessions[0].title || "チャット";
    if (sessionTitleDisplay) sessionTitleDisplay.textContent = currentSessionTitle;
    renderSessionsList();
  }

  const sessionIdForRequest = currentSessionId;
  const fetched = sessionIdForRequest
    ? await fetchD1History(user, sessionIdForRequest, authVersionForRequest)
    : [];
  if (!Array.isArray(fetched) || currentUid !== uidForRequest ||
      authStateVersion !== authVersionForRequest || currentSessionId !== sessionIdForRequest) return;

  history = fetched;
  renderHistory();
  if (statusEl) statusEl.textContent = "準備完了。会話はCloudflare D1にサーバー保存されています。";
  syncUI();
  if (promptEl) promptEl.focus();
}

auth.onAuthStateChanged(handleAuthChange, (error) => {
  authStateVersion += 1;
  navigationRequestVersion += 1;
  sessionOperationVersion += 1;
  sessionMutationPending = false;
  cancelActiveGeneration();
  invalidateHistoryRequest();
  sessionsRequestVersion += 1;
  currentUser = null;
  currentUid = null;
  history = [];
  sessions = [];
  currentSessionId = null;
  currentSessionTitle = "新しいチャット";
  clearAttachment();
  closeDrawer();
  renderHistory();
  renderSessionsList();
  if (authGateTitleEl) authGateTitleEl.textContent = "ログイン状態を確認できません";
  if (authMessageEl) authMessageEl.textContent = "ログイン状態を確認できませんでした。SNSにログインし直してください。";
  if (statusEl) statusEl.textContent = "Firebase Authenticationの確認に失敗しました。";
  showError(error?.message || "認証状態を確認できませんでした。");
  syncUI();
});

// 既にcurrentUserが解決している場合は即座に初期化
if (auth.currentUser) {
  handleAuthChange(auth.currentUser);
}


// プライベートブラウズ対応: セッション自動復元
try {
  const savedSession = sessionStorage.getItem("myyajuu_auth_session") || localStorage.getItem("myyajuu_auth_session");
  if (savedSession) {
    const parsed = JSON.parse(savedSession);
    if (parsed.email && parsed.pass && !auth.currentUser) {
      auth.signInWithEmailAndPassword(parsed.email, parsed.pass).catch(() => {});
    }
  }
} catch (e) {}
