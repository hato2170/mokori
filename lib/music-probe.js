// 一時診断用: Render本番のIPから何が取れるかを実測する (作業完了後に削除)
// /api/music/probe?q=STUTS%2099%20Steps

const UA_WEB = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const UA_IOS = "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)";
const UA_VR = "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12; en_US; Quest 3; Build/SQ3A.220605.009.A1) gzip";

const CLIENTS = {
  WEB: { num: "1", ver: "2.20250312.04.00", ua: UA_WEB, ctx: { client: { clientName: "WEB", clientVersion: "2.20250312.04.00", hl: "ja", gl: "JP", utcOffsetMinutes: 540 } } },
  WEB_EMBEDDED: { num: "56", ver: "1.20250310.01.00", ua: UA_WEB, ctx: { client: { clientName: "WEB_EMBEDDED_PLAYER", clientVersion: "1.20250310.01.00", hl: "ja", gl: "JP", utcOffsetMinutes: 540 }, thirdParty: { embedUrl: "https://www.youtube.com/" } } },
  MWEB: { num: "2", ver: "2.20250312.04.00", ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1", ctx: { client: { clientName: "MWEB", clientVersion: "2.20250312.04.00", hl: "ja", gl: "JP", utcOffsetMinutes: 540 } } },
  ANDROID_VR: { num: "28", ver: "1.62.27", ua: UA_VR, ctx: { client: { clientName: "ANDROID_VR", clientVersion: "1.62.27", androidSdkVersion: 32, osName: "Android", osVersion: "12", deviceMake: "Oculus", deviceModel: "Quest 3", hl: "ja", gl: "JP", utcOffsetMinutes: 540 } } },
  IOS: { num: "5", ver: "20.10.4", ua: UA_IOS, ctx: { client: { clientName: "IOS", clientVersion: "20.10.4", deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.2.22D82", hl: "ja", gl: "JP", utcOffsetMinutes: 540 } } },
  TV: { num: "7", ver: "7.20250312.16.00", ua: UA_WEB, ctx: { client: { clientName: "TVHTML5", clientVersion: "7.20250312.16.00", hl: "ja", gl: "JP", utcOffsetMinutes: 540 } } },
};

async function searchVideoId(query) {
  try {
    const r = await fetch("https://www.youtube.com/youtubei/v1/search?prettyPrint=false", {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": UA_WEB },
      body: JSON.stringify({ context: { client: { clientName: "WEB", clientVersion: "2.20250312.04.00", hl: "ja", gl: "JP" } }, query }),
      signal: AbortSignal.timeout(8000)
    });
    const j = await r.json();
    const secs = j?.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
    for (const s of secs) {
      for (const it of (s?.itemSectionRenderer?.contents || [])) {
        if (it?.videoRenderer?.videoId) return it.videoRenderer.videoId;
      }
    }
  } catch (_) {}
  return "";
}

async function callPlayer(videoId, key, { poToken = "", visitorData = "" } = {}) {
  const c = CLIENTS[key];
  const body = { context: JSON.parse(JSON.stringify(c.ctx)), videoId, contentCheckOk: true, racyCheckOk: true };
  if (poToken) body.serviceIntegrityDimensions = { poToken };
  if (visitorData) body.context.client.visitorData = visitorData;
  const headers = {
    "Content-Type": "application/json",
    "User-Agent": c.ua,
    "X-Youtube-Client-Name": c.num,
    "X-Youtube-Client-Version": c.ver,
    "Origin": "https://www.youtube.com",
    "Accept-Language": "ja-JP,ja;q=0.9"
  };
  if (visitorData) headers["X-Goog-Visitor-Id"] = visitorData;
  try {
    const r = await fetch("https://www.youtube.com/youtubei/v1/player?prettyPrint=false", {
      method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(15000)
    });
    const j = await r.json();
    const ps = j.playabilityStatus || {};
    const sd = j.streamingData || {};
    const audio = (sd.adaptiveFormats || []).filter(f => String(f.mimeType || "").startsWith("audio"));
    const muxed = (sd.formats || []).filter(f => String(f.mimeType || "").startsWith("video"));
    const withUrl = audio.filter(f => f.url);
    return {
      http: r.status,
      status: ps.status,
      reason: String(ps.reason || "").slice(0, 80),
      audioCount: audio.length,
      audioWithUrl: withUrl.length,
      audioSample: audio.slice(0, 3).map(f => ({ itag: f.itag, mime: String(f.mimeType || "").split(";")[0], bitrate: f.bitrate, cLen: f.contentLength, hasUrl: !!f.url })),
      firstAudioUrl: withUrl[0] ? withUrl[0].url.slice(0, 120) : "",
      firstAudioLen: withUrl[0] ? withUrl[0].contentLength : "",
      muxedCount: muxed.length,
      title: j?.videoDetails?.title || "",
      lengthSeconds: j?.videoDetails?.lengthSeconds || ""
    };
  } catch (e) {
    return { error: String(e && e.message || e).slice(0, 120) };
  }
}

async function makePoToken() {
  const started = Date.now();
  try {
    const mod = require("youtube-po-token-generator");
    const { visitorData, poToken } = await mod.generate();
    return { ok: true, ms: Date.now() - started, visitorDataLen: (visitorData || "").length, poTokenLen: (poToken || "").length, visitorData, poToken };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: String(e && e.message || e).slice(0, 200) };
  }
}

async function tryFetchRange(url, headers = {}) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA_WEB, ...headers, Range: "bytes=0-1023" }, signal: AbortSignal.timeout(15000) });
    const buf = Buffer.from(await r.arrayBuffer());
    return { http: r.status, ctype: r.headers.get("content-type"), bytes: buf.length, magic: buf.slice(0, 4).toString("hex") };
  } catch (e) {
    return { error: String(e && e.message || e).slice(0, 120) };
  }
}

async function probeAudius(query) {
  const out = { steps: [] };
  try {
    const r = await fetch(`https://discoveryprovider.audius.co/v1/tracks/search?query=${encodeURIComponent(query)}&app_name=chukoMusic&limit=5`, { headers: { "User-Agent": UA_WEB }, signal: AbortSignal.timeout(10000) });
    const j = await r.json();
    const list = j.data || [];
    out.count = list.length;
    out.tracks = list.map(t => ({ id: t.id, title: t.title, user: t.user && t.user.name, duration: t.duration, genre: t.genre }));
    if (list[0]) {
      const id = list[0].id;
      const s = await fetch(`https://discoveryprovider.audius.co/v1/tracks/${id}/stream?app_name=chukoMusic`, { headers: { "User-Agent": UA_WEB, Range: "bytes=0-1023" }, signal: AbortSignal.timeout(15000), redirect: "follow" });
      const b = Buffer.from(await s.arrayBuffer());
      out.stream = { http: s.status, ctype: s.headers.get("content-type"), bytes: b.length, magic: b.slice(0, 4).toString("hex"), finalUrl: s.url.slice(0, 120) };
    }
  } catch (e) {
    out.error = String(e && e.message || e).slice(0, 150);
  }
  return out;
}

async function probeSoundCloud(query) {
  const out = {};
  try {
    const homeHtml = await (await fetch("https://soundcloud.com/", { headers: { "User-Agent": UA_WEB }, signal: AbortSignal.timeout(12000) })).text();
    const scripts = [...homeHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map(m => m[1]);
    let cid = "";
    for (const s of scripts) {
      const u = s.startsWith("http") ? s : ("https:" + s);
      try {
        const t = await (await fetch(u, { headers: { "User-Agent": UA_WEB }, signal: AbortSignal.timeout(12000) })).text();
        const m = t.match(/client_id\s*[:=]\s*["']([A-Za-z0-9]{32})["']/);
        if (m) { cid = m[1]; break; }
      } catch (_) {}
    }
    out.clientId = cid ? cid.slice(0, 6) + "..." : "";
    if (!cid) return out;
    const j = await (await fetch(`https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${cid}&limit=5&app_version=1700000000`, { headers: { "User-Agent": UA_WEB }, signal: AbortSignal.timeout(12000) })).json();
    const list = j.collection || [];
    out.count = list.length;
    out.tracks = list.map(t => ({ id: t.id, title: t.title, duration: t.duration, policy: t.policy, streamable: t.streamable }));
    if (list[0]) {
      const t = list[0];
      const trs = (t.media && t.media.transcodings) || [];
      out.transcodings = trs.map(x => x.preset + "/" + x.format.protocol);
      const pick = trs.find(x => x.format.protocol === "hls" && x.preset === "aac_160k") || trs[0];
      if (pick) {
        const u = pick.url + (pick.url.includes("?") ? "&" : "?") + "client_id=" + cid;
        const jj = await (await fetch(u, { headers: { "User-Agent": UA_WEB }, signal: AbortSignal.timeout(12000) })).json();
        out.mediaUrl = (jj.url || "").slice(0, 140);
        if (jj.url) {
          const pl = await (await fetch(jj.url, { headers: { "User-Agent": UA_WEB }, signal: AbortSignal.timeout(12000) })).text();
          out.playlistHead = pl.slice(0, 300);
        }
      }
    }
  } catch (e) {
    out.error = String(e && e.message || e).slice(0, 150);
  }
  return out;
}

async function runProbe(q) {
  const query = String(q || "STUTS 99 Steps").trim();
  const res = { query, at: new Date().toISOString() };
  res.egress = await (async () => {
    try {
      const r = await fetch("https://api.ipify.org?format=json", { signal: AbortSignal.timeout(8000) });
      return await r.json();
    } catch (e) { return { error: String(e.message).slice(0, 80) }; }
  })();

  res.videoId = await searchVideoId(query);
  const po = await makePoToken();
  res.poToken = { ok: po.ok, ms: po.ms, error: po.error, poTokenLen: po.poTokenLen, visitorDataLen: po.visitorDataLen };

  res.players = {};
  if (res.videoId) {
    for (const key of Object.keys(CLIENTS)) {
      res.players[key + "_plain"] = await callPlayer(res.videoId, key);
    }
    if (po.ok) {
      for (const key of ["WEB", "WEB_EMBEDDED", "MWEB", "ANDROID_VR", "IOS"]) {
        res.players[key + "_po"] = await callPlayer(res.videoId, key, { poToken: po.poToken, visitorData: po.visitorData });
      }
    }
    // poトークンで得た最初の音源URLが実際に引けるか
    const anyUrl = Object.values(res.players).map(p => p && p.firstAudioUrl).find(u => u);
    if (anyUrl) res.audioFetch = await tryFetchRange(anyUrl);
  }

  res.audius = await probeAudius(query);
  res.soundcloud = await probeSoundCloud(query);
  return res;
}

module.exports = { runProbe };
