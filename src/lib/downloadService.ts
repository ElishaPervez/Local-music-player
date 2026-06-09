import { api, onDownloadProgress } from "./api";
import type { SearchResult, Song } from "./types";
import { useLibraryStore } from "../stores/libraryStore";
import { useDownloadsStore } from "../stores/downloadsStore";

let wired = false;

/** Wire the global download-progress event to the downloads store (once). */
export function initDownloads() {
  if (wired) return;
  wired = true;
  void onDownloadProgress((p) => {
    useDownloadsStore.getState().update(p.videoId, p.percent, p.status);
  });
}

/** Download a search result into the library (and optionally a playlist). */
export async function downloadToPlaylist(
  result: SearchResult,
  playlistId: string | null,
): Promise<void> {
  const lib = useLibraryStore.getState();
  const dl = useDownloadsStore.getState();

  // Already downloaded? Just add it to the playlist — no re-download.
  const existing = lib.songs[result.videoId];
  if (existing?.filePath) {
    if (playlistId) lib.addToPlaylist(playlistId, existing.id);
    dl.update(result.videoId, 100, "done");
    setTimeout(() => useDownloadsStore.getState().clear(result.videoId), 1500);
    return;
  }

  let libraryDir = lib.settings.libraryDir;
  if (!libraryDir) {
    libraryDir = await api.defaultLibraryDir();
    lib.setSettings({ libraryDir });
  }
  const format = lib.settings.audioFormat;

  dl.update(result.videoId, 0, "downloading");
  try {
    const res = await api.downloadSong({
      url: result.url,
      videoId: result.videoId,
      libraryDir,
      format,
    });
    const song: Song = {
      id: result.videoId,
      title: result.title,
      artist: result.artist,
      durationSec: result.durationSec,
      videoId: result.videoId,
      url: result.url,
      thumbnail: result.thumbnail,
      filePath: res.filePath,
      addedAt: Date.now(),
    };
    useLibraryStore.getState().addSong(song);
    if (playlistId) {
      useLibraryStore.getState().addToPlaylist(playlistId, song.id);
    }
    dl.update(result.videoId, 100, "done");
    setTimeout(() => useDownloadsStore.getState().clear(result.videoId), 2500);
  } catch (e) {
    console.error("download failed", e);
    dl.update(result.videoId, 0, "error");
    setTimeout(() => useDownloadsStore.getState().clear(result.videoId), 4000);
  }
}
