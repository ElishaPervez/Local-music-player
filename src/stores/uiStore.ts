import { create } from "zustand";
import { persist } from "zustand/middleware";

export type View = "home" | "finder" | "playlists" | "settings";

export const QUEUE_W_DEFAULT = 280;
export const QUEUE_W_MIN = 220;
export const QUEUE_W_MAX = 440;

interface UIState {
  view: View;
  sidebarCollapsed: boolean;
  selectedPlaylistId: string | null;
  /** Width of the right-hand "Playing playlist" panel, user-resizable. */
  queueWidth: number;
  /** A query handed to the Finder (e.g. a Home-page "recent search" chip);
   * FinderView consumes and clears it on arrival. */
  pendingSearch: string | null;
  setView: (view: View) => void;
  setPendingSearch: (q: string | null) => void;
  toggleSidebar: () => void;
  setSelectedPlaylist: (id: string | null) => void;
  setQueueWidth: (w: number) => void;
}

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      view: "home",
      sidebarCollapsed: false,
      selectedPlaylistId: null,
      queueWidth: QUEUE_W_DEFAULT,
      pendingSearch: null,
      setView: (view) => set({ view }),
      setPendingSearch: (pendingSearch) => set({ pendingSearch }),
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
      // v1: the Home view shipped. Existing installs have their last tab
      // persisted; migrate them onto Home once so the new page is seen.
      version: 1,
      migrate: (persisted) => {
        const p = persisted as {
          view?: View;
          sidebarCollapsed?: boolean;
          queueWidth?: number;
        } | null;
        return {
          sidebarCollapsed: p?.sidebarCollapsed ?? false,
          queueWidth: p?.queueWidth ?? QUEUE_W_DEFAULT,
          view: "home" as const,
        };
      },
      partialize: (s) => ({
        view: s.view,
        sidebarCollapsed: s.sidebarCollapsed,
        queueWidth: s.queueWidth,
      }),
    },
  ),
);
