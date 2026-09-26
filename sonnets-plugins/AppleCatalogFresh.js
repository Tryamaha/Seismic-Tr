"use strict";
const axios = require("axios");

const SEARCH_URL = "https://itunes.apple.com/search";
const LOOKUP_URL = "https://itunes.apple.com/lookup";

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

async function search(query, page = 1, type) {
  const q = String(query || "").trim();
  if (!q) return { isEnd: true, data: [] };

  let entity = "song";
  let formatter = songItem;
  if (type === "album") {
    entity = "album";
    formatter = albumItem;
  } else if (type === "artist") {
    entity = "musicArtist";
    formatter = artistItem;
  } else if (type !== "music") {
    return { isEnd: true, data: [] };
  }

  try {
    const limit = 25;
    const offset = Math.max(0, (Number(page || 1) - 1) * limit);
    const r = await axios.get(SEARCH_URL, {
      params: {
        term: q,
        entity,
        media: "music",
        country: "TR",
        limit,
        offset
      },
      timeout: 12000
    });
    const rows = (r.data && r.data.results) || [];
    return {
      isEnd: rows.length < limit,
      data: rows.map(formatter).filter(x => x.id)
    };
  } catch (e) {
    console.error("[Apple Catalog Fresh] search error:", e && e.message ? e.message : e);
    return { isEnd: true, data: [] };
  }
}

async function getMediaSource(item) {
  return item && item._previewUrl ? { url: item._previewUrl } : null;
}

async function getAlbumInfo(albumItemObj, page = 1) {
  const id = albumItemObj && albumItemObj.id;
  if (!id) return { isEnd: true, musicList: [] };
  try {
    const r = await axios.get(LOOKUP_URL, {
      params: { id, entity: "song", country: "TR" },
      timeout: 12000
    });
    const rows = ((r.data && r.data.results) || []).filter(x => x.wrapperType === "track");
    return {
      isEnd: true,
      musicList: rows.map(songItem).filter(x => x.id)
    };
  } catch (_) {
    return { isEnd: true, musicList: [] };
  }
}

async function getArtistWorks(artistItemObj, page = 1, type) {
  const name = artistItemObj && artistItemObj.name;
  if (!name) return { isEnd: true, data: [] };
  return await search(name, page, type === "album" ? "album" : "music");
}

module.exports = {
  platform: "Apple Catalog Fresh",
  author: "Fresh test",
  version: "2.1.0",
  srcUrl: "https://raw.githubusercontent.com/Tryamaha/Seismic-Tr/main/sonnets-plugins/AppleCatalogFresh.js",
  cacheControl: "no-cache",
  supportedSearchType: ["music", "album", "artist"],
  search,
  getMediaSource,
  getAlbumInfo,
  getArtistWorks
};