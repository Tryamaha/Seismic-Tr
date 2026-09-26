"use strict";
const axios = require("axios");

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
  version: "2.2.0",
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