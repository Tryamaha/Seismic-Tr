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


const SEARCH_URL = "https://itunes.apple.com/search";
const LOOKUP_URL = "https://itunes.apple.com/lookup";
const LRCLIB = "https://lrclib.net";

function art(url) {
  if (!url) return null;
  return String(url)
    .replace("100x100bb", "600x600bb")
    .replace("100x100-75", "600x600-75");
}

function songItem(x) {
  return {
    id: String(x.trackId || ""),
    title: x.trackName || "",
    artist: x.artistName || "",
    album: x.collectionName || "",
    artwork: art(x.artworkUrl100 || x.artworkUrl60),
    duration: x.trackTimeMillis ? Math.round(x.trackTimeMillis / 1000) : undefined,
    _previewUrl: x.previewUrl || null,
    _rawData: x
  };
}

function albumItem(x) {
  return {
    id: String(x.collectionId || ""),
    title: x.collectionName || "",
    artist: x.artistName || "",
    artwork: art(x.artworkUrl100 || x.artworkUrl60),
    description: x.primaryGenreName || "",
    _rawData: x
  };
}

function artistItem(x) {
  return {
    id: String(x.artistId || ""),
    name: x.artistName || "",
    avatar: null,
    description: x.primaryGenreName || "",
    _rawData: x
  };
}

async function searchSongs(query, page = 1) {
  const limit = 25;
  const offset = Math.max(0, (Number(page || 1) - 1) * limit);
  const r = await axios.get(SEARCH_URL, {
    params: { term: query, entity: "song", media: "music", country: "TR", limit, offset },
    timeout: 12000
  });
  const rows = (r.data && r.data.results) || [];
  return { isEnd: rows.length < limit, data: rows.map(songItem).filter(x => x.id) };
}

async function searchLyrics(query) {
  try {
    const r = await axios.get(LRCLIB + "/api/search", {
      params: { q: query },
      headers: { "User-Agent": "Sonnets-Apple-Lyrics/2.2" },
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

async function search(query, page = 1, type) {
  const q = String(query || "").trim();
  if (!q) return { isEnd: true, data: [] };

  if (type === "music") {
    try { return await searchSongs(q, page); } catch (_) { return { isEnd: true, data: [] }; }
  }

  if (type === "album") {
    try {
      const limit = 25;
      const offset = Math.max(0, (Number(page || 1) - 1) * limit);
      const r = await axios.get(SEARCH_URL, {
        params: { term: q, entity: "album", media: "music", country: "TR", limit, offset },
        timeout: 12000
      });
      const rows = (r.data && r.data.results) || [];
      return { isEnd: rows.length < limit, data: rows.map(albumItem).filter(x => x.id) };
    } catch (_) { return { isEnd: true, data: [] }; }
  }

  if (type === "artist") {
    try {
      const r = await axios.get(SEARCH_URL, {
        params: { term: q, entity: "musicArtist", media: "music", country: "TR", limit: 25 },
        timeout: 12000
      });
      const rows = (r.data && r.data.results) || [];
      return { isEnd: true, data: rows.map(artistItem).filter(x => x.id) };
    } catch (_) { return { isEnd: true, data: [] }; }
  }

  if (type === "sheet") {
    try {
      const r = await searchSongs(q, 1);
      const first = (r.data || [])[0] || {};
      return {
        isEnd: true,
        data: [{
          id: "applemix:" + q,
          title: "Apple Mix: " + q,
          artist: "Apple Catalog Fresh",
          artwork: first.artwork || null,
          worksNum: (r.data || []).length,
          description: "Apple katalog sonuçlarından oluşturulan dinamik liste",
          _query: q
        }]
      };
    } catch (_) { return { isEnd: true, data: [] }; }
  }

  if (type === "lyric") return await searchLyrics(q);

  return { isEnd: true, data: [] };
}

async function getMediaSource(item) {
  const title = item && item.title;
  const artist = item && item.artist;
  if (title) {
    try {
      const full = await __fullTrackFallback(title, artist);
      if (full && full.url) return full;
    } catch (_) {}
  }
  return item && item._previewUrl ? { url: item._previewUrl } : null;
}

async function getAlbumInfo(albumItemObj) {
  const id = albumItemObj && albumItemObj.id;
  if (!id) return { isEnd: true, musicList: [] };
  try {
    const r = await axios.get(LOOKUP_URL, {
      params: { id, entity: "song", country: "TR" },
      timeout: 12000
    });
    const rows = ((r.data && r.data.results) || []).filter(x => x.wrapperType === "track");
    return { isEnd: true, musicList: rows.map(songItem).filter(x => x.id) };
  } catch (_) {
    return { isEnd: true, musicList: [] };
  }
}

async function getArtistWorks(artistItemObj, page = 1, type) {
  const name = artistItemObj && artistItemObj.name;
  if (!name) return { isEnd: true, data: [] };
  return await search(name, page, type === "album" ? "album" : "music");
}

async function getMusicSheetInfo(sheet, page = 1) {
  const q = (sheet && sheet._query) || "";
  if (!q) return { isEnd: true, musicList: [] };
  const r = await searchSongs(q, page);
  return { isEnd: r.isEnd, musicList: r.data || [] };
}

async function getLyric(item) {
  if (item && item._rawLrc) return { rawLrc: item._rawLrc };
  if (item && item.rawLrcTxt) return { rawLrc: item.rawLrcTxt };
  return null;
}

module.exports = {
  platform: "Apple Catalog Fresh",
  author: "Fresh test",
  version: "2.3.1",
  srcUrl: "https://raw.githubusercontent.com/Tryamaha/Seismic-Tr/main/sonnets-plugins/AppleCatalogFresh.js",
  cacheControl: "no-cache",
  supportedSearchType: ["music", "album", "artist", "sheet", "lyric"],
  search,
  getMediaSource,
  getAlbumInfo,
  getArtistWorks,
  getMusicSheetInfo,
  getLyric
};