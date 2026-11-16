// 名前の最新化ヘルパーのロジック検証（server.js から関数本体をそのまま読み出して実行する）
// 実行: node tests/name-freshness.test.js
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");

function extract(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`not found: ${name}`);
  let depth = 0;
  let i = src.indexOf("{", start);
  const from = i;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced: ${name} (${from})`);
}

const code = ["currentUserName", "freshMemberInfo", "freshSenderName"].map(extract).join("\n");
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(code, sandbox);
const { currentUserName, freshMemberInfo, freshSenderName } = sandbox;

let failed = 0;
function eq(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    failed++;
    console.log(`NG ${label}\n   actual  : ${a}\n   expected: ${e}`);
  } else {
    console.log(`OK ${label}`);
  }
}

// 改名前のスナップショット（DBに入っている古い名前）
const names = new Map([["uidA", "あたらしい名前"], ["uidB", "Bさん"]]);
const memberInfo = {
  uidA: { username: "ふるい名前", joinedAt: 1000 },
  uidB: { username: "Bさん", joinedAt: 2000 },
  ai_assistant: { username: "AIアシスタント", isAi: true }
};

// 1) memberInfo のユーザー名だけが最新化され、joinedAt 等は残る
const fresh = freshMemberInfo(memberInfo, names);
eq("memberInfo: 改名した人の名前が最新になる", fresh.uidA.username, "あたらしい名前");
eq("memberInfo: joinedAt は保持される", fresh.uidA.joinedAt, 1000);
eq("memberInfo: 変わっていない人はそのまま", fresh.uidB.username, "Bさん");
eq("memberInfo: AIなど users にいないメンバーはそのまま", fresh.ai_assistant.username, "AIアシスタント");
eq("memberInfo: 元データは書き換えない", memberInfo.uidA.username, "ふるい名前");

// 2) メッセージの送信者名が最新化される
const oldMsg = { id: "m1", senderUid: "uidA", senderName: "ふるい名前", text: "こんにちは" };
const newMsg = freshSenderName(oldMsg, names);
eq("message: 送信者名が最新になる", newMsg.senderName, "あたらしい名前");
eq("message: 本文は変わらない", newMsg.text, "こんにちは");
eq("message: 元データは書き換えない", oldMsg.senderName, "ふるい名前");

// 3) システム / AI / 退会済みユーザーはフォールバック（古い名前を保持）
eq("message: system はそのまま", freshSenderName({ senderUid: "system", senderName: "システム" }, names).senderName, "システム");
eq("message: AI はそのまま", freshSenderName({ senderUid: "ai_assistant", senderName: "AIアシスタント" }, names).senderName, "AIアシスタント");
eq("message: 見つからないユーザーは元の名前", freshSenderName({ senderUid: "gone", senderName: "昔の人" }, names).senderName, "昔の人");

// 4) DM のルーム名（相手名）解決
eq("DM名: 現在名を使う", currentUserName(names, "uidA", "フォールバック"), "あたらしい名前");
eq("DM名: 見つからなければフォールバック", currentUserName(names, "gone", "フォールバック"), "フォールバック");

console.log(failed === 0 ? "\nALL OK" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
