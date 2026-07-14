import { api, onDownloadProgress } from "./api";
import type { SearchResult, Song } from "./types";
import { useLibraryStore } from "../stores/libraryStore";
import { useDownloadsStore } from "../stores/downloadsStore";
import { usePlayerStore } from "../stores/playerStore";

let wired = false;

/** Wire the global download-progress event to the downloads store (once). */
export function initDownloads() {
  if (wired) return;
  wired = true;
  void onDownloadProgress((p) => {
    useDownloadsStore.getState().update(p.videoId, p.percent, p.status);
  });
}

/**
 * Ensure a search result is downloaded into the library. Handles the
 * already-downloaded short-circuit, per-song progress, and per-track error
 * swallowing. Returns the library Song on success, or null on failure.
 * Has NO playlist concern — callers decide what to do with the returned Song.
 */
export async function ensureSongInLibrary(
  result: SearchResult,
): Promise<Song | null> {
  const lib = useLibraryStore.getState();
  const dl = useDownloadsStore.getState();

  // Already downloaded? Reference it — no re-download.
  const existing = lib.songs[result.videoId];
  if (existing?.filePath) {
    dl.update(result.videoId, 100, "done");
    setTimeout(() => useDownloadsStore.getState().clear(result.videoId), 1500);
    return existing;
  }

  dl.update(result.videoId, 0, "downloading");
  try {
    // Resolve the library dir lazily, but INSIDE the try: a failure here must
    // return null like any other download failure, never throw — otherwise a
    // rejected worker would reject runPool's Promise.all and abort the whole
    // parallel save, leaving the playlist empty.
    let libraryDir = lib.settings.libraryDir;
    if (!libraryDir) {
      libraryDir = await api.defaultLibraryDir();
      lib.setSettings({ libraryDir });
    }
    const format = lib.settings.audioFormat;
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
    dl.update(result.videoId, 100, "done");
    setTimeout(() => useDownloadsStore.getState().clear(result.videoId), 2500);
    return song;
  } catch (e) {
    console.error("download failed", e);
    dl.update(result.videoId, 0, "error");
    setTimeout(() => useDownloadsStore.getState().clear(result.videoId), 4000);
    return null;
  }
}

/** Download a search result into the library (and optionally a playlist).
 *  Used by the Finder single-download path. */
export async function downloadToPlaylist(
  result: SearchResult,
  playlistId: string | null,
): Promise<void> {
  const song = await ensureSongInLibrary(result);
  if (song && playlistId) {
    useLibraryStore.getState().addToPlaylist(playlistId, song.id);
  }
}

const SAVE_CONCURRENCY = 5;

/**
 * Run `worker` over `items` with at most `limit` in flight at once. Workers pull
 * from a shared cursor (keeping the pool full, not stalling on the slowest item
 * in a fixed batch) and write each result into the slot at its original index,
 * so the returned array preserves input order regardless of completion order.
 */
async function runPool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  async function run() {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      results[i] = await worker(items[i], i);
    }
  }
  const n = Math.min(limit, items.length);
  await Promise.all(Array.from({ length: n }, run));
  return results;
}

/**
 * Save the live play queue as a new, fully-downloaded playlist — in the exact
 * order it's playing. Streamed tracks (auto-player radio picks / direct streams)
 * get downloaded into the library; tracks already downloaded are just
 * referenced. Returns the new playlist id, or null if the queue was empty.
 */
export async function saveQueueAsPlaylist(name: string): Promise<string | null> {
  const queue = usePlayerStore.getState().queue;
  if (queue.length === 0) return null;
  const playlist = useLibraryStore.getState().createPlaylist(name);

  // Snapshot the order at click time: with auto-play on, the live queue keeps
  // growing while we download, but "save current playlist" means save what is
  // playing now, not whatever the radio appends during the save.
  const items = [...queue];
  const results: SearchResult[] = items.map((item) => ({
    videoId: item.videoId,
    title: item.title,
    artist: item.artist,
    durationSec: item.durationSec,
    thumbnail: item.thumbnail,
    url: `https://www.youtube.com/watch?v=${item.videoId}`,
  }));

  // Bounded-parallel downloads (the audio files are small). Each slot holds the
  // resulting Song (or null on failure), positioned at its QUEUE index —
  // independent of completion order. ensureSongInLibrary swallows its own
  // errors, so one bad track returns null and never aborts the pool.
  const songs = await runPool(results, SAVE_CONCURRENCY, (r) =>
    ensureSongInLibrary(r),
  );

  // Build songIds strictly in queue order, dropping failed tracks and de-duping
  // while keeping first-occurrence position (matches addToPlaylist's de-dupe).
  const seen = new Set<string>();
  const orderedIds: string[] = [];
  for (const song of songs) {
    if (song && !seen.has(song.id)) {
      seen.add(song.id);
      orderedIds.push(song.id);
    }
  }

  // Single ordered write — order is correct by construction (it comes from the
  // queue index), never from download-completion timing.
  useLibraryStore.getState().reorderPlaylist(playlist.id, orderedIds);
  return playlist.id;
}
