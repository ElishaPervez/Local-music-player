import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SearchResult, DownloadStatus } from "./types";

export const api = {
  ytdlpVersion: () => invoke<string>("ytdlp_version"),
  search: (query: string) => invoke<SearchResult[]>("search", { query }),
  resolveStream: (url: string) => invoke<string>("resolve_stream", { url }),
  downloadSong: (args: {
    url: string;
    videoId: string;
    libraryDir: string;
    format: string;
  }) => invoke<{ videoId: string; filePath: string }>("download_song", args),
  deleteFile: (path: string) => invoke<void>("delete_file", { path }),
  importBackground: (srcPath: string, name: string) =>
    invoke<string>("import_background", { srcPath, name }),
  defaultLibraryDir: () => invoke<string>("default_library_dir"),
  updateYtdlp: () => invoke<string>("update_ytdlp"),
};

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
