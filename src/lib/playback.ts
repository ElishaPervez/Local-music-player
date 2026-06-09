import type { PlaybackItem, SearchResult, Song } from "./types";

let counter = 0;
const uniq = (prefix: string) => `${prefix}-${counter++}`;

/** Fisher–Yates shuffle. Returns a new array; does not mutate the input. */
export function shuffleArray<T>(arr: readonly T[]): T[] {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/** A downloaded library song → a local playback item. */
export function songToItem(song: Song): PlaybackItem {
  return {
    key: uniq(`s${song.id}`),
    songId: song.id,
    videoId: song.videoId,
    title: song.title,
    artist: song.artist,
    durationSec: song.durationSec,
    thumbnail: song.thumbnail,
    source: { kind: "local", path: song.filePath },
  };
}

/** A search result played directly → an ephemeral stream item (resolved lazily). */
export function resultToStreamItem(r: SearchResult): PlaybackItem {
  return {
    key: uniq(`t${r.videoId}`),
    videoId: r.videoId,
    title: r.title,
    artist: r.artist,
    durationSec: r.durationSec,
    thumbnail: r.thumbnail,
    source: { kind: "stream", videoId: r.videoId, url: "" },
  };
}
