// 一時診断用: BotGuard経由のPOトークン生成と、それを使ったYouTube音源URL取得の実測
// (作業完了後に削除)

const UA_WEB = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const UA_IOS = "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)";
const UA_VR = "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12; en_US; Quest 3; Build/SQ3A.220605.009.A1) gzip";

const CLIENTS = {
  WEB: { num: "1", ver: "2.20250312.04.00", ua: UA_WEB, ctx: { client: { clientName: "WEB", clientVersion: "2.20250312.04.00", hl: "ja", gl: "JP", utcOffsetMinutes: 540 } } },
  WEB_EMBEDDED: { num: "56", ver: "1.20250310.01.00", ua: UA_WEB, ctx: { client: { clientName: "WEB_EMBEDDED_PLAYER", clientVersion: "1.20250310.01.00", hl: "ja", gl: "JP", utcOffsetMinutes: 540 }, thirdParty: { embedUrl: "https://www.youtube.com/" } } },
  MWEB: { num: "2", ver: "2.20250312.04.00", ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1", ctx: { client: { clientName: "MWEB", clientVersion: "2.20250312.04.00", hl: "ja", gl: "JP", utcOffsetMinutes: 540 } } },
  ANDROID_VR: { num: "28", ver: "1.62.27", ua: UA_VR, ctx: { client: { clientName: "ANDROID_VR", clientVersion: "1.62.27", androidSdkVersion: 32, osName: "Android", osVersion: "12", deviceMake: "Oculus", deviceModel: "Quest 3", hl: "ja", gl: "JP", utcOffsetMinutes: 540 } } },
  IOS: { num: "5", ver: "20.10.4", ua: UA_IOS, ctx: { client: { clientName: "IOS", clientVersion: "20.10.4", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.2.22D82", hl: "ja", gl: "JP", utcOffsetMinutes: 540 } } },
};

const TIMEOUT = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout:" + label)), ms))]);

async function getVisitorData() {
  const r = await fetch("https://www.youtube.com/?hl=ja&gl=JP", {
    headers: { "User-Agent": UA_WEB, "Accept-Language": "ja,en;q=0.8", "Accept": "text/html,application/xhtml+xml" },
    signal: AbortSignal.timeout(12000)
  });
  const html = await r.text();
  const vd = html.match(/"visitorData"\s*:\s*"([^"]+)"/);
  const rk = html.match(/"requestKey"\s*:\s*"([^"]+)"/);
  return { status: r.status, htmlLen: html.length, visitorData: vd ? vd[1] : "", requestKey: rk ? rk[1] : "" };
}

async function getRequestKeyViaAttGet(visitorData) {
  const r = await fetch("https://www.youtube.com/youtubei/v1/att/get?prettyPrint=false", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA_WEB,
      "X-Youtube-Client-Name": "1",
      "X-Youtube-Client-Version": "2.20250312.04.00",
      "X-Goog-Visitor-Id": visitorData || "",
      "Origin": "https://www.youtube.com"
    },
    body: JSON.stringify({
      context: { client: { clientName: "WEB", clientVersion: "2.20250312.04.00", hl: "ja", gl: "JP", visitorData } },
      engagementType: "ENGAGEMENT_TYPE_UNBOUND"
    }),
    signal: AbortSignal.timeout(12000)
  });
  const j = await r.json();
  return {
    status: r.status,
    keys: Object.keys(j || {}),
    bgChallengeKeys: j?.bgChallenge ? Object.keys(j.bgChallenge) : null,
    challenge: typeof j?.challenge === "string" ? j.challenge.slice(0, 40) : null,
    bgChallenge: j?.bgChallenge ? {
      interpreterHash: j.bgChallenge.interpreterHash,
      globalName: j.bgChallenge.globalName,
      programLen: (j.bgChallenge.program || "").length,
      interpreterJavascriptLen: ((j.bgChallenge.interpreterJavascript || {}).privateDoNotAccessOrElseSafeScriptWrappedValue || "").length,
      interpreterUrl: ((j.bgChallenge.interpreterUrl || {}).privateDoNotAccessOrElseTrustedResourceUrlWrappedValue || "").slice(0, 80)
    } : null,
    raw: j
  };
}

async function getAttChallengeRaw(visitorData) {
  const r = await fetch("https://www.youtube.com/youtubei/v1/att/get?prettyPrint=false", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": UA_WEB,
      "X-Youtube-Client-Name": "1",
      "X-Youtube-Client-Version": "2.20250312.04.00",
      "X-Goog-Visitor-Id": visitorData || "",
      "Origin": "https://www.youtube.com"
    },
    body: JSON.stringify({
      context: { client: { clientName: "WEB", clientVersion: "2.20250312.04.00", hl: "ja", gl: "JP", visitorData } },
      engagementType: "ENGAGEMENT_TYPE_UNBOUND"
    }),
    signal: AbortSignal.timeout(12000)
  });
  const j = await r.json();
  const bgc = j.bgChallenge || {};
  let interpreterJs = (bgc.interpreterJavascript || {}).privateDoNotAccessOrElseSafeScriptWrappedValue || "";
  const interpreterUrl = (bgc.interpreterUrl || {}).privateDoNotAccessOrElseTrustedResourceUrlWrappedValue || "";
  if (!interpreterJs && interpreterUrl) {
    const u = interpreterUrl.startsWith("http") ? interpreterUrl : "https:" + (interpreterUrl.startsWith("//") ? interpreterUrl : "//" + interpreterUrl);
    const r2 = await fetch(u, { headers: { "User-Agent": UA_WEB }, signal: AbortSignal.timeout(12000) });
    if (r2.ok) interpreterJs = await r2.text();
  }
  return {
    interpreterJs,
    interpreterUrl,
    program: bgc.program || "",
    globalName: bgc.globalName || "",
    interpreterHash: bgc.interpreterHash || "",
    clientExperimentsStateBlob: bgc.clientExperimentsStateBlob || "",
    challenge: j.challenge || ""
  };
}

async function mintPoToken(videoId) {  const rep = { stages: {}, poToken: "", visitorData: "" };
  const step = async (name, fn) => {
    try {
      const v = await TIMEOUT(fn(), 25000, name);
      rep.stages[name] = { ok: true, info: summarize(v) };
      return v;
    } catch (e) {
      rep.stages[name] = { ok: false, error: String(e && e.message || e).slice(0, 200) };
      return null;
    }
  };
  function summarize(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === "string") return v.slice(0, 80);
    if (typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v).slice(0, 12)) {
        const x = v[k];
        o[k] = typeof x === "string" ? x.slice(0, 60) : (typeof x === "number" || typeof x === "boolean" ? x : (x && x.__summary ? String(x.__summary).slice(0, 60) : (Array.isArray(x) ? "array:" + x.length : typeof x)));
      }
      return o;
    }
    return String(v).slice(0, 60);
  }

  const page = await step("page", getVisitorData);
  if (!page) return rep;
  rep.visitorData = page.visitorData;

  // /att/get から challenge(requestKey) と bgChallenge(interpreter/program/globalName) を取る
  let att = null;
  try {
    const r = await TIMEOUT(getRequestKeyViaAttGet(page.visitorData), 20000, "attGet");
    att = r;
    rep.stages.attGet = { ok: true, info: r.bgChallenge };
    rep.stages.attGetChallenge = { ok: true, info: { challengePrefix: (r.challenge || "").slice(0, 60), len: (r.challenge || "").length } };
  } catch (e) {
    rep.stages.attGet = { ok: false, error: String(e && e.message || e).slice(0, 160) };
    return rep;
  }
  const attChallenge = att.bgChallenge || null;
  if (!attChallenge) return rep;

  let interpreterJs = "";
  let program = "";
  let globalName = "";
  try {
    const bgc = await TIMEOUT(getAttChallengeRaw(page.visitorData), 20000, "attRaw");
    interpreterJs = bgc.interpreterJs;
    program = bgc.program;
    globalName = bgc.globalName;
    rep.stages.attRaw = { ok: true, info: { programLen: program.length, interpreterJsLen: interpreterJs.length, globalName } };
  } catch (e) {
    rep.stages.attRaw = { ok: false, error: String(e && e.message || e).slice(0, 160) };
  }

  // 万一 att/get から取れなければ WAA Create でフォールバック
  if (!interpreterJs && att.challenge) {
    const ch = await step("waaChallenge", async () => {
      const bg = await import("bgutils-js/botguard");
      const c = await bg.getChallenge({ requestKey: att.challenge, fetchFunction: fetch });
      return c;
    });
    if (ch) {
      interpreterJs = (ch.interpreterJavascript || {}).privateDoNotAccessOrElseSafeScriptWrappedValue || "";
      program = ch.program || "";
      globalName = ch.globalName || "";
      rep.stages.waaShape = { ok: true, info: { programLen: program.length, interpreterJsLen: interpreterJs.length, globalName } };
    }
  }
  if (!interpreterJs) return rep;

  // interpreter を Node のグローバルで動かすための最小シム
  const before = typeof globalThis.window;
  if (typeof globalThis.window === "undefined") {
    globalThis.window = globalThis;
  }
  if (typeof globalThis.document === "undefined") {
    globalThis.document = {
      createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
      getElementById: () => null,
      querySelector: () => null,
      head: { appendChild() {} },
      body: { appendChild() {} },
      documentElement: { style: {} },
      cookie: "",
      location: { href: "https://www.youtube.com/" }
    };
  }
  rep.stages.shim = { ok: true, info: { hadWindow: before, nowWindow: typeof globalThis.window } };

  const bg = await import("bgutils-js/botguard").catch(e => ({ __err: String(e && e.message || e) }));
  const utils = await import("bgutils-js/utils").catch(e => ({ __err: String(e && e.message || e) }));
  const webpo = await import("bgutils-js/webpo").catch(e => ({ __err: String(e && e.message || e) }));
  if (bg.__err || utils.__err || webpo.__err) {
    rep.stages.imports = { ok: false, error: (bg.__err || utils.__err || webpo.__err) };
    return rep;
  }
  rep.stages.imports = { ok: true, info: { botguard: Object.keys(bg), webpo: Object.keys(webpo) } };

  // challenge 以降の旧経路は削除済み
  if (!interpreterJs) return rep;

  const evalOk = await step("evalInterpreter", () => { new Function(interpreterJs)(); return { hasGlobalName: typeof globalThis[globalName] }; });
  rep.stages.evalOk = evalOk;

  const client = await step("botguardClient", () => bg.BotGuardClient.create({ program, globalName, globalObject: globalThis }));
  if (!client) return rep;

  const webPoSignalOutput = [];
  const attemptSnapshot = async (args) => {
    const out = await step("snapshot", () => client.snapshot(args));
    await new Promise(r => setTimeout(r, 700));
    return { out, fns: webPoSignalOutput.filter(Boolean).length };
  };
  let snap = await attemptSnapshot({ webPoSignalOutput, contentBinding: { c: page.visitorData, e: "ENGAGEMENT_TYPE_UNBOUND" } });
  rep.stages.snapshotFns = { ok: true, info: { fns: snap.fns } };
  if (!snap.fns) {
    snap = await attemptSnapshot({ webPoSignalOutput, skipPrivacyBuffer: true });
    rep.stages.snapshotFns2 = { ok: true, info: { fns: snap.fns } };
  }
  const bgResp = snap.out;
  if (!bgResp) return rep;
  rep.stages.snapshotLen = { ok: true, info: { len: String(bgResp).length, signalFns: snap.fns } };

  const itRes = await step("integrityToken", async () => {
    const url = utils.buildURL ? utils.buildURL("GenerateIT") : "https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT";
    const headers = utils.getHeaders ? utils.getHeaders() : { "content-type": "application/json+protobuf", "x-goog-api-key": "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw", "x-user-agent": "grpc-web-javascript/0.1" };
    for (const body of [JSON.stringify([bgResp]), JSON.stringify([[bgResp]])]) {
      const r = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.timeout(15000) });
      const txt = await r.text();
      if (!r.ok) { if (body === JSON.stringify([bgResp])) continue; throw new Error("GenerateIT " + r.status + " " + txt.slice(0, 80)); }
      let data;
      try { data = JSON.parse(txt); } catch (_) { throw new Error("GenerateIT non-JSON " + txt.slice(0, 80)); }
      return { status: r.status, shape: Array.isArray(data) ? "array:" + data.length : typeof data, first: JSON.stringify(data[0]).slice(0, 120), data };
    }
    throw new Error("GenerateIT failed for both bodies");
  });
  if (!itRes || !itRes.data) return rep;

  const tokenData = Array.isArray(itRes.data)
    ? { integrityToken: itRes.data[0], estimatedTtlSecs: itRes.data[1] }
    : (itRes.data.integrityToken ? itRes.data : { integrityToken: itRes.data });
  rep.stages.tokenDataShape = { ok: true, info: { hasToken: !!tokenData.integrityToken, ttl: tokenData.estimatedTtlSecs } };
  const minter = await step("minter", () => webpo.WebPoMinter.create(tokenData || {}, webPoSignalOutput));
  if (!minter) return rep;

  const poToken = await step("mint", () => minter.mintAsWebsafeString(videoId));
  rep.stages.mintLen = { ok: true, info: { len: (poToken || "").length } };
  rep.poToken = poToken || "";
  return rep;
}

async function callPlayer(videoId, key, opts = {}) {
  const poToken = opts.poToken || "";
  const visitorData = opts.visitorData || "";
  const c = CLIENTS[key];
  const body = { context: JSON.parse(JSON.stringify(c.ctx)), videoId, contentCheckOk: true, racyCheckOk: true };
  if (poToken) body.serviceIntegrityDimensions = { poToken };
  if (visitorData) body.context.client.visitorData = visitorData;
  const headers = {
    "Content-Type": "application/json", "User-Agent": c.ua,
    "X-Youtube-Client-Name": c.num, "X-Youtube-Client-Version": c.ver,
    "Origin": "https://www.youtube.com", "Accept-Language": "ja-JP,ja;q=0.9"
  };
  if (visitorData) headers["X-Goog-Visitor-Id"] = visitorData;
  try {
    const r = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
    });
    const j = await r.json();
    const ps = j.playabilityStatus || {};
    const sd = j.streamingData || {};
    const audio = (sd.adaptiveFormats || []).filter(f => String(f.mimeType || "").startsWith("audio"));
    const withUrl = audio.filter(f => f.url);
    return {
      status: ps.status, reason: String(ps.reason || "").slice(0, 50),
      audioCount: audio.length, audioWithUrl: withUrl.length,
      sample: audio.slice(0, 2).map(f => ({ itag: f.itag, bitrate: f.bitrate, cLen: f.contentLength, url: !!f.url })),
      firstUrl: withUrl[0] ? withUrl[0].url.slice(0, 100) : "",
      firstLen: withUrl[0] ? withUrl[0].contentLength : ""
    };
  } catch (e) {
    return { error: String(e && e.message || e).slice(0, 100) };
  }
}

async function runPotok(videoId) {
  const out = { videoId, at: new Date().toISOString() };
  out.mint = await mintPoToken(videoId);
  if (out.mint.poToken) {
    out.players = {};
    for (const key of Object.keys(CLIENTS)) {
      out.players[key] = await callPlayer(videoId, key, { poToken: out.mint.poToken, visitorData: out.mint.visitorData });
    }
  }
  return out;
}

module.exports = { runPotok, mintPoToken, callPlayer };
