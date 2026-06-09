import { create } from "zustand";
import { persist } from "zustand/middleware";

export type View = "finder" | "playlists" | "settings";

export const QUEUE_W_DEFAULT = 280;
export const QUEUE_W_MIN = 220;
export const QUEUE_W_MAX = 440;

interface UIState {
  view: View;
  sidebarCollapsed: boolean;
  selectedPlaylistId: string | null;
  /** Width of the right-hand "Playing playlist" panel, user-resizable. */
  queueWidth: number;
  setView: (view: View) => void;
  toggleSidebar: () => void;
  setSelectedPlaylist: (id: string | null) => void;
  setQueueWidth: (w: number) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      view: "finder",
      sidebarCollapsed: false,
      selectedPlaylistId: null,
      queueWidth: QUEUE_W_DEFAULT,
      setView: (view) => set({ view }),
      toggleSidebar: () =>
        set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),
      setSelectedPlaylist: (selectedPlaylistId) => set({ selectedPlaylistId }),
      setQueueWidth: (w) =>
        set({
          queueWidth: Math.max(QUEUE_W_MIN, Math.min(QUEUE_W_MAX, w)),
        }),
    }),
    {
      name: "lmp-ui",
      partialize: (s) => ({
        view: s.view,
        sidebarCollapsed: s.sidebarCollapsed,
        queueWidth: s.queueWidth,
      }),
    },
  ),
);
