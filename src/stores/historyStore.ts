import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { PlaybackItem } from "../lib/types";
import { usePlayerStore } from "./playerStore";

/** A track that actually started playing, newest first. */
export interface PlayedEntry {
  videoId: string;
  /** Set when the play came from a downloaded library song. */
  songId?: string;
  title: string;
  artist: string;
  durationSec: number;
  thumbnail?: string | null;
  playedAt: number;
}

export interface SearchEntry {
  query: string;
  at: number;
}

const PLAYS_CAP = 24;
const SEARCHES_CAP = 12;

interface HistoryState {
  plays: PlayedEntry[];
  searches: SearchEntry[];
  recordPlay: (item: PlaybackItem) => void;
  /** Overwrite a recorded play's title/artist (music credits can arrive after
   *  the play was logged). */
  amendPlay: (videoId: string, title: string, artist: string) => void;
  recordSearch: (query: string) => void;
  clearPlays: () => void;
  clearSearches: () => void;
}

export const useHistoryStore = create<HistoryState>()(
  persist(
    (set) => ({
      plays: [],
      searches: [],

      recordPlay: (item) =>
        set((s) => {
          const entry: PlayedEntry = {
            videoId: item.videoId,
            songId: item.songId,
            title: item.title,
            artist: item.artist,
            durationSec: item.durationSec,
            thumbnail: item.thumbnail,
            playedAt: Date.now(),
          };
          // Replaying a song moves it to the front instead of duplicating it.
          const rest = s.plays.filter((p) => p.videoId !== item.videoId);
          return { plays: [entry, ...rest].slice(0, PLAYS_CAP) };
        }),

      recordSearch: (query) =>
        set((s) => {
          const q = query.trim();
          if (!q) return s;
          const rest = s.searches.filter(
            (e) => e.query.toLowerCase() !== q.toLowerCase(),
          );
          return {
            searches: [{ query: q, at: Date.now() }, ...rest].slice(
              0,
              SEARCHES_CAP,
            ),
          };
        }),

      amendPlay: (videoId, title, artist) =>
        set((s) => {
          const i = s.plays.findIndex((p) => p.videoId === videoId);
          if (i < 0) return s;
          const plays = [...s.plays];
          plays[i] = { ...plays[i], title, artist };
          return { plays };
        }),

      clearPlays: () => set({ plays: [] }),
      clearSearches: () => set({ searches: [] }),
    }),
    { name: "lmp-history" },
  ),
);

let initialized = false;

/** Watch the player: whenever a track finishes loading and becomes the audible
 * one (cold load or crossfade adoption — both stamp `_loadedKey`), log it as a
 * play. Subscribing from outside keeps playerStore free of history concerns. */
export function initHistory() {
  if (initialized) return;
  initialized = true;
  let prevKey = usePlayerStore.getState()._loadedKey;
  usePlayerStore.subscribe((s) => {
    const key = s._loadedKey;
    const item = s.current();
    if (key && key !== prevKey) {
      if (item && item.key === key) {
        useHistoryStore.getState().recordPlay(item);
      }
    } else if (item && item.key === key) {
      // Music credits for a streamed track can land moments after the play was
      // logged; when the playing item's names change, heal the logged entry.
      // Guarded here (not in amendPlay) so the persisted store isn't rewritten
      // on every position tick.
      const entry = useHistoryStore
        .getState()
        .plays.find((p) => p.videoId === item.videoId);
      if (entry && (entry.title !== item.title || entry.artist !== item.artist)) {
        useHistoryStore
          .getState()
          .amendPlay(item.videoId, item.title, item.artist);
      }
    }
    prevKey = key;
  });
}

// Mirror playerStore's hot-reload handling: a hot update of this module resets
// the flag, so re-subscribe against the current store. Stripped from production.
if (import.meta.hot) {
  initialized = false;
  initHistory();
}
