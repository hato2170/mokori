import { initializeApp } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-app.js";
import { getAuth, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.12.1/firebase-auth.js";

const firebaseConfig = {
  apiKey: "AIzaSyAXv7r2M0q22JLa0s4XcpPomf-KW19CPPE",
  authDomain: "mokori-by-riona-iwakami.firebaseapp.com",
  projectId: "mokori-by-riona-iwakami",
  storageBucket: "mokori-by-riona-iwakami.firebasestorage.app",
  messagingSenderId: "78875890394",
  appId: "1:78875890394:web:ee631706d895893ec10be3"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);

// Cloudflare Worker API URL
const WORKER_URL = window.MYYAJUU_AI_WORKER_URL || "https://myyajuu-ai-worker.harumei-260329.workers.dev";
const PROXY_URL = "https://mokori.onrender.com/api/ai";
let activeApiUrl = (function() {
  try {
    return sessionStorage.getItem("mokori_ai_use_proxy") === "true" ? PROXY_URL : WORKER_URL;
  } catch (_) {
    return WORKER_URL;
  }
})();

async function workerFetch(path, options = {}) {
  try {
    const res = await fetch(`${activeApiUrl}${path}`, options);
    // 学校iPad等のフィルターでworkers.devが401/403/502等を返した場合の自動フォールバック
    if (!res.ok && activeApiUrl !== PROXY_URL && (res.status === 401 || res.status === 403 || res.status === 502)) {
      console.warn(`Direct Workers API returned ${res.status} (filter block), falling back to Render proxy:`, path);
      activeApiUrl = PROXY_URL;
      try { sessionStorage.setItem("mokori_ai_use_proxy", "true"); } catch (_) {}
      return await fetch(`${activeApiUrl}${path}`, options);
    }
    return res;
  } catch (err) {
    if (activeApiUrl !== PROXY_URL && err?.name !== "AbortError") {
      console.warn("Direct Workers API failed (school filter detected), falling back to Render proxy:", err);
      activeApiUrl = PROXY_URL;
      try { sessionStorage.setItem("mokori_ai_use_proxy", "true"); } catch (_) {}
      return await fetch(`${activeApiUrl}${path}`, options);
    }
    throw err;
  }
}

const MODEL_CATALOG = {
  "@cf/meta/llama-3.2-3b-instruct": { name: "Llama 3.2 3B" },
  "@cf/openai/gpt-oss-20b": { name: "GPT-OSS 20B" },
  "@cf/google/gemma-4-26b-a4b-it": { name: "Gemma 4 26B" },
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": { name: "Llama 3.3 70B" },
  "@cf/qwen/qwen3-30b-a3b-fp8": { name: "Qwen3 30B" },
};

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const errorEl = $("error");
const promptEl = $("prompt");
const sendButton = $("sendButton");
const messagesEl = $("messages");
const welcomeEl = $("welcome");
const authGateEl = $("authGate");
const authGateTitleEl = $("authGateTitle");
const authMessageEl = $("authMessage");
const modelSelectEl = $("modelSelect");

// Sessions / Project elements
const sessionTitleDisplay = $("sessionTitleDisplay");
const sessionsBtn = $("sessionsBtn");
const newChatBtn = $("newChatBtn");
const sessionsDrawer = $("sessionsDrawer");
const drawerOverlay = $("drawerOverlay");
const closeDrawerBtn = $("closeDrawerBtn");
const drawerNewChatBtn = $("drawerNewChatBtn");
const sessionsList = $("sessionsList");

// Toolbar elements
const webSearchToggle = $("webSearchToggle");
const webSearchState = $("webSearchState");
const imageGenBtn = $("imageGenBtn");
const attachBtn = $("attachBtn");
const fileInput = $("fileInput");
const clearChatBtn = $("clearChatBtn");
const attachmentPreviewArea = $("attachmentPreviewArea");
const attachmentName = $("attachmentName");
const removeAttachmentBtn = $("removeAttachmentBtn");

// 会話データ・セッションデータはメモリ上にのみ保持（LocalStorage, SessionStorage, IndexedDB, Cache API には一切保存しない）
let history = [];
let sessions = [];
let currentSessionId = null;
let currentSessionTitle = "新しいチャット";
let currentUser = null;
let currentUid = null;
let generating = false;
let loadingHistory = false;
let selectedModelId = "@cf/meta/llama-3.2-3b-instruct";
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

if (modelSelectEl) {
  modelSelectEl.value = selectedModelId;
  modelSelectEl.disabled = false;
  modelSelectEl.addEventListener("change", (event) => {
    if (MODEL_CATALOG[event.target.value]) selectedModelId = event.target.value;
  });
}

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

// ファイル添付ボタン
if (attachBtn && fileInput) {
  attachBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (!file) return;

    if (file.size > 2 * 1024 * 1024) {
      alert("ファイルサイズは2MB以内で指定してください。");
      fileInput.value = "";
      return;
    }

    currentAttachment = null;
    attachmentPreviewArea.hidden = true;
    if (file.type.startsWith("image/")) {
      const imgReader = new FileReader();
      const readVersion = ++attachmentReadVersion;
      const uidForRead = currentUid;
      const authVersionForRead = authStateVersion;
      imgReader.onerror = () => {
        if (readVersion === attachmentReadVersion && currentUid === uidForRead && authStateVersion === authVersionForRead) {
          showError("画像を読み込めませんでした。");
        }
      };
      imgReader.onload = (evt) => {
        if (readVersion !== attachmentReadVersion || currentUid !== uidForRead || authStateVersion !== authVersionForRead) return;
        currentAttachment = {
          name: file.name,
          type: "image",
          content: evt.target.result,
          isImage: true,
        };
        showAttachmentPreview(file.name, "🖼️");
      };
      imgReader.readAsDataURL(file);
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
  attachmentName.textContent = `${icon} ${name}`;
  attachmentPreviewArea.hidden = false;
}

function clearAttachment() {
  attachmentReadVersion += 1;
  currentAttachment = null;
  attachmentPreviewArea.hidden = true;
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
  const signedIn = Boolean(currentUid);
  const busy = generating || loadingHistory || sessionMutationPending;
  authGateEl.hidden = signedIn;
  promptEl.disabled = !signedIn || busy;
  sendButton.disabled = !signedIn || busy;
  if (modelSelectEl) modelSelectEl.disabled = !signedIn || busy;
  if (attachBtn) attachBtn.disabled = !signedIn || busy;
  if (imageGenBtn) imageGenBtn.disabled = !signedIn || busy;
  if (webSearchToggle) webSearchToggle.disabled = !signedIn || busy;
  if (sessionsBtn) sessionsBtn.disabled = !signedIn || busy;
  if (newChatBtn) newChatBtn.disabled = !signedIn || busy;
  if (drawerNewChatBtn) drawerNewChatBtn.disabled = !signedIn || busy;
  if (clearChatBtn) clearChatBtn.disabled = !signedIn || busy;

  if (!signedIn) {
    welcomeEl.hidden = true;
    closeDrawer();
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
  textNode.textContent = text;
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
    const token = await user.getIdToken();
    let response;
    try {
      response = await workerFetch(`/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          message: fullMessageText,
          model: targetModelId,
          webSearch: webSearchEnabled,
          ...(sendSessionId ? { conversationId: sendSessionId } : {}),
        }),
        signal: controller.signal,
      });
    } catch (netErr) {
      if (netErr?.name === "AbortError") throw netErr;
      await new Promise((r) => setTimeout(r, 400));
      const freshToken = await user.getIdToken(true);
      response = await workerFetch(`/v1/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${freshToken}`,
        },
        body: JSON.stringify({
          message: fullMessageText,
          model: targetModelId,
          webSearch: webSearchEnabled,
          ...(sendSessionId ? { conversationId: sendSessionId } : {}),
        }),
        signal: controller.signal,
      });
    }

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      let msg = errData.message || `エラーが発生しました (${response.status})`;
      if (response.status === 429) {
        if (errData.error === "user_daily_limit") {
          msg = "本日の利用上限（20回）に達しました。明日またご利用ください。";
        } else if (errData.error === "daily_budget_reached") {
          msg = "本日のAI無料枠上限に達しました。時間を置いてお試しください。";
        } else if (errData.error === "request_in_progress") {
          msg = "前回の回答を処理中です。少し待ってから送信してください。";
        }
      }
      throw new Error(msg);
    }

    const data = await response.json();
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
      throw new Error("Workerから選択したモデルの利用を確認できませんでした。");
    }
    if (requestVersion !== generationRequestVersion || currentUid !== sendUid ||
        authStateVersion !== sendAuthVersion || currentSessionId !== sendSessionId) return;

    currentSessionId = data.conversationId;
    if (!sendSessionId) {
      currentSessionTitle = [...fullMessageText].slice(0, 80).join("") || "新しいチャット";
      sessionTitleDisplay.textContent = currentSessionTitle;
    }
    assistantBubble.textContent = replyText;
    history.push({ role: "assistant", content: replyText, model: data.model });
    statusEl.textContent = `準備完了（${targetModelInfo.name} で回答）。会話はD1に保存されています。`;
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

$("chatForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = promptEl.value.trim();
  if ((!text && !currentAttachment) || !currentUser || generating || loadingHistory) return;
  promptEl.value = "";
  promptEl.style.height = "auto";
  await sendMessage(text || "ファイルを解析してください。");
});

promptEl.addEventListener("input", () => {
  promptEl.style.height = "auto";
  promptEl.style.height = `${Math.min(promptEl.scrollHeight, 140)}px`;
});

promptEl.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    $("chatForm").requestSubmit();
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
onAuthStateChanged(auth, async (user) => {
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

  currentUser = user;
  currentUid = nextUid;
  if (identityChanged) {
    sessionTitleDisplay.textContent = currentSessionTitle;
    renderHistory();
    renderSessionsList();
  }

  if (!currentUid || !user) {
    authGateTitleEl.textContent = "SNSのログインが必要です";
    authMessageEl.textContent = "AIチャットを利用するには、SNSにログインしてください。ログイン後、このページに戻ってください。";
    errorEl.hidden = true;
    statusEl.textContent = "SNSへのログインが必要です。";
    syncUI();
    return;
  }

  const uidForRequest = currentUid;
  const authVersionForRequest = authStateVersion;
  authGateTitleEl.textContent = "SNSにログインしています";
  authMessageEl.textContent = "SNSのログインを確認しました。";
  syncUI();

  const listLoaded = await fetchSessionsList(user, authVersionForRequest);
  if (currentUid !== uidForRequest || authStateVersion !== authVersionForRequest) return;
  if (listLoaded && !currentSessionId && sessions.length > 0) {
    currentSessionId = sessions[0].id;
    currentSessionTitle = sessions[0].title || "チャット";
    sessionTitleDisplay.textContent = currentSessionTitle;
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
  statusEl.textContent = "準備完了。会話はCloudflare D1にサーバー保存されています。";
  syncUI();
  promptEl.focus();
}, (error) => {
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
  authGateTitleEl.textContent = "ログイン状態を確認できません";
  authMessageEl.textContent = "ログイン状態を確認できませんでした。SNSにログインし直してください。";
  statusEl.textContent = "Firebase Authenticationの確認に失敗しました。";
  showError(error?.message || "認証状態を確認できませんでした。");
  syncUI();
});


// プライベートブラウズ対応: セッション自動復元
try {
  const savedSession = sessionStorage.getItem("myyajuu_auth_session") || localStorage.getItem("myyajuu_auth_session");
  if (savedSession) {
    const parsed = JSON.parse(savedSession);
    if (parsed.email && parsed.pass && !auth.currentUser) {
      import("https://www.gstatic.com/firebasejs/11.0.1/firebase-auth.js").then(({ signInWithEmailAndPassword }) => {
        signInWithEmailAndPassword(auth, parsed.email, parsed.pass).catch(() => {});
      });
    }
  }
} catch (e) {}
