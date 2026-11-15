// フル尺音源リゾルバ (ちゅこミュージック / yaju&king ミュージック共用)
// 30秒のiTunesプレビューは最終フォールバックに回し、ここでフル尺(1曲まるごと)を探す。
//
// 取得ルート（2026-11 実測で生きていたもの）
//   1. SoundCloud  : 検索API + transcoding (HLS/fMP4 はinit+セグメント連結 / progressive はそのまま)
//   2. Audius      : 検索API + /stream (フル尺MP3をそのまま中継)
//   （YouTube/Invidious/Piped/公開mp3変換APIはデータセンターIPでは全滅）
//
// 一致判定の方針（別曲・30秒クリップ・別バージョンを掴まないため）
//   - SoundCloud の policy=SNIP（試聴のみ）や 60秒未満は最初から除外
//   - 曲名の語が全部タイトルに無いものは除外
//   - 頼まれていない remix / sped up / live / cover / instrumental 等は除外
//   - 再生時間が分かっていれば大きく外れるものは除外
//   - 最後に「アーティスト名の裏付け」か「再生時間がほぼ一致(±4秒)」のどちらかを必須にする

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const os = require("os");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const CACHE_DIR = path.join(os.tmpdir(), "chuko-music");
const MAX_FILE_BYTES = 90 * 1024 * 1024;
const MAX_CACHE_BYTES = 220 * 1024 * 1024;
const CLIENT_TTL_MS = 6 * 3600 * 1000;

let scClient = { id: "", at: 0 };
// client_id 探索を同時に何本も走らせないための共有Promise。
// 複数の曲を続けて叩いても探索は1回で済む。
let scClientPromise = null;
const inflight = new Map();

function norm(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[\\(\\[（【「『].*?[\\)\\]）】」』]/g, " ")
    .replace(/\bfeat\.?\b|\bfeaturing\b|\bprod\.?\b|\bremix\b|\bver\.?\b|\bversion\b/g, " ")
    .replace(/[^0-9a-z\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]+/g, " ")
    .trim();
}

function tokens(value) {
  return norm(value).split(" ").filter(t => t.length > 0);
}

// 頼まれていない別バージョンを示す語（タイトル側にのみ現れたら除外）
const VARIANT_RE = /(remix|re-?mix|sped\s*up|speed\s*up|slowed|nightcore|cover|covered by|カバー|instrumental|インスト|\binst\b|off\s*vocal|オフボーカル|karaoke|カラオケ|原曲歌手|ガイド|歌ってみた|弾いてみた|8d\s*audio|reverb|mashup|マッシュアップ|live|ライブ|acoustic|アコースティック|piano|ピアノ|피아노|arrange|アレンジ|편곡|반주|伴奏|钢琴|纯音乐|\bmr\b|music\s*box|オルゴール|bootleg|\bver\b\.?)/gi;

// 再生時間が分からない時に「明らかに曲じゃない長さ」を弾く上限
const MAX_PLAUSIBLE_SEC = 900;

function variantMatches(text) {
  const out = [];
  const s = String(text || "").toLowerCase();
  let m;
  VARIANT_RE.lastIndex = 0;
  while ((m = VARIANT_RE.exec(s)) !== null) {
    out.push(m[0].toLowerCase().replace(/\s+/g, ""));
  }
  return out;
}

function hasUnrequestedVariant(trackTitle, wantTitle) {
  const wantText = String(wantTitle || "").toLowerCase();
  const words = variantMatches(trackTitle);
  if (!words.length) return false;
  return words.some(w => !wantText.replace(/\s+/g, "").includes(w));
}

function titleMatches(trackTitle, wantTitle) {
  const wantTokens = tokens(wantTitle);
  if (!wantTokens.length) return false;
  const hay = " " + tokens(trackTitle).join(" ") + " ";
  return wantTokens.every(t => hay.includes(" " + t + " "));
}

function durationTolerance(wantSec) {
  // 再アップロードでも数秒ずれることはあるので下限10秒、長い曲は4%まで許す
  return Math.max(10, Math.round(wantSec * 0.04));
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

async function discoverSoundcloudClientId() {
  const home = await fetch("https://soundcloud.com/", {
    headers: { "User-Agent": UA, "Accept": "text/html" },
    signal: AbortSignal.timeout(12000)
  });
  const html = await home.text();

  // 1) HTMLに直接埋まっていることがある（最速）
  const inline = html.match(/client_id\s*[:=]\s*["']([A-Za-z0-9]{32})["']/);
  if (inline) return inline[1];

  // 2) JSアセットは並列で取りに行き、見つかった最初のものを使う
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)]
    .map(m => m[1])
    .filter(u => u.includes("sndcdn.com/assets"))
    .slice(0, 10);

  const texts = await Promise.all(scripts.map(async (s) => {
    const u = s.startsWith("http") ? s : "https:" + s;
    try {
      const r = await fetch(u, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(8000) });
      return await r.text();
    } catch (_) {
      return "";
    }
  }));

  for (const t of texts) {
    const m = t.match(/client_id\s*[:=]\s*["']([A-Za-z0-9]{32})["']/);
    if (m) return m[1];
  }
  throw new Error("soundcloud client_id not found");
}

async function soundcloudClientId(force = false) {
  if (!force && scClient.id && Date.now() - scClient.at < CLIENT_TTL_MS) return scClient.id;
  if (scClientPromise) return scClientPromise;
  scClientPromise = discoverSoundcloudClientId()
    .then((id) => {
      scClient = { id, at: Date.now() };
      return id;
    })
    .finally(() => {
      scClientPromise = null;
    });
  return scClientPromise;
}

async function soundcloudSearch(query, limit = 15) {
  const cid = await soundcloudClientId();
  const j = await jsonFetch(`https://api-v2.soundcloud.com/search/tracks?q=${encodeURIComponent(query)}&client_id=${cid}&limit=${limit}&app_version=1700000000`);
  return j.collection || [];
}

async function soundcloudSearchMany(queries, limit = 15) {
  const lists = await Promise.all(queries.map(q => soundcloudSearch(q, limit).catch(() => [])));
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const t of list) {
      const id = String((t && t.id) || "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(t);
    }
  }
  return out;
}

// 一致してよい候補か（落とす理由を返す。null なら候補として残す）
function soundcloudRejectReason(track, want) {
  if (!track || !track.id) return "no id";
  if (track.streamable === false) return "not streamable";
  const policy = String(track.policy || "").toUpperCase();
  if (policy === "BLOCK") return "blocked";
  if (policy === "SNIP") return "snippet(30s)";      // SoundCloudの試聴のみ曲
  const durSec = Math.round((track.duration || 0) / 1000);
  if (!durSec || durSec < 60) return "too short";
  if (want.durationSec <= 0 && durSec > MAX_PLAUSIBLE_SEC) return "implausibly long";
  const title = String(track.title || "");
  if (!want.title) return "no want title";
  if (!titleMatches(title, want.title)) return "title mismatch";
  if (hasUnrequestedVariant(title, want.title)) return "other version";
  if (want.durationSec > 0) {
    const tol = durationTolerance(want.durationSec);
    if (Math.abs(durSec - want.durationSec) > tol) return "duration " + durSec + "s vs " + want.durationSec + "s";
  }
  const evidence = artistEvidence({
    title,
    extra: [
      (track.user && (track.user.username || track.user.full_name)) || "",
      track.label_name || "",
      track.genre || ""
    ].join(" "),
    wantArtist: want.artist
  });
  const nearDuration = want.durationSec > 0 && Math.abs(durSec - want.durationSec) <= durationTolerance(want.durationSec);
  // アーティスト名の裏付けが無くても、実尺がほぼ一致していれば同じ曲とみなす
  // （J-POPはアップローダー名が本名でないことが多く、以前の厳しすぎる条件で全曲30秒に落ちていた）
  // 別バージョン（remix/cover/live等）は上で除外済み。
  if (!evidence && !nearDuration) return "no artist/duration evidence";
  return null;
}

function distinctiveTitle(title) {
  const t = String(title || "").trim();
  if (!t) return false;
  if (/[^\x00-\x7F]/.test(t)) return true;          // 日本語・韓国語などは十分に特徴的
  return tokens(t).length >= 2 || t.replace(/\s+/g, "").length >= 10;
}

function artistEvidence({ title, extra, wantArtist }) {
  const wantArtistTokens = tokens(wantArtist);
  if (!wantArtistTokens.length) return true; // アーティスト不明ならタイトル一致だけで判断
  const hay = " " + tokens(title + " " + extra).join(" ") + " ";
  return wantArtistTokens.every(t => hay.includes(" " + t + " "));
}

function soundcloudScore(track, want) {
  let score = 0;
  const durSec = Math.round((track.duration || 0) / 1000);
  if (norm(track.title) === norm(want.title)) score += 3;
  const evidence = artistEvidence({
    title: String(track.title || ""),
    extra: [
      (track.user && (track.user.username || track.user.full_name)) || "",
      track.label_name || ""
    ].join(" "),
    wantArtist: want.artist
  });
  if (evidence && tokens(want.artist).length) score += 3;
  if (want.durationSec > 0) {
    const diff = Math.abs(durSec - want.durationSec);
    if (diff <= 4) score += 2;
    else if (diff <= 10) score += 1;
  }
  if (track.user && track.user.verified) score += 1;
  return score;
}

function pickBest(candidates, want, scoreFn, rejectFn) {
  let best = null;
  let rejected = 0;
  for (const t of candidates) {
    const why = rejectFn(t, want);
    if (why) { rejected++; continue; }
    const score = scoreFn(t, want);
    if (!best || score > best.score) best = { track: t, score };
  }
  return { best, rejected, total: candidates.length };
}

async function soundcloudPick(want) {
  const q1 = [want.artist, want.title].filter(Boolean).join(" ").trim();
  const q2 = [want.title, want.artist].filter(Boolean).join(" ").trim();
  const q3 = [want.artist, want.title].filter(Boolean).join(" - ");
  const q4 = want.title || "";

  const first = await soundcloudSearchMany([q1, q2, want.title].filter((q, i, a) => q && a.indexOf(q) === i));
  let pass = pickBest(first, want, soundcloudScore, soundcloudRejectReason);

  if (!pass.best) {
    const second = await soundcloudSearchMany([q3, q4].filter((q, i, a) => q && a.indexOf(q) === i));
    const more = pickBest(second, want, soundcloudScore, soundcloudRejectReason);
    if (more.best) pass = { best: more.best, rejected: pass.rejected + more.rejected, total: pass.total + more.total };
    else pass.total += more.total, pass.rejected += more.rejected;
  }

  // ここまで残った候補は「曲名一致 + アーティスト裏付け or 再生時間一致」を満たしている。
  // 点は候補同士の並べ替え用なので、下限は低めでよい。
  if (!pass.best || pass.best.score < 3) {
    return { track: null, total: pass.total, rejected: pass.rejected };
  }
  return { track: pass.best.track, total: pass.total, rejected: pass.rejected, score: pass.best.score };
}

async function soundcloudMedia(trackId) {
  const cid = await soundcloudClientId();
  const track = await jsonFetch(`https://api-v2.soundcloud.com/tracks/${trackId}?client_id=${cid}`);
  const trs = (track.media && track.media.transcodings) || [];
  if (!trs.length) throw new Error("no transcodings");

  const progressive = trs.find(t => t.format && t.format.protocol === "progressive");
  const hls = trs.find(t => t.format && t.format.protocol === "hls" && t.preset === "aac_160k")
    || trs.find(t => t.format && t.format.protocol === "hls");
  const chosen = hls || progressive || trs[0];
  const protocol = (chosen.format && chosen.format.protocol) || "hls";
  const u = chosen.url + (chosen.url.includes("?") ? "&" : "?") + "client_id=" + cid;
  const media = await jsonFetch(u);
  if (!media.url) throw new Error("no media url");
  return {
    protocol,
    mediaUrl: media.url,
    durationSec: Math.round((track.duration || 0) / 1000),
    title: track.title
  };
}

async function downloadDirect(url, destPath) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error("stream HTTP " + r.status);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_FILE_BYTES) throw new Error("too large");
  if (buf.length < 10000) throw new Error("too small");
  await fsp.mkdir(CACHE_DIR, { recursive: true });
  await fsp.writeFile(destPath + ".part", buf);
  await fsp.rename(destPath + ".part", destPath);
  return { size: buf.length };
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
  for (const ext of [".m4a", ".mp3"]) {
    const dest = path.join(CACHE_DIR, key + ext);
    try {
      const st = await fsp.stat(dest);
      if (st.size > 0) {
        fsp.utimes(dest, new Date(), new Date()).catch(() => {});
        return { path: dest, size: st.size, cached: true };
      }
    } catch (_) {}
  }
  if (inflight.has(key)) return inflight.get(key);
  const job = (async () => {
    const media = await soundcloudMedia(trackId);
    const dest = path.join(CACHE_DIR, key + (media.protocol === "progressive" ? ".mp3" : ".m4a"));
    const info = media.protocol === "progressive"
      ? await downloadDirect(media.mediaUrl, dest)
      : await downloadHls(media.mediaUrl, dest);
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

// ---------------- YouTube (Invidious経由) ----------------

// SoundCloud に原曲が無いJ-POPはここで拾う。
// local=true でインスタンス自身の /videoplayback を返させ、自前の中継で Range 配信する。
// （googlevideo の直リンクは PO Token 必須で 403 になるため使わない）
const YT_HOSTS = [
  "echostreamz.com",
  "inv.nadeko.net",
  "yewtu.be",
  "invidious.nerdvpn.de"
];
const ytSearchCache = new Map();
const ytAudioCache = new Map();

function ytAbs(host, u) {
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  return "https://" + host + (u.startsWith("/") ? u : "/" + u);
}

async function ytSearch(query) {
  const key = norm(query);
  const hit = ytSearchCache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.list;
  for (const host of YT_HOSTS) {
    try {
      const j = await jsonFetch(`https://${host}/api/v1/search?q=${encodeURIComponent(query)}&type=video`, {}, 9000);
      const list = (Array.isArray(j) ? j : []).filter(v => v && v.videoId).map(v => ({
        videoId: v.videoId,
        title: v.title || "",
        author: v.author || "",
        lengthSeconds: Number(v.lengthSeconds || 0),
        host
      }));
      if (list.length) {
        ytSearchCache.set(key, { at: Date.now(), list });
        if (ytSearchCache.size > 200) ytSearchCache.delete(ytSearchCache.keys().next().value);
        return list;
      }
    } catch (_) {}
  }
  return [];
}

function ytRejectReason(v, want) {
  if (!v || !v.videoId) return "no id";
  const len = v.lengthSeconds || 0;
  if (!len || len < 60) return "too short";
  if (!want.title) return "no want title";
  if (!titleMatches(v.title, want.title)) return "title mismatch";
  const full = v.title + " " + v.author;
  if (hasUnrequestedVariant(full, want.title)) return "other version";
  // 本人のチャンネル（アーティスト名がチャンネル名に入っている）なら、
  // 公式MVはアルバム版より尺が長いことがあるので尺の縛りを緩める
  const channelMatch = tokens(want.artist).length > 0 && artistEvidence({ title: "", extra: v.author, wantArtist: want.artist });
  if (want.durationSec > 0 && !channelMatch) {
    const tol = Math.max(8, Math.round(want.durationSec * 0.03));
    if (Math.abs(len - want.durationSec) > tol) return "duration " + len;
  } else if (want.durationSec <= 0 && len > MAX_PLAUSIBLE_SEC) return "implausibly long";
  const evidence = artistEvidence({ title: v.title, extra: v.author, wantArtist: want.artist });
  const nearDuration = want.durationSec > 0 && Math.abs(len - want.durationSec) <= 3;
  if (!evidence && !nearDuration) return "no artist/duration evidence";
  return null;
}

function ytScore(v, want) {
  let score = 0;
  const full = v.title + " " + v.author;
  if (norm(v.title) === norm(want.title)) score += 3;
  if (artistEvidence({ title: v.title, extra: v.author, wantArtist: want.artist }) && tokens(want.artist).length) score += 3;
  if (want.durationSec > 0) {
    const diff = Math.abs((v.lengthSeconds || 0) - want.durationSec);
    if (diff <= 3) score += 3;
    else if (diff <= 8) score += 2;
  }
  if (/official\s*audio|topic|official\s*(music\s*)?video|公式/i.test(v.title)) score += 2;
  if (/lyrics|歌詞/i.test(v.title)) score += 1;
  return score;
}

async function ytPick(want) {
  const queries = [
    [want.artist, want.title].filter(Boolean).join(" "),
    [want.title, want.artist].filter(Boolean).join(" ")
  ].filter((q, i, a) => q && a.indexOf(q) === i);
  let all = [];
  const seen = new Set();
  for (const q of queries) {
    const list = await ytSearch(q);
    for (const v of list) {
      if (seen.has(v.videoId)) continue;
      seen.add(v.videoId);
      all.push(v);
    }
    if (all.length >= 15) break;
  }
  const pass = pickBest(all, want, ytScore, ytRejectReason);
  return { best: pass.best ? pass.best.track : null, score: pass.best ? pass.best.score : 0, total: pass.total, rejected: pass.rejected };
}

async function ytAudioUrl(videoId) {
  const cached = ytAudioCache.get(videoId);
  if (cached && cached.exp > Date.now()) return cached;
  for (const host of YT_HOSTS) {
    try {
      const j = await jsonFetch(`https://${host}/api/v1/videos/${encodeURIComponent(videoId)}?local=true`, {}, 12000);
      if (!j || j.error) continue;
      const af = Array.isArray(j.adaptiveFormats) ? j.adaptiveFormats : [];
      const audio = af.find(f => String(f.itag) === "140")
        || af.find(f => /^audio\/mp4/i.test(String(f.type || "")))
        || af.find(f => /^audio\//i.test(String(f.type || "")));
      if (!audio || !audio.url) continue;
      const out = { url: ytAbs(host, audio.url), host, title: j.title || "", lengthSeconds: Number(j.lengthSeconds || 0), exp: Date.now() + 30 * 60 * 1000 };
      ytAudioCache.set(videoId, out);
      if (ytAudioCache.size > 60) ytAudioCache.delete(ytAudioCache.keys().next().value);
      return out;
    } catch (_) {}
  }
  return null;
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

function audiusRejectReason(track, want) {
  if (!track || !track.id) return "no id";
  if (track.is_delete) return "deleted";
  if (track.is_streamable === false) return "not streamable";
  const durSec = track.duration || 0;
  if (!durSec || durSec < 60) return "too short";
  if (want.durationSec <= 0 && durSec > MAX_PLAUSIBLE_SEC) return "implausibly long";
  if (!want.title) return "no want title";
  if (!titleMatches(track.title, want.title)) return "title mismatch";
  if (hasUnrequestedVariant(String(track.title || ""), want.title)) return "other version";
  if (want.durationSec > 0 && Math.abs(durSec - want.durationSec) > durationTolerance(want.durationSec)) return "duration";
  const evidence = artistEvidence({
    title: String(track.title || ""),
    extra: (track.user && (track.user.name || track.user.handle)) || "",
    wantArtist: want.artist
  });
  const nearDuration = want.durationSec > 0 && Math.abs(durSec - want.durationSec) <= durationTolerance(want.durationSec);
  // アーティスト名の裏付けが無くても、実尺がほぼ一致していれば同じ曲とみなす
  // （J-POPはアップローダー名が本名でないことが多く、以前の厳しすぎる条件で全曲30秒に落ちていた）
  // 別バージョン（remix/cover/live等）は上で除外済み。
  if (!evidence && !nearDuration) return "no artist/duration evidence";
  return null;
}


function audiusScore(track, want) {
  let score = 0;
  const durSec = track.duration || 0;
  if (norm(track.title) === norm(want.title)) score += 3;
  const evidence = artistEvidence({
    title: String(track.title || ""),
    extra: (track.user && (track.user.name || track.user.handle)) || "",
    wantArtist: want.artist
  });
  if (evidence && tokens(want.artist).length) score += 3;
  if (want.durationSec > 0) {
    const diff = Math.abs(durSec - want.durationSec);
    if (diff <= 4) score += 2;
    else if (diff <= 10) score += 1;
  }
  return score;
}

async function audiusPick(want) {
  const queries = [
    [want.artist, want.title].filter(Boolean).join(" "),
    [want.title, want.artist].filter(Boolean).join(" ")
  ].filter((q, i, a) => q && a.indexOf(q) === i);
  let candidates = [];
  try {
    const lists = await Promise.all(queries.map(q => audiusSearch(q).catch(() => [])));
    const seen = new Set();
    for (const list of lists) {
      for (const t of list) {
        const id = String((t && t.id) || "");
        if (!id || seen.has(id)) continue;
        seen.add(id);
        candidates.push(t);
      }
    }
  } catch (_) {
    return { track: null, total: 0, rejected: 0 };
  }
  const pass = pickBest(candidates, want, audiusScore, audiusRejectReason);
  if (!pass.best || pass.best.score < 3) return { track: null, total: pass.total, rejected: pass.rejected };
  return { track: pass.best.track, total: pass.total, rejected: pass.rejected, score: pass.best.score };
}

function audiusStreamUrl(trackId) {
  return `https://discoveryprovider.audius.co/v1/tracks/${encodeURIComponent(trackId)}/stream?app_name=chukoMusic`;
}

// ---------------- 解決 ----------------

/**
 * フル尺音源を探す。
 * @param {{artist?:string,title?:string,album?:string,durationSec?:number}} want
 * @returns {Promise<{ok:boolean, source?:string, url?:string, durationSec?:number, title?:string, matched?:string, why?:string}>}
 */
async function resolveFull(want) {
  const artist = String(want.artist || "").trim();
  const title = String(want.title || "").trim();
  const durationSec = Number(want.durationSec || 0) || 0;
  const reasons = [];
  if (!title && !artist) return { ok: false, why: "曲名もアーティストも無い" };

  const w = { artist, title, durationSec };

  try {
    const sc = await soundcloudPick(w);
    if (sc.track) {
      return {
        ok: true,
        source: "soundcloud",
        url: `/api/music/fullfile?src=soundcloud&id=${encodeURIComponent(sc.track.id)}`,
        durationSec: Math.round((sc.track.duration || 0) / 1000),
        title: sc.track.title,
        matched: ((sc.track.user && sc.track.user.username) || ""),
        score: sc.score
      };
    }
    reasons.push(`SoundCloudで一致なし(候補${sc.total}件/除外${sc.rejected}件)`);
  } catch (e) {
    reasons.push("SoundCloud: " + String(e && e.message || e).slice(0, 80));
  }

  // SoundCloud に原曲が無い/30秒しか無い曲は YouTube（インスタンス中継）でフル尺を再生する。
  // 事前に音声ストリームが取れることまで確かめてから返す（ハリボテを出さない）。
  try {
    const ytp = await ytPick(w);
    if (ytp.best) {
      const audio = await ytAudioUrl(ytp.best.videoId);
      if (audio && audio.url) {
        return {
          ok: true,
          source: "youtube",
          url: `/api/music/fullfile?src=youtube&id=${encodeURIComponent(ytp.best.videoId)}`,
          durationSec: ytp.best.lengthSeconds || audio.lengthSeconds || 0,
          title: ytp.best.title,
          matched: ytp.best.author || "",
          score: ytp.score
        };
      }
      reasons.push("YouTube: 音声ストリームを取得できず(" + ytp.best.videoId + ")");
    } else {
      reasons.push(`YouTubeで一致なし(候補${ytp.total}件/除外${ytp.rejected}件)`);
    }
  } catch (e) {
    reasons.push("YouTube: " + String(e && e.message || e).slice(0, 80));
  }

  try {
    const au = await audiusPick(w);
    if (au.track) {
      return {
        ok: true,
        source: "audius",
        url: `/api/music/fullfile?src=audius&id=${encodeURIComponent(au.track.id)}`,
        durationSec: au.track.duration || 0,
        title: au.track.title,
        matched: (au.track.user && au.track.user.name) || "",
        score: au.score
      };
    }
    reasons.push(`Audiusで一致なし(候補${au.total}件/除外${au.rejected}件)`);
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
    const info = await downloadDirect(audiusStreamUrl(trackId), dest);
    await trimCache();
    return { path: dest, size: info.size, cached: false };
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
  ytAudioUrl,
  soundcloudFile,
  audiusFile,
  audiusStreamUrl,
  soundcloudSearch,
  soundcloudPick,
  soundcloudClientId,
  norm
};
