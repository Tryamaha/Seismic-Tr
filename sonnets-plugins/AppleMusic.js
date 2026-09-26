"use strict";
const axios = require("axios");

const HOST = "music.gdstudio.xyz";
const BASE_URL = "https://music.gdstudio.xyz/";
const API_URL = "https://music.gdstudio.xyz/api.php";
const TIME_URL = "https://music.gdstudio.xyz/time";
const VERSION = "2026.08.01";
const SOURCE = "apple";
const PLATFORM = "Apple Music";

const headers = {
  "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1",
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
  "Referer": "https://music.gdstudio.xyz/",
  "X-Requested-With": "XMLHttpRequest",
  "Accept": "application/json, text/javascript, */*; q=0.01",
  "Origin": "https://music.gdstudio.xyz"
};

function strictEncode(value) {
  return encodeURIComponent(String(value)).replace(/[!'()*]/g, c =>
    "%" + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

function normalizeVersion(v) {
  return v.split(".").map(x => x.length === 1 ? "0" + x : x).join("");
}

async function serverTime() {
  try {
    const r = await axios.get(TIME_URL, { timeout: 8000 });
    const t = String(r.data || "").trim();
    if (t) return t;
  } catch (_) {}
  return String(Math.floor(Date.now() / 1000));
}

async function sign(payload) {
  const t = await serverTime();
  const input = String(t).slice(0, 9) + "|" + HOST + "|" + normalizeVersion(VERSION) + "|" + payload;
  return CryptoJs.MD5(input).toString(CryptoJs.enc.Hex).slice(-8).toUpperCase();
}

function formBody(obj) {
  return Object.keys(obj).map(k => encodeURIComponent(k) + "=" + encodeURIComponent(String(obj[k]))).join("&");
}

async function postApi(data) {
  const r = await axios.post(API_URL, formBody(data), { headers, timeout: 12000 });
  return r.data;
}

function artworkFrom(item) {
  const p = item && item.pic_id;
  if (!p) return null;
  if (SOURCE === "apple" && String(p).includes("{w}")) {
    return String(p).replace("{w}", "500").replace("{h}", "500");
  }
  return null;
}

function formatMusicItem(item) {
  return {
    id: String(item.id || item.url_id || ""),
    title: item.name || "",
    artist: Array.isArray(item.artist) ? item.artist.join("/") : (item.artist || ""),
    album: item.album || "",
    artwork: artworkFrom(item),
    source: item.source || SOURCE,
    qualities: {
      "128k": { size: null },
      "192k": { size: null },
      "320k": { size: null },
      "flac": { size: null },
      "hires": { size: null }
    },
    _rawData: item
  };
}

async function search(query, page = 1, type) {
  if (type !== "music") return { isEnd: true, data: [] };
  const q = String(query || "").trim();
  if (!q) return { isEnd: true, data: [] };

  try {
    const data = await postApi({
      types: "search",
      count: "20",
      pages: String(page || 1),
      name: q,
      s: await sign(strictEncode(q)),
      source: SOURCE
    });

    if (!Array.isArray(data)) return { isEnd: true, data: [] };

    return {
      isEnd: data.length < 20,
      data: data.map(formatMusicItem)
    };
  } catch (e) {
    console.error("[" + PLATFORM + "] search error:", e && e.message ? e.message : e);
    return { isEnd: true, data: [] };
  }
}

async function getMediaSource(musicItem, quality) {
  const raw = musicItem._rawData || {};
  const id = String(raw.url_id || musicItem.id || "");
  const src = raw.source || musicItem.source || SOURCE;
  if (!id) return null;

  const qualityMap = { "128k": "128", "192k": "192", "320k": "320", "flac": "740", "hires": "999" };
  const br = qualityMap[quality] || "320";

  try {
    const data = await postApi({
      types: "url",
      id,
      source: src,
      br,
      s: await sign(strictEncode(id))
    });
    if (!data || !data.url) return null;
    let url = String(data.url);
    if (!/^https?:\/\//i.test(url)) url = BASE_URL + url.replace(/^\//, "");
    return { url };
  } catch (e) {
    console.error("[" + PLATFORM + "] media error:", e && e.message ? e.message : e);
    return null;
  }
}

async function getLyric(musicItem) {
  const raw = musicItem._rawData || {};
  const id = String(raw.lyric_id || "");
  const src = raw.source || musicItem.source || SOURCE;
  if (!id) return null;

  try {
    const data = await postApi({
      types: "lyric",
      id,
      source: src,
      s: await sign(strictEncode(id))
    });
    if (!data) return null;
    let rawLrc = data.lyric || "";
    if (data.tlyric) rawLrc += "\n" + data.tlyric;
    return rawLrc ? { rawLrc } : null;
  } catch (_) {
    return null;
  }
}

async function getMusicInfo(musicItem) {
  const raw = musicItem._rawData || {};
  const direct = artworkFrom(raw);
  if (direct) return { artwork: direct };

  const picId = raw.pic_id;
  if (!picId) return {};
  const src = raw.source || musicItem.source || SOURCE;

  try {
    const data = await postApi({
      types: "pic",
      id: String(picId),
      source: src,
      size: "500",
      s: await sign(strictEncode(String(picId)))
    });
    return data && data.url ? { artwork: data.url } : {};
  } catch (_) {
    return {};
  }
}

module.exports = {
  platform: PLATFORM,
  author: "Toskysun / Sonnets fix",
  version: "1.1.0",
  srcUrl: "https://raw.githubusercontent.com/Tryamaha/Seismic-Tr/main/sonnets-plugins/AppleMusic.js",
  cacheControl: "no-cache",
  description: PLATFORM + " source for Sonnets using GD Studio's current signed API.",
  supportedSearchType: ["music"],
  search,
  getMediaSource,
  getLyric,
  getMusicInfo
};
