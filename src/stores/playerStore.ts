import { create } from "zustand";
import type { PlaybackItem, RepeatMode } from "../lib/types";
import { audio } from "../lib/audio";
import { api, fileSrc } from "../lib/api";
import { shuffleArray } from "../lib/playback";

/** Length of the fade-out / fade-in overlap when crossfade is enabled. */
const CROSSFADE_SEC = 5;

/** The index Next would advance to, or null if there is no next track. */
function peekNextIndex(
  index: number,
  length: number,
  repeat: RepeatMode,
): number | null {
  if (length === 0) return null;
  const n = index + 1;
  if (n < length) return n;
  return repeat === "all" ? 0 : null;
}

interface PlayerState {
  queue: PlaybackItem[];
  index: number;
  isPlaying: boolean;
  position: number;
  duration: number;
  volume: number;
  /** Volume to restore when un-muting via the volume icon. */
  prevVolume: number;
  repeat: RepeatMode;
  shuffle: boolean;
  loadingStream: boolean;
  /** When true, the last seconds of each track fade into the next. */
  crossfade: boolean;
  /** The playlist this queue was started from, or null for ad-hoc queues. */
  playingPlaylistId: string | null;
  /** Saved play order before shuffle, so toggling shuffle off can restore it. */
  naturalOrder: string[] | null;
  /** Bumps on every shuffle-driven reorder; the queue UI animates on change. */
  shuffleTick: number;
  /** Queue index a crossfade has been started for, so it fires only once. */
  crossfadeArmedFor: number | null;
  /** Queue-item key that already got a fresh-stream-URL retry after an error. */
  _errorRetried: string | null;
  /** Errored tracks skipped in a row; stops error-skipping from looping forever. */
  _consecutiveErrors: number;

  current: () => PlaybackItem | null;

  playQueue: (
    items: PlaybackItem[],
    startIndex?: number,
    playlistId?: string | null,
  ) => Promise<void>;
  playShuffled: (
    items: PlaybackItem[],
    playlistId?: string | null,
  ) => Promise<void>;
  playNow: (item: PlaybackItem) => Promise<void>;
  addToQueue: (item: PlaybackItem) => void;
  togglePlay: () => void;
  next: () => void;
  prev: () => void;
  seek: (sec: number) => void;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  toggleShuffle: () => void;
  cycleRepeat: () => void;
  setCrossfade: (on: boolean) => void;
  jumpTo: (index: number) => void;
  reorderQueue: (items: PlaybackItem[]) => void;
  removeFromQueue: (key: string) => void;
  removeSongFromQueue: (songId: string) => void;

  _load: () => Promise<void>;
  _resolveSrc: (item: PlaybackItem) => Promise<string>;
  _onTime: (current: number, duration: number) => void;
  _startCrossfade: (nextIndex: number) => Promise<void>;
  _onPlaybackError: (err: unknown) => void;
}

export const usePlayerStore = create<PlayerState>((set, get) => ({
  queue: [],
  index: -1,
  isPlaying: false,
  position: 0,
  duration: 0,
  volume: 0.8,
  prevVolume: 0.8,
  repeat: "off",
  shuffle: false,
  loadingStream: false,
  crossfade: false,
  playingPlaylistId: null,
  naturalOrder: null,
  shuffleTick: 0,
  crossfadeArmedFor: null,
  _errorRetried: null,
  _consecutiveErrors: 0,

  current: () => {
    const { queue, index } = get();
    return index >= 0 && index < queue.length ? queue[index] : null;
  },

  playQueue: async (items, startIndex = 0, playlistId = null) => {
    if (items.length === 0) return;
    // Plain "Play" always uses the given order — shuffle off.
    set({
      queue: items,
      index: Math.max(0, Math.min(startIndex, items.length - 1)),
      shuffle: false,
      naturalOrder: null,
      playingPlaylistId: playlistId,
    });
    await get()._load();
  },

  playShuffled: async (items, playlistId = null) => {
    if (items.length === 0) return;
    set((s) => ({
      queue: shuffleArray(items),
      index: 0,
      shuffle: true,
      naturalOrder: items.map((it) => it.key),
      playingPlaylistId: playlistId,
      shuffleTick: s.shuffleTick + 1,
    }));
    await get()._load();
  },

  playNow: async (item) => {
    const { queue, index } = get();
    const insertAt = index + 1;
    const newQueue = [...queue];
    newQueue.splice(insertAt, 0, item);
    set({ queue: newQueue, index: insertAt });
    await get()._load();
  },

  addToQueue: (item) => {
    const wasEmpty = get().index === -1;
    set((s) => ({
      queue: [...s.queue, item],
      // Keep the natural order in sync so un-shuffling preserves new songs.
      naturalOrder: s.naturalOrder ? [...s.naturalOrder, item.key] : null,
    }));
    if (wasEmpty) {
      set({ index: 0 });
      void get()._load();
    }
  },

  togglePlay: () => {
    if (!get().current()) return;
    if (get().isPlaying) {
      audio.pause();
      set({ isPlaying: false });
    } else {
      audio
        .resume()
        .then(() => set({ isPlaying: true }))
        .catch(() => {});
    }
  },

  next: () => {
    const { queue, index, repeat, shuffle } = get();
    if (queue.length === 0) return;
    if (repeat === "one") {
      void get()._load();
      return;
    }
    // The queue is already in play order (shuffle pre-arranges it), so Next
    // just walks forward. This keeps Previous correct and the order stable.
    let nextIndex = index + 1;
    if (nextIndex >= queue.length) {
      if (repeat === "all") {
        // Loop. When shuffled, deal a fresh random order for the new pass.
        if (shuffle && queue.length > 1) {
          set((s) => ({
            queue: shuffleArray(queue),
            shuffleTick: s.shuffleTick + 1,
          }));
        }
        nextIndex = 0;
      } else {
        audio.pause();
        set({ isPlaying: false });
        return;
      }
    }
    set({ index: nextIndex });
    void get()._load();
  },

  prev: () => {
    const { position, index } = get();
    // If a crossfade is overlapping, drop back to the outgoing track first.
    audio.cancelCrossfade();
    set({ crossfadeArmedFor: null });
    if (position > 3) {
      audio.seek(0);
      set({ position: 0 });
      return;
    }
    if (index > 0) {
      set({ index: index - 1 });
      void get()._load();
    } else {
      audio.seek(0);
      set({ position: 0 });
    }
  },

  seek: (sec) => {
    audio.cancelCrossfade();
    set({ crossfadeArmedFor: null });
    audio.seek(sec);
    set({ position: sec });
  },

  setVolume: (v) => {
    audio.setVolume(v);
    set({ volume: v });
  },

  toggleMute: () => {
    const { volume, prevVolume } = get();
    if (volume > 0) {
      set({ prevVolume: volume });
      get().setVolume(0);
    } else {
      get().setVolume(prevVolume > 0 ? prevVolume : 0.8);
    }
  },

  toggleShuffle: () => {
    const { queue, index, shuffle, naturalOrder } = get();
    const current = index >= 0 && index < queue.length ? queue[index] : null;

    if (!shuffle) {
      // Turn ON: remember the current order, then shuffle the upcoming songs.
      // The current song is pinned to the front so playback never jumps.
      const natural = queue.map((it) => it.key);
      const rest = queue.filter((_, i) => i !== index);
      const shuffledRest = shuffleArray(rest);
      const newQueue = current ? [current, ...shuffledRest] : shuffledRest;
      set((s) => ({
        queue: newQueue,
        index: current ? 0 : -1,
        shuffle: true,
        naturalOrder: natural,
        shuffleTick: s.shuffleTick + 1,
      }));
      return;
    }

    // Turn OFF: rebuild the saved order, dropping songs that have since left
    // the queue and keeping any that were added while shuffled.
    let restored = queue;
    if (naturalOrder) {
      const byKey = new Map(queue.map((it) => [it.key, it] as const));
      restored = [];
      for (const k of naturalOrder) {
        const it = byKey.get(k);
        if (it) {
          restored.push(it);
          byKey.delete(k);
        }
      }
      for (const it of queue) if (byKey.has(it.key)) restored.push(it);
    }
    const newIndex = current
      ? restored.findIndex((it) => it.key === current.key)
      : index;
    set((s) => ({
      queue: restored,
      index: newIndex >= 0 ? newIndex : index,
      shuffle: false,
      naturalOrder: null,
      shuffleTick: s.shuffleTick + 1,
    }));
  },

  cycleRepeat: () =>
    set((s) => ({
      repeat: s.repeat === "off" ? "all" : s.repeat === "all" ? "one" : "off",
    })),

  setCrossfade: (on) => set({ crossfade: on }),

  jumpTo: (i) => {
    if (i < 0 || i >= get().queue.length) return;
    set({ index: i });
    void get()._load();
  },

  reorderQueue: (items) => {
    const cur = get().current();
    const newIndex = cur
      ? items.findIndex((it) => it.key === cur.key)
      : get().index;
    set({ queue: items, index: newIndex });
  },

  removeSongFromQueue: (songId) => {
    // Pull matching library-song entries out of the live queue (a playlist can
    // hold a song only once, so this is normally a single entry).
    let item = get().queue.find((it) => it.songId === songId);
    while (item) {
      get().removeFromQueue(item.key);
      item = get().queue.find((it) => it.songId === songId);
    }
  },

  removeFromQueue: (key) => {
    const { queue, index, naturalOrder } = get();
    const i = queue.findIndex((it) => it.key === key);
    if (i === -1) return;
    const newQueue = queue.filter((it) => it.key !== key);
    const newNatural = naturalOrder
      ? naturalOrder.filter((k) => k !== key)
      : null;
    if (i === index) {
      const newIndex = Math.min(index, newQueue.length - 1);
      set({ queue: newQueue, index: newIndex, naturalOrder: newNatural });
      if (newQueue.length > 0) {
        void get()._load();
      } else {
        audio.pause();
        set({ isPlaying: false, index: -1, position: 0, duration: 0 });
      }
    } else {
      set({
        queue: newQueue,
        index: i < index ? index - 1 : index,
        naturalOrder: newNatural,
      });
    }
  },

  _load: async () => {
    const item = get().current();
    if (!item) return;
    // Any explicit (re)load cancels a pending crossfade arm for the old track.
    set({ crossfadeArmedFor: null });
    try {
      const src = await get()._resolveSrc(item);
      audio.setVolume(get().volume);
      await audio.play(src);
      set({ isPlaying: true, position: 0, _consecutiveErrors: 0 });
    } catch (e) {
      set({ isPlaying: false, loadingStream: false });
      console.error("playback error", e);
    }
  },

  _resolveSrc: async (item) => {
    if (item.source.kind === "local") return fileSrc(item.source.path);
    if (item.source.url) return item.source.url;
    set({ loadingStream: true });
    try {
      const resolved = await api.resolveStream(
        `https://www.youtube.com/watch?v=${item.videoId}`,
      );
      item.source.url = resolved;
      return resolved;
    } finally {
      set({ loadingStream: false });
    }
  },

  _onTime: (cur, dur) => {
    set({ position: cur || 0, duration: dur || 0 });
    const st = get();
    if (!st.crossfade || st.repeat === "one") return;
    if (!isFinite(dur) || dur <= 0) return;
    if (st.crossfadeArmedFor === st.index) return; // already armed for this track
    if (dur - cur > CROSSFADE_SEC) return; // not in the fade window yet
    const nextIndex = peekNextIndex(st.index, st.queue.length, st.repeat);
    if (nextIndex === null) return; // nothing to fade into
    if (nextIndex === st.index) return; // same track (e.g. repeat-all, 1 song) — no echo
    set({ crossfadeArmedFor: st.index });
    void get()._startCrossfade(nextIndex);
  },

  _startCrossfade: async (nextIndex) => {
    const startIndex = get().index;
    const item = get().queue[nextIndex];
    // Only clear our own arm — playback may have moved on and re-armed since.
    const disarm = () =>
      set((s) =>
        s.crossfadeArmedFor === startIndex ? { crossfadeArmedFor: null } : {},
      );
    if (!item) {
      disarm();
      return;
    }
    let src: string;
    try {
      src = await get()._resolveSrc(item);
    } catch {
      disarm();
      return;
    }
    // Resolving a stream URL can take a moment; bail if playback moved on,
    // the user seeked back out of the fade window (which disarms), or
    // crossfade was switched off in the meantime.
    if (
      get().index !== startIndex ||
      get().crossfadeArmedFor !== startIndex ||
      !get().crossfade
    ) {
      disarm();
      return;
    }
    void audio.crossfadeTo(src, CROSSFADE_SEC * 1000, () => {
      // Overlap finished: the next track is already playing — adopt it where
      // it now sits (queue edits during the fade may have moved or removed it).
      const q = get().queue;
      const idx = q.findIndex((it) => it.key === item.key);
      if (idx >= 0) {
        set({ index: idx, crossfadeArmedFor: null, _consecutiveErrors: 0 });
      } else if (q.length > 0) {
        set({
          index: Math.min(nextIndex, q.length - 1),
          crossfadeArmedFor: null,
        });
        void get()._load();
      } else {
        audio.pause();
        set({
          isPlaying: false,
          index: -1,
          position: 0,
          duration: 0,
          crossfadeArmedFor: null,
        });
      }
    });
  },

  _onPlaybackError: (err) => {
    console.error("media error", err);
    const st = get();
    const item = st.current();
    if (!item) return;
    // A cached stream URL may simply have expired (YouTube URLs last ~6h):
    // drop it and resolve a fresh one, once per queue item.
    if (
      item.source.kind === "stream" &&
      item.source.url &&
      st._errorRetried !== item.key
    ) {
      set({ _errorRetried: item.key });
      item.source.url = "";
      void st._load();
      return;
    }
    // Skip the broken track, but stop once a whole queue's worth of tracks has
    // failed in a row — otherwise repeat-all would hammer dead sources forever.
    const failures = st._consecutiveErrors + 1;
    set({ _consecutiveErrors: failures });
    if (failures >= st.queue.length) {
      audio.pause();
      set({ isPlaying: false });
      return;
    }
    st.next();
  },
}));

let initialized = false;
export function initPlayer() {
  if (initialized) return;
  initialized = true;
  audio.init();
  audio.onTime = (cur, dur) => usePlayerStore.getState()._onTime(cur, dur);
  audio.onEnded = () => usePlayerStore.getState().next();
  audio.onError = (e) => usePlayerStore.getState()._onPlaybackError(e);
  audio.setVolume(usePlayerStore.getState().volume);
}

// During dev, a hot reload of this module makes a fresh store but leaves the
// persistent `audio` singleton bound to the previous store — which freezes the
// seek bar (time updates land in the dead store). Re-wire the callbacks to the
// current store on every hot update. Stripped from production builds.
if (import.meta.hot) {
  initialized = false;
  initPlayer();
}
