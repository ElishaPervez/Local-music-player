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
