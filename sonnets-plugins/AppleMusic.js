"use strict";
const axios = require("axios");

const SEARCH_URL = "https://itunes.apple.com/search";

function artwork(url) {
  if (!url) return null;
  return String(url).replace("100x100bb", "600x600bb");
}

async function search(query, page = 1, type) {
  if (type !== "music") return { isEnd: true, data: [] };
  const q = String(query || "").trim();
  if (!q) return { isEnd: true, data: [] };

  const limit = 25;
  const offset = Math.max(0, (Number(page || 1) - 1) * limit);

  try {
    const r = await axios.get(SEARCH_URL, {
      params: {
        term: q,
        entity: "song",
        media: "music",
        country: "TR",
        limit,
        offset
      },
      timeout: 12000
    });

    const rows = (r.data && r.data.results) || [];
    const data = rows
      .filter(x => x && x.trackId && x.trackName)
      .map(x => ({
        id: String(x.trackId),
        title: x.trackName || "",
        artist: x.artistName || "",
        album: x.collectionName || "",
        artwork: artwork(x.artworkUrl100),
        duration: x.trackTimeMillis ? Math.round(x.trackTimeMillis / 1000) : undefined,
        _previewUrl: x.previewUrl || null,
        _trackViewUrl: x.trackViewUrl || null
      }));

    return { isEnd: rows.length < limit, data };
  } catch (e) {
    console.error("[Apple Music] search error:", e && e.message ? e.message : e);
    return { isEnd: true, data: [] };
  }
}

async function getMediaSource(musicItem) {
  if (!musicItem || !musicItem._previewUrl) return null;
  return { url: musicItem._previewUrl };
}

module.exports = {
  platform: "Apple Music",
  author: "Sonnets / Apple iTunes Search",
  version: "1.2.0",
  srcUrl: "https://raw.githubusercontent.com/Tryamaha/Seismic-Tr/main/sonnets-plugins/AppleMusic.js",
  cacheControl: "no-cache",
  description: "Apple katalog araması. Apple'ın herkese açık iTunes Search API'sini kullanır; oynatma Apple'ın sağladığı kısa önizleme ile sınırlıdır. Tam Apple Music abonelik akışı MusicKit yetkilendirmesi gerektirir.",
  supportedSearchType: ["music"],
  search,
  getMediaSource
};
