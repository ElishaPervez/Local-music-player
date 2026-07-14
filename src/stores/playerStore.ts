import { create } from "zustand";
import type {
  PlaybackItem,
  RepeatMode,
  SearchResult,
  Song,
} from "../lib/types";
import { audio } from "../lib/audio";
import { api, fileSrc } from "../lib/api";
import { resultToStreamItem, shuffleArray } from "../lib/playback";

/** Length of the fade-out / fade-in overlap when crossfade is enabled. */
const CROSSFADE_SEC = 5;

/** Begin pre-resolving + pre-buffering the next track this many seconds before
 * it ends — wide enough that resolve (~1-3s) + initial buffering complete
 * BEFORE the 5s crossfade window arms. Must be strictly greater than CROSSFADE_SEC. */
const PREFETCH_LEAD_SEC = 12;

/** After a background prefetch resolve FAILS, hold off retrying that same target
 * for this long. _onTime fires ~4×/sec across the whole PREFETCH_LEAD_SEC window,
 * so without a per-target backoff a single un-resolvable next track would spawn a
 * fresh yt-dlp -g every ~250ms. This caps a dead next track to a handful of
 * attempts over its lead window instead of one per tick. */
const PREFETCH_FAIL_COOLDOWN_MS = 5000;

/** Auto-player ("radio") tuning. */
const AUTO_LOW_WATER = 3; // top up when this many or fewer unplayed tracks remain
const AUTO_BATCH = 18; // candidates requested per Mix fetch
const RECENT_CAP = 200; // session de-dupe ring size
/** When a top-up parks at end-of-queue having appended nothing (transient empty
 * mix / throttle / everything filtered), audio is paused so no timeupdate fires
 * to re-trigger the low-water check. Schedule one delayed retry so a momentary
 * outage doesn't permanently end the session. */
const AUTO_RETRY_MS = 15000;
/** Max yt-dlp Mix fetches a single top-up may fire while walking the seed pool.
 * Without this, a converged late session (mix returns songs, but every one is
 * already queued/seen so it filters out) would fire one yt-dlp call per seed —
 * up to a whole playlist's worth — in a single tick. Capping the per-tick fetch
 * count, together with the post-tick cooldown, keeps request volume low (§9). */
const AUTO_MAX_SEEDS = 4;

/** Title fragments that mark a remix/edit re-upload we don't want as a suggestion. */
const REMIX_MARKERS = [
  "slowed", "reverb", "sped up", "spedup", "nightcore", "8d", "lofi", "lo-fi",
  "remix", "mashup", "bass boost", "bassboost", "instrumental", "karaoke",
  "cover", "loop", "extended",
];

/** Strip decoration so two titles for the same song normalize to the same core. */
function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ") // strip (Official Video) / [Lyrics]
    .replace(/official|lyrics|audio|video|hd|mv/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Current track first, then the playing-playlist songs, then other queue items,
 * as fallback seeds — de-duped, order-preserving. (An offline playlist still
 * knows each song's origin videoId, so it can seed the Mix without a download.) */
function buildSeedPool(state: PlayerState): string[] {
  const ids: string[] = [];
  const cur = state.current();
  if (cur?.videoId) ids.push(cur.videoId);
  // The queue is seeded from the whole playing playlist, so its library-song
  // entries (those carrying a songId) are the playlist's videoIds, in order.
  for (const it of state.queue) {
    if (it.songId && it.videoId) ids.push(it.videoId);
  }
  // Finally, any other queue items as last-resort seeds.
  for (const it of state.queue) if (it.videoId) ids.push(it.videoId);
  return [...new Set(ids)];
}

/** Drop suggestions already queued/seen/downloaded, and remix re-renders of a
 * song we're currently playing or queueing. */
function filterCandidates(
  results: SearchResult[],
  state: PlayerState,
): SearchResult[] {
  const queued = new Set(state.queue.map((i) => i.videoId));
  const recent = new Set(state._recentVideoIds);
  const libIds = new Set(state._libraryVideoIds); // already-downloaded songs
  // Guard only against shadowing the current track plus the user's own
  // (non-radio) songs — NOT the auto-appended radio tracks, or this exclusion
  // set would grow unbounded over a session (O(candidates × queue) per top-up)
  // and increasingly drop legit songs whose title happens to share a 4+char
  // substring with some far-back radio pick.
  const seedCores = new Set(
    [state.current(), ...state.queue.filter((i) => !i.auto)]
      .filter((i): i is PlaybackItem => Boolean(i))
      .map((i) => normalizeTitle(i.title)),
  );
  const out: SearchResult[] = [];
  const seenThisBatch = new Set<string>();
  for (const r of results) {
    if (!r.videoId) continue;
    if (queued.has(r.videoId) || recent.has(r.videoId) || libIds.has(r.videoId))
      continue;
    if (seenThisBatch.has(r.videoId)) continue;
    const norm = normalizeTitle(r.title);
    const hasMarker = REMIX_MARKERS.some((m) => norm.includes(m));
    // Drop only if it's BOTH a remix-marked title AND a re-rendering of a song
    // we're already playing/queueing (so legit songs that merely contain
    // "remix" survive unless they shadow a current track). Require a core of a
    // few characters so a one-word normalized title (e.g. "go") doesn't match
    // unrelated candidates via includes().
    if (hasMarker && [...seedCores].some((c) => c.length >= 4 && norm.includes(c)))
      continue;
    seenThisBatch.add(r.videoId);
    out.push(r);
  }
  return out;
}

/** In-flight stream-URL resolves, keyed by item.key, so a foreground resolve
 * (jump / crossfade arm) and the background prefetch of the SAME item share one
 * yt-dlp -g subprocess instead of racing two. Cleared as soon as the resolve
 * settles; the resolved URL is then cached on item.source.url for later hits. */
const inflightResolves = new Map<string, Promise<string>>();

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
  /** When true, similar streamed songs are appended as the queue runs low. */
  autoPlay: boolean;
  /** The playlist this queue was started from, or null for ad-hoc queues. */
  playingPlaylistId: string | null;
  /** Saved play order before shuffle, so toggling shuffle off can restore it. */
  naturalOrder: string[] | null;
  /** Bumps on every shuffle-driven reorder; the queue UI animates on change. */
  shuffleTick: number;
  /** Queue index a crossfade has been started for, so it fires only once. */
  crossfadeArmedFor: number | null;
  /** Queue item currently audible on the incoming side of a crossfade. */
  _crossfadeTargetKey: string | null;
  /** Latest load/resume/pause command. Older async completions are ignored. */
  _playbackCommandId: number;
  /** Queue item actually loaded on the active audio element, if any. */
  _loadedKey: string | null;
  /** item.key of the upcoming track prefetch has fired for — fires once per
   *  target, mirrors crossfadeArmedFor. null = nothing prefetched/eligible. */
  _prefetchedFor: string | null;
  /** Guards the background resolve so _onTime (~4×/sec) can't spawn a second
   *  yt-dlp -g for the same item while the first is in flight. */
  _prefetchInFlight: boolean;
  /** After a prefetch resolve fails for an item, the key + earliest-retry time so
   *  _onTime backs off instead of re-spawning yt-dlp -g on every ~250ms tick.
   *  null = no prefetch failure is currently being backed off. */
  _prefetchFailKey: string | null;
  _prefetchFailUntil: number;
  /** Queue-item key that already got a fresh-stream-URL retry after an error. */
  _errorRetried: string | null;
  /** Errored tracks skipped in a row; stops error-skipping from looping forever. */
  _consecutiveErrors: number;
  /** Guards the auto-top-up fetch so it fires once at a time. */
  _autoTopUpInFlight: boolean;
  /** Changes whenever old auto-play work must no longer affect this queue. */
  _autoSessionId: number;
  /** Earliest time (ms epoch) the low-water trigger may fetch again. Set when a
   * top-up appends nothing (empty mix / throttle / everything already queued)
   * so a converged Mix can't spawn a yt-dlp fetch on every timeupdate. */
  _autoCooldownUntil: number;
  /** Ring (~200) of videoIds appended/seen this session, for de-dupe. */
  _recentVideoIds: string[];
  /** Seeds whose Mix came back empty — skipped on later top-ups. */
  _deadSeeds: Set<string>;
  /** Pending one-shot retry timer for a parked-with-no-append top-up, so a
   * transient empty/throttled tick doesn't permanently strand playback while
   * audio is paused (no timeupdate events fire to re-trigger the low-water
   * check). null when no retry is scheduled. */
  _autoRetryTimer: ReturnType<typeof setTimeout> | null;
  /** VideoIds of downloaded library songs, mirrored from libraryStore. */
  _libraryVideoIds: string[];

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
  setAutoPlay: (on: boolean) => void;
  setLibraryVideoIds: (ids: string[]) => void;
  syncLibrarySong: (song: Song) => void;
  detachPlaylist: (playlistId: string) => void;
  jumpTo: (index: number) => void;
  reorderQueue: (items: PlaybackItem[]) => void;
  removeFromQueue: (key: string) => void;
  removeSongFromQueue: (songId: string) => void;
  clearQueue: () => void;

  _load: () => Promise<void>;
  _autoTopUp: () => Promise<void>;
  _resolveSrcQuiet: (item: PlaybackItem) => Promise<string>;
  _prefetchNext: (nextIndex: number) => Promise<void>;
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
  autoPlay: false,
  playingPlaylistId: null,
  naturalOrder: null,
  shuffleTick: 0,
  crossfadeArmedFor: null,
  _crossfadeTargetKey: null,
  _playbackCommandId: 0,
  _loadedKey: null,
  _prefetchedFor: null,
  _prefetchInFlight: false,
  _prefetchFailKey: null,
  _prefetchFailUntil: 0,
  _errorRetried: null,
  _consecutiveErrors: 0,
  _autoTopUpInFlight: false,
  _autoSessionId: 0,
  _autoCooldownUntil: 0,
  _recentVideoIds: [],
  _deadSeeds: new Set<string>(),
  _autoRetryTimer: null,
  _libraryVideoIds: [],

  current: () => {
    const { queue, index } = get();
    return index >= 0 && index < queue.length ? queue[index] : null;
  },

  playQueue: async (items, startIndex = 0, playlistId = null) => {
    if (items.length === 0) return;
    const retry = get()._autoRetryTimer;
    if (retry != null) clearTimeout(retry);
    // Plain "Play" always uses the given order — shuffle off.
    set((s) => ({
      queue: items,
      index: Math.max(0, Math.min(startIndex, items.length - 1)),
      shuffle: false,
      naturalOrder: null,
      playingPlaylistId: playlistId,
      _consecutiveErrors: 0,
      _autoSessionId: s._autoSessionId + 1,
      _autoTopUpInFlight: false,
      _autoCooldownUntil: 0,
      _autoRetryTimer: null,
    }));
    await get()._load();
  },

  playShuffled: async (items, playlistId = null) => {
    if (items.length === 0) return;
    const retry = get()._autoRetryTimer;
    if (retry != null) clearTimeout(retry);
    set((s) => ({
      queue: shuffleArray(items),
      index: 0,
      shuffle: true,
      naturalOrder: items.map((it) => it.key),
      playingPlaylistId: playlistId,
      shuffleTick: s.shuffleTick + 1,
      _consecutiveErrors: 0,
      _autoSessionId: s._autoSessionId + 1,
      _autoTopUpInFlight: false,
      _autoCooldownUntil: 0,
      _autoRetryTimer: null,
    }));
    await get()._load();
  },

  playNow: async (item) => {
    const { queue, index } = get();
    const insertAt = index + 1;
    const newQueue = [...queue];
    newQueue.splice(insertAt, 0, item);
    // A deliberate user pick gets a clean slate — it must not inherit the
    // failure count from a prior run of auto-skipped broken tracks.
    set({ queue: newQueue, index: insertAt, _consecutiveErrors: 0 });
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
    const st = get();
    const item = st.current();
    if (!item) return;
    if (st.isPlaying || st.loadingStream) {
      audio.pause();
      set({
        isPlaying: false,
        loadingStream: false,
        _playbackCommandId: st._playbackCommandId + 1,
      });
      return;
    }
    if (st._loadedKey !== item.key) {
      void get()._load();
      return;
    }
    const commandId = st._playbackCommandId + 1;
    set({ isPlaying: true, _playbackCommandId: commandId });
    audio.resume().catch(() => {
      if (get()._playbackCommandId === commandId) set({ isPlaying: false });
    });
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
      } else if (get().autoPlay) {
        // Out of runway under auto-play — fetch more rather than declaring the
        // session over; _autoTopUp resumes playback once it appends something.
        audio.pause();
        set({ isPlaying: false });
        void get()._autoTopUp();
        return;
      } else {
        audio.pause();
        set({ isPlaying: false });
        return;
      }
    }
    // On a straight forward advance (index+1, no wrap/reshuffle) the idle element
    // is already primed with this very track — keep that prime so _load -> playPrimed
    // adopts the warm buffer and starts instantly. Only on a wrap (nextIndex < index,
    // possibly into a freshly reshuffled queue) is the primed track no longer next,
    // so the stale prime must be dropped.
    const wrapped = nextIndex <= index;
    set({ index: nextIndex, _prefetchedFor: null });
    if (wrapped) audio.clearPrime();
    void get()._load();
  },

  prev: () => {
    const { position, index } = get();
    // If a crossfade is overlapping, drop back to the outgoing track first.
    audio.cancelCrossfade();
    set({ crossfadeArmedFor: null, _prefetchedFor: null });
    audio.clearPrime();
    if (position > 3) {
      audio.seek(0);
      set({ position: 0 });
      return;
    }
    if (index > 0) {
      // User-driven navigation gets a clean slate (see playNow).
      set({ index: index - 1, _consecutiveErrors: 0 });
      void get()._load();
    } else {
      audio.seek(0);
      set({ position: 0 });
    }
  },

  seek: (sec) => {
    audio.cancelCrossfade();
    // Seeking changes time-to-end; clear the latch so prefetch can re-arm. Same
    // next track, so the primed buffer stays valid.
    set({ crossfadeArmedFor: null, _prefetchedFor: null });
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
        _prefetchedFor: null,
      }));
      audio.clearPrime();
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
      _prefetchedFor: null,
    }));
    audio.clearPrime();
  },

  cycleRepeat: () => {
    // Repeat and auto-play are mutually exclusive (§2): queue-looping and
    // infinite-extend can't both be on. The UI disables this button while the
    // radio is on, but guard here too so any programmatic caller can't turn
    // repeat on behind auto-play's back (which would also silently kill the
    // _onTime top-up trigger, gated on repeat === "off").
    if (get().autoPlay) return;
    // The repeat mode changes peekNextIndex, so what plays next can differ —
    // clear the prefetch latch and any primed buffer.
    set((s) => ({
      repeat: s.repeat === "off" ? "all" : s.repeat === "all" ? "one" : "off",
      _prefetchedFor: null,
    }));
    audio.clearPrime();
  },

  setCrossfade: (on) => {
    if (!on) {
      audio.cancelCrossfade();
      audio.clearPrime();
      set({
        crossfade: false,
        crossfadeArmedFor: null,
        _crossfadeTargetKey: null,
      });
      return;
    }
    set({ crossfade: true });
  },

  setAutoPlay: (on) => {
    const st = get();
    if (st.autoPlay === on) {
      if (on && st.repeat !== "off") set({ repeat: "off" });
      return;
    }
    const t = st._autoRetryTimer;
    if (t != null) clearTimeout(t);
    // Infinite-extend and queue-looping are mutually exclusive.
    set({
      autoPlay: on,
      ...(on ? { repeat: "off" as const } : {}),
      _autoSessionId: st._autoSessionId + 1,
      _autoTopUpInFlight: false,
      _autoCooldownUntil: 0,
      _autoRetryTimer: null,
    });
    // Top up now, but only if the queue is actually short — _autoTopUp guards
    // itself with the same LOW_WATER runway check used by the _onTime trigger,
    // so flipping the toggle mid-playlist with plenty of songs ahead is a no-op.
    if (on) void get()._autoTopUp();
  },

  setLibraryVideoIds: (ids) => set({ _libraryVideoIds: ids }),

  syncLibrarySong: (song) =>
    set((s) => ({
      queue: s.queue.map((item) =>
        item.songId === song.id
          ? {
              ...item,
              videoId: song.videoId,
              title: song.title,
              artist: song.artist,
              durationSec: song.durationSec,
              thumbnail: song.thumbnail,
              source: { kind: "local" as const, path: song.filePath },
            }
          : item,
      ),
    })),

  detachPlaylist: (playlistId) =>
    set((s) =>
      s.playingPlaylistId === playlistId ? { playingPlaylistId: null } : {},
    ),

  jumpTo: (i) => {
    if (i < 0 || i >= get().queue.length) return;
    // User-driven navigation gets a clean slate (see playNow).
    set({ index: i, _consecutiveErrors: 0, _prefetchedFor: null });
    audio.clearPrime();
    void get()._load();
  },

  reorderQueue: (items) => {
    const cur = get().current();
    const newIndex = cur
      ? items.findIndex((it) => it.key === cur.key)
      : get().index;
    set({ queue: items, index: newIndex, _prefetchedFor: null });
    audio.clearPrime();
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
    if (get()._crossfadeTargetKey === key) {
      audio.cancelCrossfade();
      set({ crossfadeArmedFor: null, _crossfadeTargetKey: null });
    }
    // Removing a queue item can change which track is next — drop the prefetch
    // latch and any primed buffer so the next tick re-arms for the right track.
    set({ _prefetchedFor: null });
    audio.clearPrime();
    if (newQueue.length === 0) {
      get().clearQueue();
      return;
    }
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

  clearQueue: () => {
    // Empty the running queue and stop playback. Modes (shuffle / repeat /
    // auto-play / crossfade) are preferences, so they're left untouched — only
    // the queue contents and the now-playing track go away. With the queue
    // empty, _onTime stops firing and _autoTopUp early-returns, so auto-play
    // can't keep spinning after a clear.
    audio.cancelCrossfade();
    audio.pause();
    audio.clearPrime();
    const t = get()._autoRetryTimer;
    if (t != null) clearTimeout(t);
    set((s) => ({
      queue: [],
      index: -1,
      isPlaying: false,
      loadingStream: false,
      position: 0,
      duration: 0,
      naturalOrder: null,
      playingPlaylistId: null,
      crossfadeArmedFor: null,
      _crossfadeTargetKey: null,
      _playbackCommandId: s._playbackCommandId + 1,
      _loadedKey: null,
      _consecutiveErrors: 0,
      _errorRetried: null,
      _prefetchedFor: null,
      _prefetchFailKey: null,
      _prefetchFailUntil: 0,
      _autoSessionId: s._autoSessionId + 1,
      _autoTopUpInFlight: false,
      _autoCooldownUntil: 0,
      _autoRetryTimer: null,
    }));
  },

  _load: async () => {
    const item = get().current();
    if (!item) return;
    const commandId = get()._playbackCommandId + 1;
    // Selection changes are immediate. The rejected audio must stop before a
    // replacement stream lookup is allowed to wait on the network.
    audio.cancelCrossfade();
    audio.pause();
    set({
      crossfadeArmedFor: null,
      _crossfadeTargetKey: null,
      _playbackCommandId: commandId,
      _loadedKey: null,
      isPlaying: false,
      loadingStream: true,
      position: 0,
      duration: 0,
    });
    const isCurrentCommand = () =>
      get()._playbackCommandId === commandId &&
      get().current()?.key === item.key;
    try {
      const src = await get()._resolveSrcQuiet(item);
      if (!isCurrentCommand()) return;
      audio.setVolume(get().volume);
      // Mark the command as playing before awaiting the browser's play promise.
      // A click during that promise must be interpreted as Pause, not as a
      // request to start a second load of the same item.
      set({ isPlaying: true, loadingStream: false });
      await audio.playPrimed(src);
      if (!isCurrentCommand()) return;
      // NOTE: do NOT reset _consecutiveErrors here. audio.play() resolves when
      // playback merely *starts*; a track that then fails surfaces its failure
      // asynchronously via the element's `error` event. Resetting on start would
      // zero the counter before each failure is counted, so the "whole queue
      // failed" guard in _onPlaybackError could never trip and a playlist of
      // broken tracks would loop error→next→_load→error forever (UI freeze).
      // The counter is cleared only on real progress (see _onTime).
      set({
        isPlaying: true,
        loadingStream: false,
        position: 0,
        _loadedKey: item.key,
      });
    } catch (e) {
      if (!isCurrentCommand()) return;
      set({
        isPlaying: false,
        loadingStream: false,
        _loadedKey: null,
      });
      console.error("playback error", e);
    }
  },

  _autoTopUp: async () => {
    const st = get();
    if (st._autoTopUpInFlight || !st.autoPlay) return;
    // The radio only extends an active session. With nothing playing and an
    // empty queue there is no seed to fetch from, so bail without scheduling a
    // retry — otherwise a persisted autoPlay=true would spin a useless 15s
    // timer loop on an idle home screen before the user has played anything.
    if (st.index < 0 || st.queue.length === 0) return;
    // Only fetch when the unplayed runway is actually short — flipping the
    // toggle (or the end-of-queue park) mid-playlist with plenty of songs
    // ahead must not append a whole batch of streamed radio tracks needlessly.
    const unplayedAhead = st.queue.length - 1 - st.index;
    if (unplayedAhead > AUTO_LOW_WATER) return;
    const sessionId = st._autoSessionId;
    const sessionIsCurrent = () => {
      const current = get();
      return current.autoPlay && current._autoSessionId === sessionId;
    };
    set({ _autoTopUpInFlight: true });
    let appended = 0;
    try {
      // Current track first, then the rest of the playing playlist (so an
      // offline playlist can fall back), then any other queue items. Skip
      // known-dead seeds.
      const seeds = buildSeedPool(get());
      // Remember where the tail was BEFORE appending: if next()'s safety net
      // parked us at end-of-queue (index on the just-finished last track), the
      // first newly-appended item lives at this position. Resuming there avoids
      // replaying the song that just ended.
      const preLen = get().queue.length;

      // Bound the per-tick yt-dlp fan-out. Cached dead-seed skips don't count —
      // they never reach the call — so this only limits real fetches.
      let fetches = 0;
      for (const seed of seeds) {
        if (!sessionIsCurrent()) break;
        if (!seed || get()._deadSeeds.has(seed)) continue;
        if (fetches >= AUTO_MAX_SEEDS) break;

        let results: SearchResult[] = [];
        let fetched = false;
        try {
          results = await api.relatedMix(seed, AUTO_BATCH);
          fetched = true;
          fetches++;
        } catch {
          if (!sessionIsCurrent()) break;
          // Network/throttle/offline blip: the seed is NOT dead, it just can't
          // be reached right now. Leave it eligible and abort this tick so the
          // next trigger retries (a transient outage must not permanently
          // blacklist the current track / playlist as discovery seeds).
          break;
        }
        // The fetch can take a few seconds; if the user switched the radio off
        // while it was in flight, honor that now and don't append a stale batch
        // (spec §8: no appends after the user turns auto-play off).
        if (!sessionIsCurrent()) break;
        if (results.length === 0) {
          // The call SUCCEEDED but the mix is empty: a genuinely dead /
          // region-locked / obscure seed. Mark it (via set(), with a fresh Set)
          // so we skip it next time.
          if (fetched)
            set((s) => ({ _deadSeeds: new Set(s._deadSeeds).add(seed) }));
          continue;
        }

        const fresh = filterCandidates(results, get());
        if (fresh.length === 0) continue;

        const newIds: string[] = [];
        for (const r of fresh) {
          get().addToQueue(resultToStreamItem(r, true));
          newIds.push(r.videoId);
          appended++;
        }
        // Commit the recent-ring additions through set() (trimmed to cap) so
        // the update is a real state replacement, not an in-place push.
        set((s) => ({
          _recentVideoIds: [...s._recentVideoIds, ...newIds].slice(-RECENT_CAP),
        }));
        break; // one good seed per top-up is enough
      }

      if (!sessionIsCurrent()) return;

      // If we parked at end-of-queue (next()'s safety net) and just added
      // songs, resume from the FIRST appended track — not the current index,
      // which still points at the song that just finished.
      //
      // Re-evaluate the parked state AFTER the awaits, never from a snapshot
      // taken before them: a top-up that started from _onTime while the track
      // was still playing would have snapshotted "not parked", yet by the time
      // the slow Mix fetch resolves the queue can have drained and next()'s
      // safety net parked us at the old tail (isPlaying=false, index pointing
      // at the just-finished last track). The guard must reflect that current
      // reality, or the freshly-extended queue would sit paused forever.
      const after = get();
      const parkedAtEnd = !after.isPlaying && after.index === preLen - 1;
      if (
        appended > 0 &&
        parkedAtEnd &&
        preLen < after.queue.length &&
        after.autoPlay
      ) {
        // Resuming for real — drop any pending parked-retry timer.
        if (after._autoRetryTimer != null) {
          clearTimeout(after._autoRetryTimer);
          set({ _autoRetryTimer: null });
        }
        const resumeIndex = Math.min(preLen, after.queue.length - 1);
        // The queue ran completely dry, so the first appended item was never
        // prefetched/primed — resolve + pre-buffer it now, then resume. _load's
        // playPrimed then adopts the warmed element rather than cold-loading, so
        // the post-drain resume closes the buffering gap (the yt-dlp resolve
        // itself is unavoidable here — nothing was playing to hide it behind).
        const resumeItem = after.queue[resumeIndex];
        if (resumeItem) {
          try {
            const src = await get()._resolveSrcQuiet(resumeItem);
            // Still the track we're about to resume? (autoPlay may have flipped
            // off, or the queue changed, during the resolve.)
            const now = get();
            if (
              now.autoPlay &&
              now._autoSessionId === sessionId &&
              now.queue[resumeIndex]?.key === resumeItem.key
            ) {
              audio.prime(src);
            }
          } catch {
            // Resolve failed — fall through to _load, which surfaces the error
            // via the normal cold-load path (and its one-shot retry).
          }
        }
        if (!sessionIsCurrent()) return;
        set({ index: resumeIndex });
        void get()._load();
      } else if (appended === 0 && parkedAtEnd && after.autoPlay) {
        // Parked at end-of-queue but this tick appended nothing (transient
        // empty mix, a throttle that broke out, or everything filtered out).
        // Audio is paused, so no timeupdate will fire to re-run the low-water
        // trigger — the session would end here. Schedule a single delayed
        // retry so a momentary outage doesn't strand a still-on radio.
        if (after._autoRetryTimer != null) clearTimeout(after._autoRetryTimer);
        const timer = setTimeout(() => {
          set({ _autoRetryTimer: null });
          const s = get();
          // Only retry if still parked with the radio on and not already busy.
          if (
            s.autoPlay &&
            s._autoSessionId === sessionId &&
            !s.isPlaying &&
            !s._autoTopUpInFlight
          ) {
            void get()._autoTopUp();
          }
        }, AUTO_RETRY_MS);
        set({ _autoRetryTimer: timer });
      }
    } finally {
      // If this tick appended nothing (empty mix / throttle / everything already
      // queued or filtered), hold the high-frequency low-water trigger off for a
      // cooldown so a converged Mix can't fire a yt-dlp fetch on every timeupdate
      // (§9 request-volume). A successful top-up clears it — the runway is long
      // again anyway, so the trigger won't re-fire until it drains.
      if (get()._autoSessionId === sessionId) {
        set({
          _autoTopUpInFlight: false,
          _autoCooldownUntil: appended > 0 ? 0 : Date.now() + AUTO_RETRY_MS,
        });
      }
    }
  },

  // Resolve a stream URL WITHOUT toggling the loadingStream spinner — used by
  // the background prefetch of a not-yet-current track. Shares the in-place
  // item.source.url cache with the foreground _resolveSrc, so whichever resolves
  // first wins and the other hits the cache.
  _resolveSrcQuiet: async (item) => {
    if (item.source.kind === "local") return fileSrc(item.source.path);
    const source = item.source; // narrowed to the stream variant
    if (source.url) return source.url; // cache hit, no yt-dlp
    // Coalesce with any concurrent resolve of the same item (foreground jump vs.
    // background prefetch) so only one yt-dlp -g runs; the late caller awaits it.
    const pending = inflightResolves.get(item.key);
    if (pending) return pending;
    const p = (async () => {
      const resolved = await api.resolveStream(
        `https://www.youtube.com/watch?v=${source.videoId}`,
      );
      // Re-check the cache: a concurrent caller may have resolved it meanwhile.
      if (source.url) return source.url;
      source.url = resolved;
      return resolved;
    })();
    inflightResolves.set(item.key, p);
    try {
      return await p;
    } finally {
      inflightResolves.delete(item.key);
    }
  },

  _prefetchNext: async (nextIndex) => {
    const st = get();
    if (st._prefetchInFlight) return;
    const item = st.queue[nextIndex];
    if (!item) return;
    // Local items resolve instantly via fileSrc — no yt-dlp, no point.
    if (item.source.kind === "local") {
      set({ _prefetchedFor: item.key });
      audio.prime(fileSrc(item.source.path)); // still pre-buffer the file
      return;
    }
    // Already resolved? Just prime the buffer, mark done, no yt-dlp.
    if (item.source.url) {
      set({ _prefetchedFor: item.key });
      audio.prime(item.source.url);
      return;
    }
    set({ _prefetchInFlight: true, _prefetchedFor: item.key });
    try {
      const src = await get()._resolveSrcQuiet(item);
      // Re-validate: the predicted next track may have changed while resolving
      // (user jump/seek/reorder, repeat-all reshuffle). Only prime if `item` is
      // STILL the next track. Mirror _startCrossfade's post-await guard.
      const cur = get();
      const stillNext =
        cur.queue[
          peekNextIndex(cur.index, cur.queue.length, cur.repeat) ?? -1
        ];
      if (stillNext && stillNext.key === item.key) {
        audio.prime(src);
      }
      // Resolved cleanly — drop any earlier fail backoff recorded for this key.
      set((s) =>
        s._prefetchFailKey === item.key
          ? { _prefetchFailKey: null, _prefetchFailUntil: 0 }
          : {},
      );
      // If not still next, the resolved URL is harmlessly cached on the item;
      // leave _prefetchedFor as-is so _onTime re-arms for the real next track.
    } catch {
      // Resolve failed (network/throttle / YouTube bot-check). Clear the marker
      // so a later tick CAN retry, but record a short per-target backoff so
      // _onTime (~4×/sec) doesn't re-spawn yt-dlp -g on the very next tick and
      // turn a dead next track into a rapid-fire subprocess loop. Do NOT touch
      // _errorRetried (that one-shot belongs to playback).
      set((s) => ({
        ...(s._prefetchedFor === item.key ? { _prefetchedFor: null } : {}),
        _prefetchFailKey: item.key,
        _prefetchFailUntil: Date.now() + PREFETCH_FAIL_COOLDOWN_MS,
      }));
    } finally {
      set({ _prefetchInFlight: false });
    }
  },

  _onTime: (cur, dur) => {
    if (!get().current()) {
      if (get().position !== 0 || get().duration !== 0)
        set({ position: 0, duration: 0 });
      return;
    }
    set({ position: cur || 0, duration: dur || 0 });
    const st = get();
    // A track that produces real playback time has demonstrably loaded, so the
    // run of consecutive load failures is over. (A broken track never advances
    // past 0, so this never masks a genuine all-failing-queue stop.) Also clear
    // the one-shot stream-retry marker, so a track that recovers earns a fresh
    // retry the next time its URL goes stale (e.g. on a repeat-all second lap).
    if (cur > 1 && (st._consecutiveErrors !== 0 || st._errorRetried !== null))
      set({ _consecutiveErrors: 0, _errorRetried: null });
    // Look ahead: when auto-play is on and the unplayed runway runs low, stream
    // in more similar songs before the (optional) crossfade window arms.
    if (st.autoPlay && st.repeat === "off") {
      const unplayedAhead = st.queue.length - 1 - st.index;
      if (
        unplayedAhead <= AUTO_LOW_WATER &&
        !st._autoTopUpInFlight &&
        Date.now() >= st._autoCooldownUntil
      ) {
        void get()._autoTopUp();
      }
    }
    // Pre-resolve + pre-buffer the upcoming track well before it's needed, so a
    // streamed advance starts instantly and a crossfade fades into a warm track.
    if (isFinite(dur) && dur > 0 && st.repeat !== "one") {
      const nextIndex = peekNextIndex(st.index, st.queue.length, st.repeat);
      if (
        nextIndex !== null &&
        nextIndex !== st.index && // not same-track (repeat-all 1 song)
        // Only prefetch a STABLE in-bounds next item. At a repeat-all wrap the
        // queue is reshuffled at advance time (next()), so index 0 is not yet
        // known — skip wrap targets (nextIndex < index means wrap).
        nextIndex > st.index &&
        dur - cur <= PREFETCH_LEAD_SEC
      ) {
        const target = st.queue[nextIndex];
        // Hold off if this exact target just failed to resolve and its backoff
        // window hasn't elapsed — otherwise a dead next track re-spawns yt-dlp -g
        // on every ~250ms tick across the whole lead window.
        const backedOff =
          target != null &&
          st._prefetchFailKey === target.key &&
          Date.now() < st._prefetchFailUntil;
        if (
          target &&
          st._prefetchedFor !== target.key &&
          !st._prefetchInFlight &&
          !backedOff
        ) {
          void get()._prefetchNext(nextIndex);
        }
      }
    }
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
    const commandId = get()._playbackCommandId;
    const item = get().queue[nextIndex];
    // Only clear our own arm — playback may have moved on and re-armed since.
    const disarm = () =>
      set((s) => ({
        ...(s.crossfadeArmedFor === startIndex
          ? { crossfadeArmedFor: null }
          : {}),
        ...(s._crossfadeTargetKey === item?.key
          ? { _crossfadeTargetKey: null }
          : {}),
      }));
    if (!item) {
      disarm();
      return;
    }
    let src: string;
    try {
      src = await get()._resolveSrcQuiet(item);
    } catch {
      disarm();
      return;
    }
    // Resolving a stream URL can take a moment; bail if playback moved on,
    // the user seeked back out of the fade window (which disarms), or
    // crossfade was switched off in the meantime.
    const beforeFade = get();
    const currentNextIndex = peekNextIndex(
      beforeFade.index,
      beforeFade.queue.length,
      beforeFade.repeat,
    );
    if (
      beforeFade.index !== startIndex ||
      beforeFade._playbackCommandId !== commandId ||
      beforeFade.crossfadeArmedFor !== startIndex ||
      !beforeFade.crossfade ||
      beforeFade.queue[currentNextIndex ?? -1]?.key !== item.key
    ) {
      disarm();
      return;
    }
    set({ _crossfadeTargetKey: item.key });
    const started = await audio.crossfadeTo(src, CROSSFADE_SEC * 1000, () => {
      // Overlap finished: the next track is already playing — adopt it where
      // it now sits (queue edits during the fade may have moved or removed it).
      const q = get().queue;
      const idx = q.findIndex((it) => it.key === item.key);
      if (idx >= 0) {
        set({
          index: idx,
          crossfadeArmedFor: null,
          _crossfadeTargetKey: null,
          _loadedKey: item.key,
          _consecutiveErrors: 0,
        });
      } else if (q.length > 0) {
        set({
          index: Math.min(nextIndex, q.length - 1),
          crossfadeArmedFor: null,
          _crossfadeTargetKey: null,
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
          _crossfadeTargetKey: null,
          _loadedKey: null,
        });
      }
    });
    if (!started) {
      disarm();
      return;
    }
    const now = get();
    if (
      now._crossfadeTargetKey !== item.key ||
      now.index !== startIndex ||
      now._playbackCommandId !== commandId ||
      !now.crossfade
    ) {
      audio.cancelCrossfade();
      disarm();
    }
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
      set({ _errorRetried: item.key, _prefetchedFor: null });
      item.source.url = "";
      audio.clearPrime();
      void st._load();
      return;
    }
    // Skip the broken track, but stop once a whole queue's worth of tracks has
    // failed in a row — otherwise repeat-all would hammer dead sources forever.
    const failures = st._consecutiveErrors + 1;
    set({ _consecutiveErrors: failures });
    // Under repeat-one, next() would reload the SAME failing track forever, so
    // a broken track must stop playback rather than loop on itself.
    if (failures >= st.queue.length || st.repeat === "one") {
      audio.pause();
      set({
        isPlaying: false,
        loadingStream: false,
        _loadedKey: null,
        _playbackCommandId: st._playbackCommandId + 1,
      });
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
