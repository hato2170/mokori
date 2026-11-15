// フル尺音源リゾルバ (ちゅこミュージック / yaju&king ミュージック共用)
// 30秒のiTunesプレビューは最終フォールバックに回し、ここでフル尺(1曲まるごと)を探す。
//
// 取得ルート（2026-11 実測で生きていたもの）
//   1. SoundCloud  : 検索API + HLS(fMP4) をinit+セグメント連結して1本のファイルにする
//   2. Audius      : 検索API + /stream (フル尺MP3をそのまま中継)
//   （YouTube/Invidious/Piped/公開mp3変換APIはデータセンターIPでは全滅。理由は /api/music/full の why に載る）

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CACHE_DIR = path.join(os.tmpdir(), "chuko-music");
const MAX_FILE_BYTES = 90 * 1024 * 1024;
const MAX_CACHE_BYTES = 220 * 1024 * 1024;

let scClient = { id: "", at: 0 };
const inflight = new Map();

function norm(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\(\[（【「『].*?[\)\]）】」』]/g, " ")
    .replace(/\bfeat\.?\b|\bfeaturing\b|\bprod\.?\b|\bremix\b|\bver\.?\b|\bversion\b/g, " ")
    .replace(/[^0-9a-z\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, " ")
    .trim();
}

function tokens(value) {
  return norm(value).split(" ").filter(t => t.length > 0);
}

function containsAll(haystack, needles) {
  const h = tokens(haystack).join(" ");
  return needles.length > 0 && needles.every(n => h.includes(n));
}

async function jsonFetch(url, opts = {}, timeoutMs = 12000) {
  const r = await fetch(url, {
    headers: { "User-Agent": UA, "Accept": "application/json, text/plain, */*", "Accept-Language": "ja,en;q=0.8", ...(opts.headers || {}) },
    ...opts,
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!r.ok) throw new Error("HTTP " + r.status + " " + url.slice(0, 80));
  return r.json();
}

// ---------------- SoundCloud ----------------

async function soundcloudClientId(force = false) {
  const now = Date.now();
  if (!force && scClient.id && now - scClient.at < 6 * 3600 * 1000) return scClient.id;
  const home = await fetch("https://soundcloud.com/", {
    headers: { "User-Agent": UA, "Accept": "text/html" },
    signal: AbortSignal.timeout(12000)
  });
  const html = await home.text();
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map(m => m[1])
    .filter(u => u.includes("sndcdn.com/assets"));
  for (const s of scripts) {
    const u = s.startsWith("http") ? s : "https:" + s;
    try {
      const t = await (await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(9000) })).text();
      const m = t.match(/client_id\s*[:=]\s*["']([A-Za-z0-9]{32})["']/);
      if (m) {
        scClient = { id: m[1], at: now };
        return m[1];
      }
    } catch (_) {}
  }
  throw new Error("soundcloud client_id not found");
}

async function soundcloudSearch(query, limit = 12) {
  const cid = await soundcloudClientId();
  const j = await jsonFetch(`https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${cid}&limit=${limit}&app_version=1700000000`);
  return j.collection || [];
}

function soundcloudScore(track, want) {
  if (!track || track.streamable === false) return -1;
  if (track.policy && String(track.policy).toUpperCase() === "BLOCK") return -1;
  let score = 0;
  const titleHay = norm(track.title);
  const userHay = norm((track.user && (track.user.username || track.user.full_name)) || "");
  const wantTitle = tokens(want.title || "");
  const wantArtist = tokens(want.artist || "");
  const durSec = Math.round((track.duration || 0) / 1000);

  if (want.durationSec > 0 && durSec > 0) {
    const diff = Math.abs(durSec - want.durationSec);
    if (diff <= 6) score += 4;
    else if (diff <= 15) score += 2;
    else if (diff > 45) score -= 4;
  }
  if (wantTitle.length && containsAll(track.title, wantTitle)) score += 3;
  else if (wantTitle.length && wantTitle.some(t => titleHay.includes(t) && t.length > 2)) score += 1;
  if (wantArtist.length && (containsAll(track.title, wantArtist) || userHay.includes(norm(want.artist)))) score += 2;
  if (wantArtist.length && !(containsAll(track.title, wantArtist) || userHay.includes(norm(want.artist)))) score -= 1;
  if (/cover|カバー|inst|instrumental|karaoke|オフボーカル|remix|mashup|8d/i.test(String(track.title || ""))) {
    if (!/remix|inst/i.test(String(want.title || ""))) score -= 2;
  }
  if ((track.duration || 0) < 45000) score -= 3;
  return score;
}

async function soundcloudPick(want) {
  const queries = [
    [want.artist, want.title].filter(Boolean).join(" "),
    [want.title, want.artist].filter(Boolean).join(" "),
    want.title
  ].filter(Boolean);
  let best = null;
  for (const q of queries) {
    let list = [];
    try { list = await soundcloudSearch(q); } catch (_) { continue; }
    for (const t of list) {
      const score = soundcloudScore(t, want);
      if (!best || score > best.score) best = { track: t, score };
    }
    if (best && best.score >= 5) break;
  }
  if (!best || best.score < 4) return null;
  return best.track;
}

async function soundcloudMedia(trackId) {
  const cid = await soundcloudClientId();
  const track = await jsonFetch(`https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${cid}`);
  const trs = (track.media && track.media.transcodings) || [];
  if (!trs.length) throw new Error("no transcodings");
  const hls = trs.find(t => t.format && t.format.protocol === "hls" && t.preset === "aac_160k")
    || trs.find(t => t.format && t.format.protocol === "hls")
    || trs[0];
  const u = hls.url + (hls.url.includes("?") ? "&" : "?") + "client_id=" + cid;
  const media = await jsonFetch(u);
  if (!media.url) throw new Error("no media url");
  return { mediaUrl: media.url, durationSec: Math.round((track.duration || 0) / 1000), title: track.title };
}

async function downloadHls(mediaUrl, destPath) {
  const plRes = await fetch(mediaUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
  if (!plRes.ok) throw new Error("playlist HTTP " + plRes.status);
  const playlist = await plRes.text();
  const base = mediaUrl.slice(0, mediaUrl.lastIndexOf("/") + 1);
  const resolve = (u) => (u.startsWith("http") ? u : base + u);
  const lines = playlist.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let initUrl = "";
  const segments = [];
  for (const line of lines) {
    if (line.startsWith("#EXT-X-MAP")) {
      const m = line.match(/URI="([^"]+)"/);
      if (m) initUrl = resolve(m[1]);
    } else if (line.startsWith("#EXT-X-STREAM-INF")) {
      // マスタープレイリスト（珍しい）: 最初のバリアントを使う
      continue;
    } else if (!line.startsWith("#")) {
      segments.push(resolve(line));
    }
  }
  if (!segments.length) throw new Error("playlist has no segments");

  await fsp.mkdir(CACHE_DIR, { recursive: true });
  const tmp = destPath + ".part";
  const out = fs.createWriteStream(tmp);
  let total = 0;
  const writeBuf = (buf) => new Promise((res, rej) => {
    if (!out.write(buf)) out.once("drain", res);
    else res();
  });
  const fetched = async (u) => {
    const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error("segment HTTP " + r.status);
    return Buffer.from(await r.arrayBuffer());
  };

  try {
    if (initUrl) {
      const buf = await fetched(initUrl);
      total += buf.length;
      await writeBuf(buf);
    }
    const CONC = 4;
    for (let i = 0; i < segments.length; i += CONC) {
      const chunk = segments.slice(i, i + CONC);
      const bufs = await Promise.all(chunk.map(fetched));
      for (const buf of bufs) {
        total += buf.length;
        if (total > MAX_FILE_BYTES) throw new Error("too large");
        await writeBuf(buf);
      }
    }
  } finally {
    await new Promise(r => out.end(r));
  }
  await fsp.rename(tmp, destPath);
  return { size: total, segments: segments.length };
}

async function soundcloudFile(trackId) {
  const key = "sc-" + trackId;
  const dest = path.join(CACHE_DIR, key + ".m4a");
  try {
    const st = await fsp.stat(dest);
    if (st.size > 0) {
      fsp.utimes(dest, new Date(), new Date()).catch(() => {});
      return { path: dest, size: st.size, cached: true };
    }
  } catch (_) {}
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const media = await soundcloudMedia(trackId);
    const info = await downloadHls(media.mediaUrl, dest);
    await trimCache();
    return { path: dest, size: info.size, durationSec: media.durationSec, cached: false };
  })();
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

async function trimCache() {
  try {
    const names = await fsp.readdir(CACHE_DIR);
    const files = [];
    for (const n of names) {
      if (!n.endsWith(".m4a") && !n.endsWith(".mp3")) continue;
      const p = path.join(CACHE_DIR, n);
      const st = await fsp.stat(p);
      files.push({ p, size: st.size, at: st.atimeMs });
    }
    files.sort((a, b) => a.at - b.at);
    let total = files.reduce((s, f) => s + f.size, 0);
    for (const f of files) {
      if (total <= MAX_CACHE_BYTES) break;
      await fsp.unlink(f.p).catch(() => {});
      total -= f.size;
    }
  } catch (_) {}
}

// ---------------- Audius ----------------

const AUDIUS_HOSTS = ["https://discoveryprovider.audius.co", "https://discoveryprovider2.audius.co", "https://discoveryprovider3.audius.co"];

async function audiusSearch(query, limit = 12) {
  let lastErr = null;
  for (const host of AUDIUS_HOSTS) {
    try {
      const j = await jsonFetch(`${host}/v1/tracks/search?query=${encodeURIComponent(query)}&app_name=chukoMusic&limit=${limit}`, {}, 10000);
      return j.data || [];
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error("audius unavailable");
}

function audiusScore(track, want) {
  let score = 0;
  const titleHay = norm(track.title);
  const userHay = norm((track.user && (track.user.name || track.user.handle)) || "");
  const wantTitle = tokens(want.title || "");
  const wantArtist = tokens(want.artist || "");
  const durSec = track.duration || 0;
  if (want.durationSec > 0 && durSec > 0) {
    const diff = Math.abs(durSec - want.durationSec);
    if (diff <= 6) score += 4;
    else if (diff <= 15) score += 2;
    else if (diff > 45) score -= 4;
  }
  if (wantTitle.length && containsAll(track.title, wantTitle)) score += 3;
  if (wantArtist.length && (containsAll(track.title, wantArtist) || userHay.includes(norm(want.artist)))) score += 2;
  else if (wantArtist.length) score -= 1;
  return score;
}

async function audiusPick(want) {
  const q = [want.artist, want.title].filter(Boolean).join(" ");
  let best = null;
  try {
    for (const t of await audiusSearch(q)) {
      const score = audiusScore(t, want);
      if (!best || score > best.score) best = { track: t, score };
    }
  } catch (_) { return null; }
  if (!best || best.score < 5) return null;
  return best.track;
}

function audiusStreamUrl(trackId) {
  return `https://discoveryprovider.audius.co/v1/tracks/${encodeURIComponent(trackId)}/stream?app_name=chukoMusic`;
}

// ---------------- 解決 ----------------

/**
 * フル尺音源を探す。
 * @param {{artist?:string,title?:string,album?:string,durationSec?:number}} want
 * @returns {Promise<{ok:boolean, source?:string, url?:string, durationSec?:number, title?:string, why?:string}>}
 */
async function resolveFull(want) {
  const artist = String(want.artist || "").trim();
  const title = String(want.title || "").trim();
  const durationSec = Number(want.durationSec || 0) || 0;
  const reasons = [];
  if (!title && !artist) return { ok: false, why: "曲名もアーティストも無い" };

  const w = { artist, title, durationSec };

  try {
    const track = await soundcloudPick(w);
    if (track) {
      return {
        ok: true,
        source: "soundcloud",
        url: `/api/music/fullfile?src=soundcloud&id=${encodeURIComponent(track.id)}`,
        durationSec: Math.round((track.duration || 0) / 1000),
        title: track.title,
        matched: ((track.user && track.user.username) || "")
      };
    }
    reasons.push("SoundCloudで一致する曲が見つからない");
  } catch (e) {
    reasons.push("SoundCloud: " + String(e && e.message || e).slice(0, 80));
  }

  try {
    const track = await audiusPick(w);
    if (track) {
      return {
        ok: true,
        source: "audius",
        url: `/api/music/fullfile?src=audius&id=${encodeURIComponent(track.id)}`,
        durationSec: track.duration || 0,
        title: track.title,
        matched: (track.user && track.user.name) || ""
      };
    }
    reasons.push("Audiusで一致する曲が見つからない");
  } catch (e) {
    reasons.push("Audius: " + String(e && e.message || e).slice(0, 80));
  }

  return { ok: false, why: reasons.join(" / ") };
}

async function audiusFile(trackId) {
  const key = "au-" + trackId;
  const dest = path.join(CACHE_DIR, key + ".mp3");
  try {
    const st = await fsp.stat(dest);
    if (st.size > 0) return { path: dest, size: st.size, cached: true };
  } catch (_) {}
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    await fsp.mkdir(CACHE_DIR, { recursive: true });
    const r = await fetch(audiusStreamUrl(trackId), {
      headers: { "User-Agent": UA, "Accept": "*/*" },
      signal: AbortSignal.timeout(30000)
    });
    if (!r.ok) throw new Error("audius stream HTTP " + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 10000) throw new Error("audius stream too small");
    await fsp.writeFile(dest + ".part", buf);
    await fsp.rename(dest + ".part", dest);
    await trimCache();
    return { path: dest, size: buf.length, cached: false };
  })();
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}

module.exports = {
  resolveFull,
  soundcloudFile,
  audiusFile,
  audiusStreamUrl,
  soundcloudSearch,
  soundcloudPick,
  norm
};
