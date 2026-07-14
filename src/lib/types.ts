export interface SearchResult {
  videoId: string;
  title: string;
  artist: string;
  durationSec: number;
  thumbnail?: string | null;
  url: string;
}

/** A song in the global library. Library songs are always downloaded (offline). */
export interface Song {
  id: string; // == videoId
  title: string;
  artist: string;
  durationSec: number;
  videoId: string;
  url: string;
  thumbnail?: string | null;
  filePath: string;
  addedAt: number;
}

export interface Playlist {
  id: string;
  name: string;
  songIds: string[];
  createdAt: number;
}

export type AudioFormat = "m4a" | "mp3" | "opus";

export interface BackgroundConfig {
  path: string;
  blur: number; // px
  opacity: number; // 0..1
}

export interface Settings {
  libraryDir: string | null;
  audioFormat: AudioFormat;
  background: BackgroundConfig | null;
  /** Fade the last seconds of each track into the next. */
  crossfade: boolean;
  /** Broadcast the currently-playing song to Discord (Rich Presence). */
  discordPresence: boolean;
  /** Auto-append similar (streamed) songs to keep the queue going. */
  autoPlay: boolean;
}

export type PlaybackSource =
  | { kind: "local"; path: string }
  | { kind: "stream"; videoId: string; url: string };

/** A single entry in the play queue (a library song or an ephemeral stream). */
export interface PlaybackItem {
  key: string;
  songId?: string;
  videoId: string;
  title: string;
  artist: string;
  durationSec: number;
  thumbnail?: string | null;
  source: PlaybackSource;
  /** True for tracks the auto-player streamed in to keep the queue going. */
  auto?: boolean;
}

export type RepeatMode = "off" | "all" | "one";
export type DownloadStatus = "downloading" | "done" | "error";
