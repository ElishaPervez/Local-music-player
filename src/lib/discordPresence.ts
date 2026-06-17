import { api, type DiscordPresence } from "./api";
import { useLibraryStore } from "../stores/libraryStore";
import { usePlayerStore } from "../stores/playerStore";

/**
 * Bridges the player state to Discord Rich Presence (handled in Rust).
 *
 * Discord rate-limits activity updates, so we never push on every per-second
 * position tick — the live progress bar is driven by start/end timestamps, not
 * polling. We only push when something meaningful changes (track, play/pause,
 * repeat, shuffle, playlist) or the user seeks, and throttle to one push per
 * `MIN_INTERVAL_MS` with a trailing flush.
 */
const MIN_INTERVAL_MS = 2000;
/** A position jump larger than this (vs. where the bar should be) is a seek. */
const SEEK_EPSILON_SEC = 3;

let inited = false;
let lastSig = "";
let lastSentAt = 0;
let lastSentPos = 0;
let lastSentPlaying = false;
let timer: ReturnType<typeof setTimeout> | null = null;

function build(): DiscordPresence | null {
  const player = usePlayerStore.getState();
  const lib = useLibraryStore.getState();
  if (!lib.settings.discordPresence) return null;
  const cur = player.current();
  if (!cur) return null;
  const playlistName = player.playingPlaylistId
    ? (lib.playlists.find((p) => p.id === player.playingPlaylistId)?.name ??
      null)
    : null;
  return {
    title: cur.title || "Unknown track",
    artist: cur.artist || "",
    durationSec: player.duration || cur.durationSec || 0,
    positionSec: player.position || 0,
    isPlaying: player.isPlaying,
    repeat: player.repeat,
    shuffle: player.shuffle,
    playlistName,
  };
}

/** Everything that should trigger a re-push — deliberately excludes position. */
function sigOf(p: DiscordPresence | null): string {
  if (!p) return "none";
  return [
    p.title,
    p.artist,
    p.isPlaying,
    p.repeat,
    p.shuffle,
    p.playlistName ?? "",
    Math.round(p.durationSec),
  ].join("|");
}

function flush() {
  timer = null;
  const p = build();
  lastSentAt = Date.now();
  lastSig = sigOf(p);
  if (!p) {
    lastSentPlaying = false;
    void api.discordClear().catch(() => {});
    return;
  }
  lastSentPos = p.positionSec;
  lastSentPlaying = p.isPlaying;
  void api.discordSetPresence(p).catch(() => {});
}

function schedule() {
  if (timer) return;
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastSentAt));
  timer = setTimeout(flush, wait);
}

function onChange() {
  const p = build();
  let changed = sigOf(p) !== lastSig;
  if (!changed && p && p.isPlaying && lastSentPlaying) {
    // The progress bar advances on its own from the timestamps, so normal
    // playback drift must NOT re-push. A seek moves position off the expected
    // line — only then do we resend to realign the bar.
    const expected = lastSentPos + (Date.now() - lastSentAt) / 1000;
    if (Math.abs(p.positionSec - expected) > SEEK_EPSILON_SEC) changed = true;
  }
  if (changed) schedule();
}

/** Wire the player/library stores to Discord. Safe to call more than once. */
export function initDiscordPresence() {
  if (inited) return;
  inited = true;
  usePlayerStore.subscribe(onChange);
  useLibraryStore.subscribe(onChange);
  onChange();
}
