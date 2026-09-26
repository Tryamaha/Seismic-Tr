"use strict";
const axios = require("axios");


function oauthEncode(v) {
  return encodeURIComponent(String(v == null ? "" : v))
    .replace(/[!'()*]/g, function(c) {
      return "%" + c.charCodeAt(0).toString(16).toUpperCase();
    });
}

function nonce(n) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < (n || 24); i++) {
    out += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return out;
}

function normalizeText(v) {
  return String(v || "").toLowerCase()
    .replace("ı", "i")
    .replace("ğ", "g")
    .replace("ü", "u")
    .replace("ş", "s")
    .replace("ö", "o")
    .replace("ç", "c");
}

function scoreCandidate(candidateTitle, candidateArtist, title, artist) {
  const ct = normalizeText(candidateTitle);
  const ca = normalizeText(candidateArtist);
  const t = normalizeText(title);
  const a = normalizeText(artist);
  let score = 0;
  if (ct === t) score += 6;
  else if (ct.indexOf(t) >= 0 || t.indexOf(ct) >= 0) score += 4;
  if (a && ca === a) score += 4;
  else if (a && (ca.indexOf(a) >= 0 || a.indexOf(ca) >= 0)) score += 2;
  return score;
}

function oauthSignature(method, absoluteUrl, params) {
  const keys = Object.keys(params).sort();
  const parts = [];
  for (const key of keys) {
    if (key === "oauth_signature") continue;
    parts.push(oauthEncode(key) + "=" + oauthEncode(params[key]));
  }
  const normalized = parts.join("&");
  const base = oauthEncode(method.toUpperCase()) + "&" + oauthEncode(absoluteUrl) + "&" + oauthEncode(normalized);
  return CryptoJs.HmacSHA1(base, "f3ac5b086f3eab260520d8e3049561e6&").toString(CryptoJs.enc.Base64);
}

async function audiomackFullTrack(title, artist) {
  const query = [artist, title].filter(Boolean).join(" ");
  if (!query) return null;

  const searchUrl = "https://api.audiomack.com/v1/search";
  const params = {
    limit: 12,
    oauth_consumer_key: "audiomack-js",
    oauth_nonce: nonce(32),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.round(Date.now() / 1000),
    oauth_version: "1.0",
    page: 1,
    q: query,
    show: "songs",
    sort: "popular"
  };
  params.oauth_signature = oauthSignature("GET", searchUrl, params);

  const response = await axios.get(searchUrl, {
    params: params,
    headers: { "User-Agent": "Mozilla/5.0" },
    timeout: 12000
  });

  const rows = response.data && response.data.results ? response.data.results : [];
  if (!rows.length) return null;

  let best = null;
  let bestScore = -1;
  for (const row of rows) {
    const s = scoreCandidate(row.title, row.artist, title, artist);
    if (s > bestScore) {
      bestScore = s;
      best = row;
    }
  }
  if (!best || bestScore < 2) return null;

  const playUrl = "https://api.audiomack.com/v1/music/play/" + best.id;
  const playParams = {
    environment: "desktop-web",
    hq: true,
    oauth_consumer_key: "audiomack-js",
    oauth_nonce: nonce(32),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.round(Date.now() / 1000),
    oauth_version: "1.0",
    section: "/search"
  };
  playParams.oauth_signature = oauthSignature("GET", playUrl, playParams);

  const playResponse = await axios.get(playUrl, {
    params: playParams,
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Origin": "https://audiomack.com"
    },
    timeout: 12000
  });

  const finalUrl = playResponse.data && playResponse.data.signedUrl;
  return finalUrl ? { url: finalUrl } : null;
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
    const full = await audiomackFullTrack(musicItem && musicItem.title, musicItem && musicItem.artist);
    if (full && full.url) return full;
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
    const all = formats.concat(adaptive);
    for (const it of all) {
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
  platform: "YT Music Full Test",
  author: "Fresh test",
  version: "2.4.0",
  srcUrl: "https://raw.githubusercontent.com/Tryamaha/Seismic-Tr/main/sonnets-plugins/YTMusicFull240.js",
  cacheControl: "no-cache",
  supportedSearchType: ["music", "album", "artist", "sheet", "lyric"],
  search,
  getMediaSource,
  getArtistWorks,
  getAlbumInfo,
  getMusicSheetInfo,
  getLyric
};