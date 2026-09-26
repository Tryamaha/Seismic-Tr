"use strict";
const axios = require("axios");\n
/* ===== Full-track fallback engine: SoundCloud -> Audiomack -> YouTube ===== */
let __scClient = null;
let __scClientTs = 0;

function __norm(s) {
  return String(s || "").toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9çğıöşü]+/gi, " ")
    .trim();
}

function __scoreCandidate(c, title, artist) {
  const ct = __norm(c.title), ca = __norm(c.artist);
  const t = __norm(title), a = __norm(artist);
  let s = 0;
  if (t && ct === t) s += 6;
  else if (t && (ct.includes(t) || t.includes(ct))) s += 4;
  if (a && ca === a) s += 4;
  else if (a && (ca.includes(a) || a.includes(ca))) s += 2;
  if (/karaoke|instrumental|cover|remix|sped up|slowed/.test(ct) && !/karaoke|instrumental|cover|remix|sped up|slowed/.test(t)) s -= 3;
  return s;
}

async function __getScClientId() {
  if (__scClient && Date.now() - __scClientTs < 6 * 60 * 60 * 1000) return __scClient;
  const H = { "User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/133 Safari/537.36" };
  const home = await axios.get("https://soundcloud.com", { headers:H, timeout:12000 });
  const html = String(home.data || "");
  const urls = [];
  let m;
  const re = /<script[^>]+src="(https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js)"/g;
  while ((m = re.exec(html)) !== null) urls.push(m[1]);
  for (const u of urls.reverse()) {
    try {
      const js = String((await axios.get(u, { headers:H, timeout:8000, responseType:"text" })).data || "");
      const mm = js.match(/client_id\s*:\s*"([a-zA-Z0-9]{20,40})"/) ||
                 js.match(/,client_id="([a-zA-Z0-9]{20,40})"/) ||
                 js.match(/"client_id","([a-zA-Z0-9]{20,40})"/);
      if (mm) {
        __scClient = mm[1];
        __scClientTs = Date.now();
        return __scClient;
      }
    } catch (_) {}
  }
  throw new Error("SoundCloud client_id unavailable");
}

async function __soundCloudFallback(title, artist) {
  const cid = await __getScClientId();
  const q = [artist, title].filter(Boolean).join(" ");
  const r = await axios.get("https://api-v2.soundcloud.com/search/tracks", {
    params:{ q, client_id:cid, limit:12, linked_partitioning:1 },
    headers:{ "User-Agent":"Mozilla/5.0", "Accept":"application/json", "Origin":"https://soundcloud.com" },
    timeout:12000
  });
  const rows = ((r.data || {}).collection || []).filter(x => x && (x.streamable || x.policy !== "BLOCK"));
  if (!rows.length) throw new Error("SoundCloud no result");
  const ranked = rows.map(x => ({
    raw:x,
    title:x.title || "",
    artist:(x.user && x.user.username) || "",
    score:__scoreCandidate({title:x.title,artist:x.user && x.user.username}, title, artist)
  })).sort((a,b) => b.score - a.score);
  const pick = ranked[0];
  if (!pick || pick.score < 2) throw new Error("SoundCloud weak match");

  const info = await axios.get("https://api-v2.soundcloud.com/tracks/" + pick.raw.id, {
    params:{ client_id:cid },
    headers:{ "User-Agent":"Mozilla/5.0", "Accept":"application/json", "Origin":"https://soundcloud.com" },
    timeout:12000
  });
  const trs = (((info.data || {}).media || {}).transcodings || []).filter(t => t && t.url && t.format && (t.format.protocol === "progressive" || t.format.protocol === "hls"));
  if (!trs.length) throw new Error("SoundCloud no stream");
  const chosen = trs.find(t => t.format.protocol === "progressive") ||
                 trs.find(t => t.format.protocol === "hls" && String(t.format.mime_type || "").includes("mpeg")) ||
                 trs[0];
  const s = await axios.get(chosen.url, {
    params:{ client_id:cid },
    headers:{ "User-Agent":"Mozilla/5.0", "Accept":"application/json", "Origin":"https://soundcloud.com" },
    timeout:10000
  });
  const url = (s.data || {}).url;
  if (!url) throw new Error("SoundCloud final URL missing");
  return { url };
}

/* Audiomack OAuth 1.0 */
function __oauthEncode(v) {
  return encodeURIComponent(String(v == null ? "" : v))
    .replace(/[!'()*]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}
function __nonce(n) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i=0;i<(n||24);i++) out += chars.charAt(Math.floor(Math.random()*chars.length));
  return out;
}
function __oauthSignature(method, absoluteUrl, params) {
  const keys = Object.keys(params).sort();
  const normalized = keys.map(k => __oauthEncode(k) + "=" + __oauthEncode(params[k])).join("&");
  const base = __oauthEncode(method.toUpperCase()) + "&" + __oauthEncode(absoluteUrl) + "&" + __oauthEncode(normalized);
  return CryptoJs.HmacSHA1(base, "f3ac5b086f3eab260520d8e3049561e6&").toString(CryptoJs.enc.Base64);
}
async function __audiomackFallback(title, artist) {
  const q = [artist, title].filter(Boolean).join(" ");
  const url = "https://api.audiomack.com/v1/search";
  const p = {
    limit:12,
    oauth_consumer_key:"audiomack-js",
    oauth_nonce:__nonce(32),
    oauth_signature_method:"HMAC-SHA1",
    oauth_timestamp:Math.round(Date.now()/1000),
    oauth_version:"1.0",
    page:1,
    q,
    show:"songs",
    sort:"popular"
  };
  p.oauth_signature = __oauthSignature("GET", url, p);
  const r = await axios.get(url, { params:p, headers:{ "User-Agent":"Mozilla/5.0" }, timeout:12000 });
  const rows = ((r.data || {}).results || []);
  if (!rows.length) throw new Error("Audiomack no result");
  const ranked = rows.map(x => ({
    raw:x, score:__scoreCandidate({title:x.title,artist:x.artist}, title, artist)
  })).sort((a,b)=>b.score-a.score);
  const pick = ranked[0];
  if (!pick || pick.score < 2) throw new Error("Audiomack weak match");

  const playUrl = "https://api.audiomack.com/v1/music/play/" + pick.raw.id;
  const pp = {
    environment:"desktop-web",
    hq:true,
    oauth_consumer_key:"audiomack-js",
    oauth_nonce:__nonce(32),
    oauth_signature_method:"HMAC-SHA1",
    oauth_timestamp:Math.round(Date.now()/1000),
    oauth_version:"1.0",
    section:"/search"
  };
  pp.oauth_signature = __oauthSignature("GET", playUrl, pp);
  const pr = await axios.get(playUrl, {
    params:pp,
    headers:{ "User-Agent":"Mozilla/5.0", "Origin":"https://audiomack.com" },
    timeout:12000
  });
  const finalUrl = (pr.data || {}).signedUrl;
  if (!finalUrl) throw new Error("Audiomack final URL missing");
  return { url:finalUrl };
}

async function __youtubeFallback(title, artist) {
  const q = [artist, title].filter(Boolean).join(" ");
  const searchPayload = {
    context:{ client:{ hl:"tr", gl:"TR", clientName:"WEB", clientVersion:"2.20231121.08.00", platform:"DESKTOP" }, request:{ useSsl:true } },
    query:q
  };
  const sr = await axios({
    method:"post",
    url:"https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
    headers:{ "Content-Type":"text/plain" },
    data:JSON.stringify(searchPayload),
    timeout:12000
  });
  const sections = ((((((sr.data||{}).contents||{}).twoColumnSearchResultsRenderer||{}).primaryContents||{}).sectionListRenderer||{}).contents)||[];
  const sec = sections.find(x => x.itemSectionRenderer);
  const rows = (sec && sec.itemSectionRenderer && sec.itemSectionRenderer.contents) || [];
  const vids = rows.filter(x => x.videoRenderer).map(x => x.videoRenderer);
  if (!vids.length) throw new Error("YouTube no result");
  const mapped = vids.map(v => ({
    raw:v,
    title:((((v.title||{}).runs)||[])[0]||{}).text || "",
    artist:((((v.ownerText||{}).runs)||[])[0]||{}).text || ""
  })).map(x => ({...x, score:__scoreCandidate(x,title,artist)})).sort((a,b)=>b.score-a.score);
  const pick = mapped[0];
  if (!pick || !pick.raw.videoId) throw new Error("YouTube weak match");

  const playerPayload = {
    context:{ client:{
      hl:"en", gl:"GB",
      userAgent:"com.google.android.apps.youtube.music/6.14.50 (Linux; U; Android 13; GB) gzip",
      clientName:"ANDROID_MUSIC", clientVersion:"6.14.50", osName:"Android", osVersion:"13", platform:"MOBILE"
    }, request:{ internalExperimentFlags:[], consistencyTokenJars:[] } },
    contentCheckOk:true, racyCheckOk:true, video_id:pick.raw.videoId
  };
  const pr = await axios({
    method:"post",
    url:"https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
    headers:{ "Content-Type":"application/json" },
    data:JSON.stringify(playerPayload),
    timeout:12000
  });
  const st = (pr.data || {}).streamingData || {};
  const formats = [...(st.formats || []), ...(st.adaptiveFormats || [])].filter(x => x && x.url);
  const audio = formats.find(x => String(x.mimeType || "").startsWith("audio/")) || formats[0];
  if (!audio || !audio.url) throw new Error("YouTube stream missing");
  return { url:audio.url };
}

async function __fullTrackFallback(title, artist) {
  try { return await __soundCloudFallback(title, artist); } catch (_) {}
  try { return await __audiomackFallback(title, artist); } catch (_) {}
  try { return await __youtubeFallback(title, artist); } catch (_) {}
  return null;
}


function getText(obj, path) {
  try {
    let v = obj;
    for (const p of path) v = v && v[p];
    return v;
  } catch (_) { return undefined; }
}

function formatMusicItem(item) {
  const title = getText(item, ["title","runs",0,"text"]) || "";
  const artist = getText(item, ["ownerText","runs",0,"text"]) || "";
  const thumbs = getText(item, ["thumbnail","thumbnails"]) || [];
  return {
    id: item.videoId,
    title,
    artist,
    artwork: thumbs.length ? thumbs[thumbs.length - 1].url : null,
    _rawData: item
  };
}

let lastQuery = null;
let musicContinToken = null;

async function searchMusic(query, page) {
  if (query !== lastQuery || page === 1) musicContinToken = null;
  lastQuery = query;

  const payload = {
    context: {
      client: {
        hl: "tr",
        gl: "TR",
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/119 Safari/537.36",
        clientName: "WEB",
        clientVersion: "2.20231121.08.00",
        osName: "Windows",
        osVersion: "10.0",
        platform: "DESKTOP"
      },
      request: { useSsl: true }
    },
    query: musicContinToken ? undefined : query,
    continuation: musicContinToken || undefined
  };

  try {
    const response = (await axios({
      method: "post",
      url: "https://www.youtube.com/youtubei/v1/search?prettyPrint=false",
      headers: { "Content-Type": "text/plain" },
      data: JSON.stringify(payload),
      timeout: 12000
    })).data;

    const contents = (((response || {}).contents || {}).twoColumnSearchResultsRenderer || {}).primaryContents;
    const sections = (((contents || {}).sectionListRenderer || {}).contents) || [];
    const endItem = sections.find(it =>
      getText(it, ["continuationItemRenderer","continuationEndpoint","continuationCommand","request"]) ===
      "CONTINUATION_REQUEST_TYPE_SEARCH"
    );
    if (endItem) {
      musicContinToken = getText(endItem, ["continuationItemRenderer","continuationEndpoint","continuationCommand","token"]);
    }

    const section = sections.find(it => it.itemSectionRenderer);
    const rows = (section && section.itemSectionRenderer && section.itemSectionRenderer.contents) || [];
    const data = rows
      .filter(x => x.videoRenderer)
      .map(x => formatMusicItem(x.videoRenderer))
      .filter(x => x.id);

    return { isEnd: !endItem, data };
  } catch (e) {
    console.error("[YT Music Fresh] search error:", e && e.message ? e.message : e);
    return { isEnd: true, data: [] };
  }
}

async function search(query, page, type) {
  if (type === "music") return await searchMusic(query, page);

  if (type === "artist") {
    const r = await searchMusic(query, 1);
    const seen = {};
    const data = [];
    for (const s of r.data || []) {
      const name = String(s.artist || "").trim();
      if (!name || seen[name.toLowerCase()]) continue;
      seen[name.toLowerCase()] = true;
      data.push({
        id: "artist:" + name,
        name,
        avatar: s.artwork || null,
        description: "YouTube artist results"
      });
    }
    return { isEnd: true, data };
  }

  if (type === "sheet") {
    const r = await searchMusic(query + " playlist", 1);
    const first = (r.data || [])[0] || {};
    return {
      isEnd: true,
      data: [{
        id: "ytmix:" + query,
        title: "YT Mix: " + query,
        artist: "YT Music Fresh",
        artwork: first.artwork || null,
        worksNum: (r.data || []).length,
        description: "YouTube arama sonuçlarından oluşturulan dinamik liste",
        _query: query
      }]
    };
  }

  if (type === "lyric") return await searchLyric(query);

  if (type === "album") {
    const r = await searchMusic(query + " album", 1);
    const data = (r.data || []).map(s => ({
      id: "album:" + s.id,
      title: s.title || "",
      artist: s.artist || "",
      artwork: s.artwork || null,
      description: "YouTube album-style result",
      _query: s.title || query
    }));
    return { isEnd: true, data };
  }

  return { isEnd: true, data: [] };
}

let cacheMediaSource = { id: null, urls: {} };

function getQuality(label) {
  if (label === "tiny") return "low";
  if (label === "medium") return "high";
  if (label === "large") return "super";
  return "standard";
}

async function getMediaSource(musicItem, quality) {
  try {
    const sc = await __soundCloudFallback(musicItem && musicItem.title, musicItem && musicItem.artist);
    if (sc && sc.url) return sc;
  } catch (_) {}
  try {
    const am = await __audiomackFallback(musicItem && musicItem.title, musicItem && musicItem.artist);
    if (am && am.url) return am;
  } catch (_) {}
  if (musicItem.id === cacheMediaSource.id && cacheMediaSource.urls[quality]) {
    return { url: cacheMediaSource.urls[quality] };
  }
  cacheMediaSource = { id: null, urls: {} };

  const data = {
    context: {
      client: {
        hl: "en",
        gl: "GB",
        userAgent: "com.google.android.apps.youtube.music/6.14.50 (Linux; U; Android 13; GB) gzip",
        clientName: "ANDROID_MUSIC",
        clientVersion: "6.14.50",
        osName: "Android",
        osVersion: "13",
        platform: "MOBILE"
      },
      request: { internalExperimentFlags: [], consistencyTokenJars: [] }
    },
    contentCheckOk: true,
    racyCheckOk: true,
    video_id: musicItem.id
  };

  try {
    const result = (await axios({
      method: "post",
      url: "https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
      headers: { "Content-Type": "application/json" },
      data: JSON.stringify(data),
      timeout: 12000
    })).data;

    const formats = (((result || {}).streamingData || {}).formats) || [];
    const adaptive = (((result || {}).streamingData || {}).adaptiveFormats) || [];
    for (const it of [...formats, ...adaptive]) {
      const q = getQuality(it.quality);
      if (it.url && !cacheMediaSource.urls[q]) cacheMediaSource.urls[q] = it.url;
    }
    cacheMediaSource.id = musicItem.id;
    return { url: cacheMediaSource.urls[quality] || cacheMediaSource.urls.standard || cacheMediaSource.urls.high };
  } catch (_) {
    return null;
  }
}

async function getArtistWorks(artistItem, page = 1, type) {
  const name = artistItem && artistItem.name;
  if (!name) return { isEnd: true, data: [] };
  return await search(name, page, type === "album" ? "album" : "music");
}

async function getAlbumInfo(albumItem, page = 1) {
  const q = (albumItem && (albumItem._query || albumItem.title)) || "";
  if (!q) return { isEnd: true, musicList: [] };
  const r = await searchMusic(q, page);
  return { isEnd: r.isEnd, musicList: r.data || [] };
}

async function searchLyric(query) {
  try {
    const r = await axios.get("https://lrclib.net/api/search", {
      params: { q: query },
      headers: { "User-Agent": "Sonnets-YTMusic-Lyrics/2.2" },
      timeout: 10000
    });
    const rows = Array.isArray(r.data) ? r.data : [];
    return {
      isEnd: true,
      data: rows.filter(x => !x.instrumental).map(x => ({
        id: "lrclib:" + String(x.id),
        title: x.trackName || "",
        artist: x.artistName || "",
        album: x.albumName || "",
        rawLrcTxt: x.syncedLyrics || x.plainLyrics || "",
        _rawLrc: x.syncedLyrics || x.plainLyrics || ""
      }))
    };
  } catch (_) {
    return { isEnd: true, data: [] };
  }
}

async function getMusicSheetInfo(sheet, page = 1) {
  const q = (sheet && sheet._query) || (sheet && sheet.title) || "";
  if (!q) return { isEnd: true, musicList: [] };
  const r = await searchMusic(q, page);
  return { isEnd: r.isEnd, musicList: r.data || [] };
}

async function getLyric(item) {
  if (item && item._rawLrc) return { rawLrc: item._rawLrc };
  if (item && item.rawLrcTxt) return { rawLrc: item.rawLrcTxt };
  return null;
}

module.exports = {
  platform: "YT Music Fresh",
  author: "Fresh test",
  version: "2.3.1",
  srcUrl: "https://raw.githubusercontent.com/Tryamaha/Seismic-Tr/main/sonnets-plugins/YTMusicFresh.js",
  cacheControl: "no-cache",
  supportedSearchType: ["music", "album", "artist", "sheet", "lyric"],
  search,
  getMediaSource,
  getArtistWorks,
  getAlbumInfo,
  getMusicSheetInfo,
  getLyric
};