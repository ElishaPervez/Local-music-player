import { create } from "zustand";
import type { DownloadStatus } from "../lib/types";

interface DownloadEntry {
  percent: number;
  status: DownloadStatus;
  error?: string;
}

interface DownloadsState {
  byVideo: Record<string, DownloadEntry>;
  update: (
    videoId: string,
    percent: number,
    status: DownloadStatus,
    error?: string,
  ) => void;
  clear: (videoId: string) => void;
}

export const useDownloadsStore = create<DownloadsState>((set) => ({
  byVideo: {},
  update: (videoId, percent, status, error) =>
    set((s) => ({
      byVideo: { ...s.byVideo, [videoId]: { percent, status, error } },
    })),
  clear: (videoId) =>
    set((s) => {
      const byVideo = { ...s.byVideo };
      delete byVideo[videoId];
      return { byVideo };
    }),
}));
