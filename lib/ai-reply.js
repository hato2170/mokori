"use strict";

// チャット内の「AIアシスタント」の返答生成。
// Cloudflare Worker（myyajuu-ai-worker）を呼び、失敗したらモデルを落として再試行し、
// 会話がいっぱい（conversation_full）等のときは新しい会話として作り直す。
// 画面側（server.js の setTimeout 内）から使うため、副作用（DB更新）は呼び出し側で行う。

const WORKER_CHAT_URL = "https://myyajuu-ai-worker.harumei-260329.workers.dev/v1/chat";
const PRIMARY_MODEL = "@cf/openai/gpt-oss-20b";
const FALLBACK_MODEL = "@cf/meta/llama-3.2-3b-instruct";
const TIMEOUT_PRIMARY_MS = 45000; // GPT-OSS 20B は日本語の長文で25秒を超えることがある
const TIMEOUT_FALLBACK_MS = 25000;

// 新しい会話に切り替えれば解決するエラー
const RESTARTABLE_CONVERSATION_ERROR = /conversation_full/i;
// モデルを変えても同じ結果になるエラー（ここで打ち切る）
const FATAL_ERROR = /user_daily_limit|request_in_progress|daily_budget_reached|unauthorized|invalid_token|auth_verification_unavailable|conversation_limit/i;

function errorCodeOf(body) {
  if (!body || typeof body !== "object") return "";
  return String(body.error || body.code || "").trim();
}

function messageOf(body) {
  if (!body || typeof body !== "object") return "";
  return String(body.message || "").trim();
}

function replyTextOf(body) {
  if (!body || typeof body !== "object") return "";
  if (typeof body.assistantMessage === "object" && body.assistantMessage && typeof body.assistantMessage.content === "string") {
    return body.assistantMessage.content;
  }
  for (const key of ["reply", "response", "message"]) {
    if (typeof body[key] === "string" && body[key].trim()) return body[key];
  }
  return "";
}

async function callWorker({ fetchImpl, authHeader, message, model, conversationId, timeoutMs }) {
  const payload = { message, model, webSearch: false };
  if (conversationId) payload.conversationId = conversationId;
  const response = await fetchImpl(WORKER_CHAT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: authHeader,
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let body = {};
  try {
    body = await response.json();
  } catch (_) {
    body = {};
  }
  return { ok: response.ok, status: response.status, body };
}

/**
 * AIの返答を作る。
 * @returns {Promise<{text: string, conversationId: string|null, model: string, error: string}>}
 *   text が空なら error に理由が入る（成功を装う定型文は返さない）。
 */
async function generateAiReply({
  authHeader,
  message,
  conversationId = null,
  fetchImpl = fetch,
  log = console.warn,
}) {
  let currentConversationId = conversationId || null;
  let lastError = "";
  let lastModel = PRIMARY_MODEL;

  const attempts = [
    { model: PRIMARY_MODEL, timeoutMs: TIMEOUT_PRIMARY_MS },
    { model: FALLBACK_MODEL, timeoutMs: TIMEOUT_FALLBACK_MS },
  ];

  for (const attempt of attempts) {
    lastModel = attempt.model;
    let restartedConversation = false;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let result;
      try {
        result = await callWorker({
          fetchImpl,
          authHeader,
          message,
          model: attempt.model,
          conversationId: currentConversationId,
          timeoutMs: attempt.timeoutMs,
        });
      } catch (error) {
        lastError = error && error.name === "TimeoutError" ? "timeout" : (error && error.message) || "network";
        log("[AI] fetch failed:", attempt.model, lastError);
        break; // 次のモデルへ
      }

      if (result.ok) {
        const text = replyTextOf(result.body).trim();
        const returnedConversationId = typeof result.body.conversationId === "string" && result.body.conversationId
          ? result.body.conversationId
          : currentConversationId;
        if (!text) {
          lastError = "empty_reply";
          log("[AI] empty reply:", attempt.model);
          break; // 次のモデルへ
        }
        return { text, conversationId: returnedConversationId, model: attempt.model, error: "" };
      }

      const code = errorCodeOf(result.body);
      const detail = `${result.status} ${code || messageOf(result.body)}`.trim();
      lastError = detail;
      log("[AI] worker responded:", attempt.model, result.status, code || "");

      // 会話がいっぱい／上限 → 会話IDを捨てて、同じモデルで1回だけ新規会話として再試行
      if (RESTARTABLE_CONVERSATION_ERROR.test(code) && currentConversationId && !restartedConversation) {
        restartedConversation = true;
        lastError = "conversation_full_restart";
        log("[AI] conversation full; retrying with a new conversation:", attempt.model);
        currentConversationId = null;
        continue;
      }

      if (FATAL_ERROR.test(code)) return { text: "", conversationId: currentConversationId, model: attempt.model, error: detail };
      break; // 次のモデルへ（5xx・empty_model_response など）
    }
  }

  return { text: "", conversationId: currentConversationId, model: lastModel, error: lastError };
}

/** 失敗理由を、チャットにそのまま出せる日本語にする */
function aiErrorText(error) {
  const e = String(error || "");
  if (/user_daily_limit/i.test(e)) {
    return "ごめんね、今日AIを使える回数の上限（20回）に達してしまいました。明日の朝9時以降また話しかけてね！";
  }
  if (/daily_budget_reached/i.test(e)) {
    return "ごめんね、いまAIの無料枠がいっぱいです。しばらく時間をおいてからもう一度送ってみてね。";
  }
  if (/request_in_progress/i.test(e)) {
    return "前の返事をまだ作っている途中みたい。少し待ってからもう一度送ってね。";
  }
  if (/conversation_limit/i.test(e)) {
    return "AIの会話の数がいっぱいになったみたい。AIスタジオの会話一覧から、使っていない会話を消してみてね。";
  }
  if (/conversation_full|conversation_full_restart/i.test(e)) {
    return "このAIとの会話が長くなりすぎたみたい。もう一度送ると新しい会話で答えるね。";
  }
  if (/timeout/i.test(e)) {
    return "ごめんね、AIの返事が時間内に返ってこなかったよ。もう一度送ってみてね。";
  }
  if (/empty_reply|empty_model_response/i.test(e)) {
    return "ごめんね、AIがうまく答えを作れなかったみたい。もう一度送ってみてね。";
  }
  return "ごめんね、いまAIにつながらなかったよ。少し待ってからもう一度送ってみてね。" + (e ? `\n（エラー: ${e.slice(0, 80)}）` : "");
}

module.exports = { generateAiReply, aiErrorText, PRIMARY_MODEL, FALLBACK_MODEL, WORKER_CHAT_URL };
