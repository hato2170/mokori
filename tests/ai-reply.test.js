"use strict";

// lib/ai-reply.js の動作確認（ネットワーク不要・fetchを差し替えて検証）
const assert = require("assert");
const { generateAiReply, aiErrorText } = require("../lib/ai-reply");

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function ok(body) {
  return jsonResponse(200, body);
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("1本目のモデルで成功したらそのまま返す", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body.model);
    assert.ok(opts.headers.Authorization.startsWith("Bearer "));
    return ok({ conversationId: "conv-1", assistantMessage: { content: "こんにちは！" } });
  };
  const r = await generateAiReply({ authHeader: "Bearer x", message: "やあ", conversationId: null, fetchImpl, log: () => {} });
  assert.deepStrictEqual(calls, ["@cf/openai/gpt-oss-20b"]);
  assert.strictEqual(r.text, "こんにちは！");
  assert.strictEqual(r.conversationId, "conv-1");
  assert.strictEqual(r.error, "");
});

test("1本目が503 empty_model_responseなら Llama に落ちて成功する", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push(body.model);
    if (body.model === "@cf/openai/gpt-oss-20b") return jsonResponse(503, { error: "empty_model_response", message: "no response" });
    return ok({ conversationId: "conv-2", assistantMessage: { content: "東京です。" } });
  };
  const r = await generateAiReply({ authHeader: "Bearer x", message: "首都は？", fetchImpl, log: () => {} });
  assert.deepStrictEqual(calls, ["@cf/openai/gpt-oss-20b", "@cf/meta/llama-3.2-3b-instruct"]);
  assert.strictEqual(r.text, "東京です。");
  assert.strictEqual(r.conversationId, "conv-2");
});

test("会話がいっぱい(409)なら新しい会話として同じモデルで再試行して成功する", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    const body = JSON.parse(opts.body);
    calls.push({ model: body.model, conversationId: body.conversationId || null });
    if (body.conversationId === "full-conv") return jsonResponse(409, { error: "conversation_full", message: "full" });
    return ok({ conversationId: "fresh-conv", assistantMessage: { content: "新しい会話です。" } });
  };
  const r = await generateAiReply({ authHeader: "Bearer x", message: "続き", conversationId: "full-conv", fetchImpl, log: () => {} });
  assert.deepStrictEqual(calls, [
    { model: "@cf/openai/gpt-oss-20b", conversationId: "full-conv" },
    { model: "@cf/openai/gpt-oss-20b", conversationId: null },
  ]);
  assert.strictEqual(r.text, "新しい会話です。");
  assert.strictEqual(r.conversationId, "fresh-conv");
});

test("会話数上限(429 conversation_limit)は作り直しても直らないので打ち切る", async () => {
  let count = 0;
  const fetchImpl = async () => { count += 1; return jsonResponse(429, { error: "conversation_limit" }); };
  const r = await generateAiReply({ authHeader: "Bearer x", message: "hi", conversationId: null, fetchImpl, log: () => {} });
  assert.strictEqual(count, 1);
  assert.strictEqual(r.text, "");
  assert.match(r.error, /conversation_limit/);
  assert.match(aiErrorText(r.error), /会話の数がいっぱい/);
});

test("1日20回の上限はモデルを変えずに即打ち切り・日本語の案内になる", async () => {
  let count = 0;
  const fetchImpl = async () => { count += 1; return jsonResponse(429, { error: "user_daily_limit" }); };
  const r = await generateAiReply({ authHeader: "Bearer x", message: "hi", fetchImpl, log: () => {} });
  assert.strictEqual(count, 1);
  assert.match(aiErrorText(r.error), /20回/);
});

test("タイムアウトは次のモデルへ進み、両方だめなら timeout を返す", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push(JSON.parse(opts.body).model);
    const err = new Error("The operation was aborted due to timeout");
    err.name = "TimeoutError";
    throw err;
  };
  const r = await generateAiReply({ authHeader: "Bearer x", message: "hi", fetchImpl, log: () => {} });
  assert.deepStrictEqual(calls, ["@cf/openai/gpt-oss-20b", "@cf/meta/llama-3.2-3b-instruct"]);
  assert.strictEqual(r.text, "");
  assert.strictEqual(r.error, "timeout");
  assert.match(aiErrorText(r.error), /時間内に返ってこなかった/);
});

test("network エラーも日本語の案内になる", async () => {
  const fetchImpl = async () => { throw new Error("fetch failed"); };
  const r = await generateAiReply({ authHeader: "Bearer x", message: "hi", fetchImpl, log: () => {} });
  assert.strictEqual(r.text, "");
  assert.match(aiErrorText(r.error), /AIにつながらなかった/);
});

test("成功しても空文字なら成功扱いにしない", async () => {
  const fetchImpl = async () => ok({ conversationId: "c", assistantMessage: { content: "   " } });
  const r = await generateAiReply({ authHeader: "Bearer x", message: "hi", fetchImpl, log: () => {} });
  assert.strictEqual(r.text, "");
  assert.strictEqual(r.error, "empty_reply");
});

test("会話IDはサーバーが返したものを優先し、無ければ既存を維持する", async () => {
  const fetchImpl = async () => ok({ assistantMessage: { content: "ok" } });
  const r = await generateAiReply({ authHeader: "Bearer x", message: "hi", conversationId: "keep-me", fetchImpl, log: () => {} });
  assert.strictEqual(r.conversationId, "keep-me");
});

(async () => {
  let failed = 0;
  for (const t of tests) {
    try {
      await t.fn();
      console.log(`ok   ${t.name}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${t.name}\n     ${error.message}`);
    }
  }
  console.log(failed === 0 ? `\n${tests.length} tests passed` : `\n${failed} test(s) failed`);
  process.exit(failed === 0 ? 0 : 1);
})();
