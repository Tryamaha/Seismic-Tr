"use strict";
const axios = require("axios");

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

module.exports = {
  platform: "YT Music Fresh",
  author: "Fresh test",
  version: "2.1.0",
  srcUrl: "https://raw.githubusercontent.com/Tryamaha/Seismic-Tr/main/sonnets-plugins/YTMusicFresh.js",
  cacheControl: "no-cache",
  supportedSearchType: ["music", "album", "artist"],
  search,
  getMediaSource,
  getArtistWorks,
  getAlbumInfo
};