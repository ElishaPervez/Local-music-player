import { create } from "zustand";
import type { DownloadStatus } from "../lib/types";

interface DownloadEntry {
  percent: number;
  status: DownloadStatus;
}

interface DownloadsState {
  byVideo: Record<string, DownloadEntry>;
  update: (videoId: string, percent: number, status: DownloadStatus) => void;
  clear: (videoId: string) => void;
}

export const useDownloadsStore = create<DownloadsState>((set) => ({
  byVideo: {},
  update: (videoId, percent, status) =>
    set((s) => ({
      byVideo: { ...s.byVideo, [videoId]: { percent, status } },
    })),
  clear: (videoId) =>
    set((s) => {
      const byVideo = { ...s.byVideo };
      delete byVideo[videoId];
      return { byVideo };
    }),
}));
