import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SearchResult, DownloadStatus } from "./types";

export const api = {
  ytdlpVersion: () => invoke<string>("ytdlp_version"),
  search: (query: string) => invoke<SearchResult[]>("search", { query }),
  relatedMix: (videoId: string, limit: number) =>
    invoke<SearchResult[]>("related_mix", { videoId, limit }),
  resolveStream: (url: string) => invoke<string>("resolve_stream", { url }),
  downloadSong: (args: {
    url: string;
    videoId: string;
    libraryDir: string;
    format: string;
  }) =>
    invoke<{
      videoId: string;
      filePath: string;
      track: string | null;
      artist: string | null;
    }>("download_song", args),
  musicCredits: (videoId: string, videoTitle: string) =>
    invoke<MusicCredits>("music_credits", { videoId, videoTitle }),
  deleteFile: (path: string) => invoke<void>("delete_file", { path }),
  importBackground: (srcPath: string, name: string) =>
    invoke<string>("import_background", { srcPath, name }),
  defaultLibraryDir: () => invoke<string>("default_library_dir"),
  updateYtdlp: () => invoke<string>("update_ytdlp"),
  toolsStatus: () => invoke<ToolsStatus>("tools_status"),
  installFfmpeg: () => invoke<string>("install_ffmpeg"),
  youtubeCookieStatus: () =>
    invoke<YouTubeCookieStatus>("youtube_cookie_status"),
  importYoutubeCookies: (sourcePath: string) =>
    invoke<YouTubeCookieStatus>("import_youtube_cookies", { sourcePath }),
  importYoutubeCookiesText: (cookieText: string) =>
    invoke<YouTubeCookieStatus>("import_youtube_cookies_text", { cookieText }),
  removeYoutubeCookies: () =>
    invoke<YouTubeCookieStatus>("remove_youtube_cookies"),
  verifyYoutubeCookies: () =>
    invoke<YouTubeCookieStatus>("verify_youtube_cookies"),
  discordSetPresence: (presence: DiscordPresence) =>
    invoke<void>("discord_set_presence", { presence }),
  discordClear: () => invoke<void>("discord_clear"),
  discordDisconnect: () => invoke<void>("discord_disconnect"),
};

/** Playback snapshot sent to the Rust Discord Rich Presence bridge. */
export interface DiscordPresence {
  title: string;
  artist: string;
  durationSec: number;
  positionSec: number;
  isPlaying: boolean;
  repeat: string;
  shuffle: boolean;
  playlistName: string | null;
}

/** YouTube's own music credits for a video (real song title / real artist,
 *  from the YouTube Music catalog); null fields when the video has none. */
export interface MusicCredits {
  track: string | null;
  artist: string | null;
}

export interface ToolsStatus {
  ffmpegInstalled: boolean;
  ffmpegPath: string | null;
}

export type YouTubeCookieState =
  | "notConfigured"
  | "unverified"
  | "verified"
  | "rejected"
  | "expired"
  | "invalid";

export interface YouTubeCookieStatus {
  state: YouTubeCookieState;
  updatedAt: number | null;
  checkedAt: number | null;
  usableCookieCount: number;
  expiredCookieCount: number;
}

export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return "The operation failed.";
}

export interface SetupProgress {
  step: "downloading" | "extracting" | "done";
  percent: number;
}

export function onSetupProgress(
  cb: (p: SetupProgress) => void,
): Promise<UnlistenFn> {
  return listen<SetupProgress>("setup-progress", (e) => cb(e.payload));
}

export interface DownloadProgress {
  videoId: string;
  percent: number;
  status: DownloadStatus;
}

export function onDownloadProgress(
  cb: (p: DownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<DownloadProgress>("download-progress", (e) => cb(e.payload));
}

/** Convert a local file path into a webview-loadable asset URL (range-capable). */
export function fileSrc(path: string): string {
  return convertFileSrc(path);
}
