import { after, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

class FakeAudio {
  static instances = [];
  static nextPlayPromise = null;

  constructor() {
    this.preload = "";
    this.src = "";
    this.currentTime = 0;
    this.duration = 0;
    this.volume = 1;
    this.paused = true;
    this.ended = false;
    this.error = null;
    this.listeners = new Map();
    FakeAudio.instances.push(this);
  }

  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }

  load() {}

  play() {
    this.paused = false;
    const pending = FakeAudio.nextPlayPromise;
    FakeAudio.nextPlayPromise = null;
    return pending ?? Promise.resolve();
  }

  pause() {
    this.paused = true;
  }

  reset() {
    this.src = "";
    this.currentTime = 0;
    this.duration = 0;
    this.volume = 1;
    this.paused = true;
    this.ended = false;
    this.error = null;
  }
}

globalThis.Audio = FakeAudio;
globalThis.window = {
  setInterval: globalThis.setInterval,
  clearInterval: globalThis.clearInterval,
};

const vite = await createServer({
  configFile: false,
  root: process.cwd(),
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true, hmr: { port: 24679 } },
});

const playerModule = await vite.ssrLoadModule("/src/stores/playerStore.ts");
const audioModule = await vite.ssrLoadModule("/src/lib/audio.ts");
const apiModule = await vite.ssrLoadModule("/src/lib/api.ts");
const libraryModule = await vite.ssrLoadModule("/src/stores/libraryStore.ts");

const { usePlayerStore, initPlayer } = playerModule;
const { audio } = audioModule;
const { api } = apiModule;
const { useLibraryStore } = libraryModule;
const initialState = usePlayerStore.getInitialState();
const initialLibraryState = useLibraryStore.getInitialState();

initPlayer();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function stream(id, url = "") {
  return {
    key: `key-${id}`,
    videoId: id,
    title: `Song ${id}`,
    artist: `Artist ${id}`,
    durationSec: 180,
    thumbnail: null,
    source: { kind: "stream", videoId: id, url },
  };
}

function searchResult(id) {
  return {
    videoId: id,
    title: `Song ${id}`,
    artist: `Artist ${id}`,
    durationSec: 180,
    thumbnail: null,
    url: `https://www.youtube.com/watch?v=${id}`,
  };
}

function librarySong(id, title = `Song ${id}`) {
  return {
    id,
    videoId: id,
    title,
    artist: `Artist ${id}`,
    durationSec: 180,
    url: `https://www.youtube.com/watch?v=${id}`,
    thumbnail: null,
    filePath: `C:\\Music\\${id}.m4a`,
    addedAt: 1,
  };
}

function queuedLibrarySong(id, title = `Song ${id}`) {
  return {
    ...stream(id, `local:${id}`),
    songId: id,
    title,
    source: { kind: "local", path: `C:\\Music\\${id}.m4a` },
  };
}

function playingSources() {
  return FakeAudio.instances.filter((el) => !el.paused).map((el) => el.src);
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  audio.cancelCrossfade();
  audio.pause();
  audio.clearPrime();
  for (const el of FakeAudio.instances) el.reset();
  FakeAudio.nextPlayPromise = null;
  usePlayerStore.setState(
    {
      ...initialState,
      _deadSeeds: new Set(),
      _recentVideoIds: [],
      _libraryVideoIds: [],
      _autoRetryTimer: null,
    },
    true,
  );
  useLibraryStore.setState(
    {
      ...initialLibraryState,
      songs: {},
      playlists: [],
      loaded: false,
    },
    true,
  );
  api.resolveStream = async (url) => `resolved:${url}`;
  api.relatedMix = async () => [];
});

after(async () => {
  audio.cancelCrossfade();
  audio.pause();
  await vite.close();
});

test("removing the audible item stops it before a slow replacement resolves", async () => {
  const a = stream("remove-current", "src:remove-current");
  const b = stream("remove-next");
  await usePlayerStore.getState().playQueue([a, b]);
  assert.deepEqual(playingSources(), ["src:remove-current"]);

  const replacement = deferred();
  api.resolveStream = () => replacement.promise;
  usePlayerStore.getState().removeFromQueue(a.key);

  const sourcesBeforeReplacement = playingSources();
  const playingBeforeReplacement = usePlayerStore.getState().isPlaying;
  replacement.resolve("src:remove-next");
  await flush();

  assert.deepEqual(sourcesBeforeReplacement, []);
  assert.equal(playingBeforeReplacement, false);
});

test("clearing the queue prevents an in-flight song load from starting later", async () => {
  const pending = deferred();
  api.resolveStream = () => pending.promise;

  const load = usePlayerStore.getState().playQueue([stream("late")]);
  usePlayerStore.getState().clearQueue();
  pending.resolve("src:late");
  await load;
  await flush();

  assert.equal(usePlayerStore.getState().queue.length, 0);
  assert.equal(usePlayerStore.getState().isPlaying, false);
  assert.deepEqual(playingSources(), []);
});

test("the latest selection stays audible when an older stream resolves last", async () => {
  const a = deferred();
  const b = deferred();
  api.resolveStream = (url) =>
    url.includes("watch?v=race-a") ? a.promise : b.promise;

  const loadA = usePlayerStore.getState().playQueue([stream("race-a")]);
  const loadB = usePlayerStore.getState().playQueue([stream("race-b")]);
  b.resolve("src:race-b");
  await loadB;
  a.resolve("src:race-a");
  await loadA;
  await flush();

  assert.equal(usePlayerStore.getState().current()?.key, "key-race-b");
  assert.deepEqual(playingSources(), ["src:race-b"]);
});

test("clearing the queue prevents an in-flight auto-play result from refilling it", async () => {
  const mix = deferred();
  api.relatedMix = () => mix.promise;
  usePlayerStore.setState({
    queue: [stream("seed", "src:seed")],
    index: 0,
    isPlaying: true,
    autoPlay: true,
  });

  const topUp = usePlayerStore.getState()._autoTopUp();
  await flush();
  usePlayerStore.getState().clearQueue();
  mix.resolve([searchResult("suggested")]);
  await topUp;
  await flush();

  assert.equal(usePlayerStore.getState().queue.length, 0);
  assert.equal(usePlayerStore.getState().index, -1);
  assert.deepEqual(playingSources(), []);
});

test("a fast Play then Pause ends paused", async () => {
  await usePlayerStore.getState().playQueue([stream("a", "src:a")]);
  usePlayerStore.getState().togglePlay();
  assert.equal(usePlayerStore.getState().isPlaying, false);

  usePlayerStore.getState().togglePlay();
  usePlayerStore.getState().togglePlay();
  await flush();

  assert.equal(usePlayerStore.getState().isPlaying, false);
  assert.deepEqual(playingSources(), []);
});

test("pausing while the browser confirms playback does not restart the song", async () => {
  const starting = deferred();
  FakeAudio.nextPlayPromise = starting.promise;

  const load = usePlayerStore
    .getState()
    .playQueue([stream("pending-play", "src:pending-play")]);
  usePlayerStore.getState().togglePlay();
  starting.resolve();
  await load;
  await flush();

  assert.equal(usePlayerStore.getState().isPlaying, false);
  assert.deepEqual(playingSources(), []);
});

test("selecting a new song clears the previous song timeline while it loads", async () => {
  await usePlayerStore.getState().playQueue([stream("a", "src:a")]);
  usePlayerStore.getState()._onTime(47, 212);
  const pending = deferred();
  api.resolveStream = () => pending.promise;

  const load = usePlayerStore.getState().playQueue([stream("b")]);

  assert.equal(usePlayerStore.getState().position, 0);
  assert.equal(usePlayerStore.getState().duration, 0);
  assert.equal(usePlayerStore.getState().isPlaying, false);
  pending.resolve("src:b");
  await load;
});

test("playing once leaves the queue unchanged and resumes the same timestamp", async () => {
  const a = stream("queue-a", "src:queue-a");
  const b = stream("queue-b", "src:queue-b");
  const temporary = stream("temporary", "src:temporary");
  await usePlayerStore.getState().playQueue([a, b]);
  usePlayerStore.getState()._onTime(47, 180);
  const originalKeys = usePlayerStore.getState().queue.map((item) => item.key);

  await usePlayerStore.getState().playOnce(temporary);

  assert.deepEqual(
    usePlayerStore.getState().queue.map((item) => item.key),
    originalKeys,
  );
  assert.equal(usePlayerStore.getState().current()?.key, temporary.key);
  assert.deepEqual(playingSources(), ["src:temporary"]);

  await usePlayerStore.getState()._finishPlayOnce();

  assert.deepEqual(
    usePlayerStore.getState().queue.map((item) => item.key),
    originalKeys,
  );
  assert.equal(usePlayerStore.getState().current()?.key, a.key);
  assert.equal(usePlayerStore.getState().position, 47);
  assert.deepEqual(playingSources(), ["src:queue-a"]);
});

test("playing once returns a paused queue to paused at the saved timestamp", async () => {
  const queued = stream("paused-queue", "src:paused-queue");
  const temporary = stream("paused-temporary", "src:paused-temporary");
  await usePlayerStore.getState().playQueue([queued]);
  usePlayerStore.getState()._onTime(32, 180);
  usePlayerStore.getState().togglePlay();

  await usePlayerStore.getState().playOnce(temporary);
  await usePlayerStore.getState()._finishPlayOnce();

  assert.equal(usePlayerStore.getState().current()?.key, queued.key);
  assert.equal(usePlayerStore.getState().position, 32);
  assert.equal(usePlayerStore.getState().isPlaying, false);
  assert.deepEqual(playingSources(), []);

  usePlayerStore.getState().togglePlay();
  await flush();
  assert.equal(usePlayerStore.getState().position, 32);
  assert.deepEqual(playingSources(), ["src:paused-queue"]);
});

test("after returning from a play-once song, Next starts the next song from 0:00", async () => {
  const a = stream("resume-a", "src:resume-a");
  const b = stream("resume-b", "src:resume-b");
  await usePlayerStore.getState().playQueue([a, b]);
  usePlayerStore.getState()._onTime(150, 180);
  usePlayerStore.getState().togglePlay();
  await usePlayerStore.getState().playOnce(stream("resume-once", "src:resume-once"));
  await usePlayerStore.getState()._finishPlayOnce();

  usePlayerStore.getState().next();
  await flush();

  assert.equal(usePlayerStore.getState().current()?.key, b.key);
  assert.equal(usePlayerStore.getState().position, 0);
  const el = FakeAudio.instances.find((x) => x.src === "src:resume-b");
  assert.equal(el.currentTime, 0);
});

test("Play now in a shuffled playlist keeps its place when shuffle is turned off", async () => {
  const songs = ["sh-a", "sh-b", "sh-c", "sh-d"].map((id) => stream(id, `src:${id}`));
  await usePlayerStore.getState().playShuffled(songs);
  const playingKey = usePlayerStore.getState().current().key;
  const picked = stream("sh-picked", "src:sh-picked");
  await usePlayerStore.getState().playNow(picked);

  usePlayerStore.getState().toggleShuffle();

  const expected = songs.map((s) => s.key);
  expected.splice(expected.indexOf(playingKey) + 1, 0, picked.key);
  assert.deepEqual(
    usePlayerStore.getState().queue.map((s) => s.key),
    expected,
  );
  assert.equal(usePlayerStore.getState().current()?.key, picked.key);
});

test("a stream that errors mid-song reloads at the same position", async () => {
  const a = stream("midsong", "src:midsong-old");
  await usePlayerStore.getState().playQueue([a, stream("midsong-next")]);
  usePlayerStore.getState()._onTime(90, 180);

  audio.onError(new Error("network"));
  await flush();
  await flush();

  const src = "resolved:https://www.youtube.com/watch?v=midsong";
  assert.equal(usePlayerStore.getState().current()?.key, a.key);
  assert.deepEqual(playingSources(), [src]);
  assert.equal(usePlayerStore.getState().position, 90);
  assert.equal(FakeAudio.instances.find((x) => x.src === src).currentTime, 90);

  // Jumping back to 90s is not proof the stream recovered: a second error
  // before any real playback must not trigger another endless reload.
  usePlayerStore.getState()._onTime(90, 180);
  assert.equal(usePlayerStore.getState()._errorRetried, a.key);
});

test("a stream stuck waiting for data is reloaded from where it stopped", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const a = stream("stalled", "src:stalled-old");
  await usePlayerStore.getState().playQueue([a, stream("stalled-next")]);
  usePlayerStore.getState()._onTime(30, 180);
  const el = FakeAudio.instances.find((x) => x.src === "src:stalled-old");
  el.currentTime = 30;

  for (const listener of el.listeners.get("waiting")) listener();
  t.mock.timers.tick(15000);
  await flush();
  await flush();

  const src = "resolved:https://www.youtube.com/watch?v=stalled";
  assert.deepEqual(playingSources(), [src]);
  assert.equal(usePlayerStore.getState().position, 30);
});

test("removing the incoming crossfade item silences it immediately", async () => {
  const a = stream("a", "src:a");
  const b = stream("b", "src:b");
  await usePlayerStore.getState().playQueue([a, b]);
  usePlayerStore.setState({ crossfade: true, crossfadeArmedFor: 0 });
  await usePlayerStore.getState()._startCrossfade(1);
  await flush();
  assert.equal(playingSources().length, 2);

  usePlayerStore.getState().removeFromQueue(b.key);

  assert.deepEqual(playingSources(), ["src:a"]);
});

test("switching crossfade off cancels an overlap already in progress", async () => {
  const a = stream("a", "src:a");
  const b = stream("b", "src:b");
  await usePlayerStore.getState().playQueue([a, b]);
  usePlayerStore.setState({ crossfade: true, crossfadeArmedFor: 0 });
  await usePlayerStore.getState()._startCrossfade(1);
  await flush();
  assert.equal(playingSources().length, 2);

  usePlayerStore.getState().setCrossfade(false);

  assert.deepEqual(playingSources(), ["src:a"]);
});

test("removing a crossfade target while it resolves prevents the overlap", async () => {
  const a = stream("fade-source", "src:fade-source");
  const b = stream("fade-pending");
  await usePlayerStore.getState().playQueue([a, b]);
  usePlayerStore.setState({ crossfade: true, crossfadeArmedFor: 0 });
  const pending = deferred();
  api.resolveStream = () => pending.promise;

  const fade = usePlayerStore.getState()._startCrossfade(1);
  usePlayerStore.getState().removeFromQueue(b.key);
  pending.resolve("src:fade-pending");
  await fade;
  await flush();

  assert.deepEqual(playingSources(), ["src:fade-source"]);
});

test("pausing while a crossfade target resolves prevents it from starting", async () => {
  const a = stream("fade-pause-source", "src:fade-pause-source");
  const b = stream("fade-pause-pending");
  await usePlayerStore.getState().playQueue([a, b]);
  usePlayerStore.setState({ crossfade: true, crossfadeArmedFor: 0 });
  const pending = deferred();
  api.resolveStream = () => pending.promise;

  const fade = usePlayerStore.getState()._startCrossfade(1);
  usePlayerStore.getState().togglePlay();
  pending.resolve("src:fade-pause-pending");
  await fade;
  await flush();

  assert.equal(usePlayerStore.getState().isPlaying, false);
  assert.deepEqual(playingSources(), []);
});

test("a crossfade that fails after the old song ended still moves on", async () => {
  const a = stream("fade-end-a", "src:fade-end-a");
  const b = stream("fade-end-b", "src:fade-end-b");
  await usePlayerStore.getState().playQueue([a, b]);
  usePlayerStore.setState({ crossfade: true, crossfadeArmedFor: 0 });
  const starting = deferred();
  FakeAudio.nextPlayPromise = starting.promise;

  const fade = usePlayerStore.getState()._startCrossfade(1);
  await flush();
  // The old song runs out while the next one is still trying to start...
  const outgoing = FakeAudio.instances.find((el) => el.src === "src:fade-end-a");
  outgoing.ended = true;
  outgoing.paused = true;
  // ...and then the next one fails to start.
  starting.reject(new Error("network"));
  await fade;
  await flush();

  assert.equal(usePlayerStore.getState().current()?.key, b.key);
  assert.equal(usePlayerStore.getState().isPlaying, true);
  assert.deepEqual(playingSources(), ["src:fade-end-b"]);
});

test("with Repeat One, Next skips but a song ending on its own replays", async () => {
  const a = stream("repeat-a", "src:repeat-a");
  const b = stream("repeat-b", "src:repeat-b");
  await usePlayerStore.getState().playQueue([a, b]);
  usePlayerStore.setState({ repeat: "one" });

  audio.onEnded();
  await flush();
  assert.equal(usePlayerStore.getState().current()?.key, a.key);
  assert.deepEqual(playingSources(), ["src:repeat-a"]);

  usePlayerStore.getState().next();
  await flush();
  assert.equal(usePlayerStore.getState().current()?.key, b.key);
  assert.deepEqual(playingSources(), ["src:repeat-b"]);
});

test("renaming a library song updates its live queue and now-playing copy", () => {
  const song = librarySong("rename", "Old title");
  const item = queuedLibrarySong("rename", "Old title");
  useLibraryStore.setState({ songs: { [song.id]: song } });
  usePlayerStore.setState({
    queue: [item],
    index: 0,
    isPlaying: true,
    _loadedKey: item.key,
  });

  useLibraryStore.getState().updateSong(song.id, { title: "New title" });

  assert.equal(usePlayerStore.getState().current()?.title, "New title");
  assert.equal(usePlayerStore.getState().isPlaying, true);
});

test("a rejected stream shows the concrete playback error", async () => {
  api.resolveStream = async () => {
    throw "YouTube requires sign-in verification. Import cookies from the title bar.";
  };

  await usePlayerStore.getState().playQueue([stream("cookie-error")]);

  assert.equal(usePlayerStore.getState().isPlaying, false);
  assert.equal(usePlayerStore.getState().loadingStream, false);
  assert.match(usePlayerStore.getState().playbackError, /requires sign-in/i);
});

test("a successful retry clears the previous playback error", async () => {
  let attempts = 0;
  api.resolveStream = async () => {
    attempts += 1;
    // Both attempts of the first load fail, so the error reaches the screen.
    if (attempts <= 2) throw "Saved cookies expired.";
    return "src:cookie-retry";
  };
  const item = stream("cookie-retry");

  await usePlayerStore.getState().playQueue([item]);
  assert.match(usePlayerStore.getState().playbackError, /expired/i);

  await usePlayerStore.getState()._load();
  usePlayerStore.getState()._onTime(2, 180);

  assert.equal(usePlayerStore.getState().playbackError, null);
  assert.deepEqual(playingSources(), ["src:cookie-retry"]);
});

test("a failed background prefetch does not poison the song's real load", async () => {
  const first = deferred();
  let calls = 0;
  api.resolveStream = async () => {
    calls += 1;
    if (calls === 1) return first.promise;
    return "src:fresh";
  };
  const item = stream("shared-failure");

  // The background prefetch starts first; the real load joins while it's still
  // in flight and must NOT simply inherit its failure.
  const background = usePlayerStore.getState()._resolveSrcQuiet(item);
  const foreground = usePlayerStore.getState()._resolveSrcQuiet(item);
  background.catch(() => {}); // failing on purpose; keep the runner quiet

  first.reject("Throttled by YouTube.");

  await assert.rejects(background);
  assert.equal(await foreground, "src:fresh");
  assert.equal(calls, 2, "the real load must make its own request");
});

test("a song whose stream lookup keeps failing hands off to the next song", async () => {
  api.resolveStream = async (url) => {
    if (url.includes("dead-song")) throw "Stream unavailable.";
    return "src:live-song";
  };

  await usePlayerStore.getState().playQueue([stream("dead-song"), stream("live-song")]);
  await flush();
  await flush();

  assert.equal(usePlayerStore.getState().current()?.key, "key-live-song");
  assert.deepEqual(playingSources(), ["src:live-song"]);
});

test("a queue where every stream lookup fails stops instead of looping", async () => {
  let calls = 0;
  api.resolveStream = async () => {
    calls += 1;
    throw "Stream unavailable.";
  };

  await usePlayerStore
    .getState()
    .playQueue([stream("dead-1"), stream("dead-2")]);
  await flush();
  await flush();

  assert.equal(usePlayerStore.getState().isPlaying, false);
  assert.match(usePlayerStore.getState().playbackError, /unavailable/i);
  assert.deepEqual(playingSources(), []);
  // 2 attempts on the first track (one retry), then 1 each as it walks the
  // rest — bounded, not an endless error→next→error spin.
  assert.ok(calls <= 4, `bounded attempt count, got ${calls}`);
});

test("the radio resumes after a slow search even if the queue changed meanwhile", async () => {
  const mix = deferred();
  api.relatedMix = () => mix.promise;
  api.resolveStream = async () => "src:radio-c";
  const a = stream("radio-a", "src:radio-a");
  const b = stream("radio-b", "src:radio-b");
  usePlayerStore.setState({
    queue: [a, b],
    index: 1,
    isPlaying: true,
    autoPlay: true,
  });

  // Last song ends with nothing left: playback parks and the search starts.
  usePlayerStore.getState().next();
  await flush();
  assert.equal(usePlayerStore.getState().isPlaying, false);

  // The queue changes length while the search is still running.
  usePlayerStore.getState().removeFromQueue(a.key);
  mix.resolve([searchResult("radio-c")]);
  await flush();
  await flush();
  await flush();

  assert.equal(usePlayerStore.getState().current()?.videoId, "radio-c");
  assert.equal(usePlayerStore.getState().isPlaying, true);
  assert.deepEqual(playingSources(), ["src:radio-c"]);
});

test("a fruitless radio search still schedules a retry after the queue changed", async () => {
  const mix = deferred();
  api.relatedMix = () => mix.promise;
  const a = stream("dry-a", "src:dry-a");
  const b = stream("dry-b", "src:dry-b");
  usePlayerStore.setState({
    queue: [a, b],
    index: 1,
    isPlaying: true,
    autoPlay: true,
  });

  usePlayerStore.getState().next();
  await flush();
  usePlayerStore.getState().removeFromQueue(a.key);
  mix.resolve([]); // empty mix — nothing to append
  await flush();
  await flush();

  const timer = usePlayerStore.getState()._autoRetryTimer;
  assert.notEqual(timer, null, "a stranded radio must schedule another attempt");
  clearTimeout(timer);
  usePlayerStore.setState({ _autoRetryTimer: null });
});

test("a user pause is never mistaken for the radio running dry", async () => {
  api.relatedMix = async () => [searchResult("unwanted")];
  const a = stream("pause-a", "src:pause-a");
  const b = stream("pause-b", "src:pause-b");
  await usePlayerStore.getState().playQueue([a, b]);
  usePlayerStore.setState({ autoPlay: true });
  usePlayerStore.getState().togglePlay(); // user pauses on the first track
  assert.equal(usePlayerStore.getState().isPlaying, false);

  await usePlayerStore.getState()._autoTopUp();
  await flush();

  // Songs may be appended, but a paused player must stay paused and stay put.
  assert.equal(usePlayerStore.getState().isPlaying, false);
  assert.equal(usePlayerStore.getState().index, 0);
  assert.deepEqual(playingSources(), []);
});

test("deleting the source playlist detaches the live queue without stopping it", () => {
  const playlist = {
    id: "playlist-delete",
    name: "Temporary",
    songIds: ["keep-playing"],
    createdAt: 1,
  };
  const item = queuedLibrarySong("keep-playing");
  useLibraryStore.setState({ playlists: [playlist] });
  usePlayerStore.setState({
    queue: [item],
    index: 0,
    isPlaying: true,
    playingPlaylistId: playlist.id,
    _loadedKey: item.key,
  });

  useLibraryStore.getState().deletePlaylist(playlist.id);

  assert.equal(usePlayerStore.getState().playingPlaylistId, null);
  assert.equal(usePlayerStore.getState().queue.length, 1);
  assert.equal(usePlayerStore.getState().isPlaying, true);
});

test("cached stream URLs are re-resolved once their embedded expiry passes", async () => {
  const { streamUrlIsFresh } = playerModule;
  const now = 1_800_000_000_000; // fixed clock (ms)
  const nowSec = now / 1000;

  // Fresh: deadline comfortably ahead of the re-resolve margin.
  assert.equal(
    streamUrlIsFresh(
      `https://rr3.googlevideo.com/videoplayback?expire=${nowSec + 3600}&id=x`,
      now,
    ),
    true,
  );
  // Stale: deadline passed.
  assert.equal(
    streamUrlIsFresh(
      `https://rr3.googlevideo.com/videoplayback?expire=${nowSec - 10}&id=x`,
      now,
    ),
    false,
  );
  // Inside the safety margin counts as stale (would die mid-playback).
  assert.equal(
    streamUrlIsFresh(
      `https://rr3.googlevideo.com/videoplayback?expire=${nowSec + 60}&id=x`,
      now,
    ),
    false,
  );
  // Path-style stamp is also recognized.
  assert.equal(
    streamUrlIsFresh(
      `https://rr3.googlevideo.com/videoplayback/expire/${Math.floor(nowSec - 10)}/id/x`,
      now,
    ),
    false,
  );
  // No stamp / unparseable → assume usable, let error-retry handle it.
  assert.equal(streamUrlIsFresh("https://example.com/audio.m4a", now), true);
  assert.equal(streamUrlIsFresh("not a url", now), true);

  // End-to-end: a queue item whose cached URL is expired gets a fresh resolve
  // instead of being handed to the audio element.
  let resolves = 0;
  api.resolveStream = async () => {
    resolves += 1;
    return "src:refreshed";
  };
  const item = stream("expired-cache");
  item.source.url = `https://rr3.googlevideo.com/videoplayback?expire=${Math.floor(
    Date.now() / 1000 - 10,
  )}&id=x`;
  const src = await usePlayerStore.getState()._resolveSrcQuiet(item);
  assert.equal(resolves, 1);
  assert.equal(src, "src:refreshed");
  assert.equal(item.source.url, "src:refreshed");
});
