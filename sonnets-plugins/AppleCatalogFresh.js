"use strict";
const axios = require("axios");

async function search(query, page, type) {
  if (type !== "music") return { isEnd: true, data: [] };
  const q = String(query || "").trim();
  if (!q) return { isEnd: true, data: [] };
  try {
    const r = await axios.get("https://itunes.apple.com/search", {
      params: { term: q, entity: "song", media: "music", country: "TR", limit: 25 },
      timeout: 12000
    });
    const rows = (r.data && r.data.results) || [];
    return {
      isEnd: true,
      data: rows.map(x => ({
        id: String(x.trackId),
        title: x.trackName || "",
        artist: x.artistName || "",
        album: x.collectionName || "",
        artwork: x.artworkUrl100 ? x.artworkUrl100.replace("100x100bb","600x600bb") : null,
        _previewUrl: x.previewUrl || null
      }))
    };
  } catch (e) {
    console.error("Apple Fresh search error", e && e.message ? e.message : e);
    return { isEnd: true, data: [] };
  }
}

async function getMediaSource(item) {
  return item && item._previewUrl ? { url: item._previewUrl } : null;
}

module.exports = {
  platform: "Apple Catalog Fresh",
  author: "Fresh test",
  version: "2.0.0",
  srcUrl: "https://raw.githubusercontent.com/Tryamaha/Seismic-Tr/main/sonnets-plugins/AppleCatalogFresh.js",
  cacheControl: "no-cache",
  supportedSearchType: ["music"],
  search,
  getMediaSource
};