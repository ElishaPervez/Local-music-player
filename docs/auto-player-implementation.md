# Auto-Player ("Radio") — Implementation Spec

Status: **approved for build**
Companion scoping doc (diagrams + rejected approaches): `docs/auto-player-plan.html`

---

## 1. What we're building

A toggle that, while a song plays, **automatically appends genuinely-similar songs to
the live queue** so playback never runs dry. Appended songs are **streamed
ephemerally** (`yt-dlp -g`), never downloaded, never written to the library or any
playlist. Turning the toggle off stops new appends; already-appended songs stay in the
queue until they fall off naturally.

### Chosen discovery engine: YouTube Mix (RD radio)

"Similar" = whatever YouTube's own recommendation graph puts in the auto-generated
**Mix** radio seeded by the currently-playing video. The Mix URL is
`https://www.youtube.com/watch?v=<id>&list=RD<id>`. Empirically this returns the same
genre/mood/era cohort of **official** uploads — not the slowed+reverb / nightcore
re-uploads the user explicitly does not want. No API keys, no ML, no cost beyond the
bundled `yt-dlp.exe`.

### Why this works even for an offline downloaded playlist

Every downloaded `Song` keeps its origin `videoId` (`src/lib/types.ts:16`,
`id == videoId`), and `songToItem` copies it into the `PlaybackItem`
(`src/lib/playback.ts:24`). So a local file still knows which YouTube video it came
from — that id is the Mix seed. The downloaded songs keep playing **from disk,
offline**; only the *suggested* songs require a network connection at the moment they
are fetched and streamed. No internet ⇒ no appends (fail soft), local songs keep
playing until the queue empties.

### Approved fallback (user decision)

When a seed's Mix comes back empty (deleted / region-locked / obscure seed),
**re-seed from a different song in the playing playlist** and retry, skipping seeds
already known to be dead, until one yields a non-empty mix or the seed pool is
exhausted (then stop, fail soft).

---

## 2. Settled design decisions

| Decision | Resolution |
|---|---|
| Discovery source | YouTube Mix (`list=RD<videoId>`) via `yt-dlp --flat-playlist` |
| Empty-mix fallback | Re-seed from another song in the playing playlist; mark dead seeds; stop if all exhausted |
| Repeat × auto-play | **Mutually exclusive.** Turning auto-play ON forces `repeat: "off"`; the repeat control is disabled while auto-play is on (infinite-extend and queue-looping can't both be true) |
| Shuffle × auto-play | Auto-appended tracks go to the **queue tail in fetch order**; never reshuffled. `addToQueue` already keeps `naturalOrder` in sync |
| Remix exclusion | Title-normalize + marker list + same-core check + videoId/recent dedupe (see §6) |
| Trigger / look-ahead | Fire when **unplayed-ahead ≤ 3** (LOW_WATER); fetch a batch of ~18; guard with an in-flight flag so it fires once |
| `playingPlaylistId` | **Kept.** Auto items are queue-only, tagged with an "Auto" badge; never added to the playlist or library |
| Persistence | `settings.autoPlay` (default **false**), persisted in `library.json`, mirrored into `playerStore` exactly like `crossfade` |
| Crossfade timing | Top-up must land before the ~5s fade arm; LOW_WATER=3 + early trigger keeps a resolved next track ready |

---

## 3. Backend — new Tauri command `related_mix`

**File:** `src-tauri/src/ytdlp.rs` — add alongside `search`. Reuses `entry_to_result`
and `best_thumbnail` unchanged (the scalar `thumbnail` is absent in `--flat-playlist`
mode, so the existing `thumbnails[]`-array fallback in `best_thumbnail` is required).

```rust
/// Fetch the YouTube "Mix" (RD radio) continuations for a seed video.
/// Returns lightweight metadata, same shape as `search`. Skips the seed itself.
#[tauri::command]
pub async fn related_mix(
    app: AppHandle,
    video_id: String,
    limit: u32,
) -> Result<Vec<SearchResult>, String> {
    let id = video_id.trim();
    if id.is_empty() {
        return Ok(vec![]);
    }
    let mix_url = format!("https://www.youtube.com/watch?v={id}&list=RD{id}");
    let end = (limit + 1).clamp(2, 50); // +1 because start=2 skips the seed

    let args: Vec<String> = vec![
        "--dump-json".into(),
        "--flat-playlist".into(),
        "--no-warnings".into(),
        "--ignore-errors".into(),
        "--playlist-start".into(),
        "2".into(),                 // skip the seed (item 1 is the seed itself)
        "--playlist-end".into(),
        end.to_string(),
        mix_url,
    ];

    let output = app
        .shell()
        .sidecar("yt-dlp")
        .map_err(|e| e.to_string())?
        .args(args)
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut results = Vec::new();
    for line in stdout.lines() {
        let line = line.trim();
        if !line.starts_with('{') {
            continue;
        }
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
            // A dead/empty mix can echo only the seed back; never return it.
            if let Some(r) = entry_to_result(&v) {
                if r.video_id != id {
                    results.push(r);
                }
            }
        }
    }
    // Empty result is a valid outcome (dead/obscure seed) — caller handles fallback.
    Ok(results)
}
```

**Register it** in `src-tauri/src/lib.rs` `generate_handler!` (after `ytdlp::search`):

```rust
ytdlp::search,
ytdlp::related_mix,
```

> Notes
> - `--flat-playlist` means no per-video network hit; ~25 items resolves in ~3–4s cold.
> - We do **not** pass an exclude list to yt-dlp (it can't filter); dedupe happens in JS
>   (§6) where we already hold the queue + recent-history state.
> - Fail soft: on a non-zero exit we still return whatever parsed (often `[]`), so a
>   throttled/broken call degrades to "no suggestions this tick", never an app error.

---

## 4. Frontend API binding

**File:** `src/lib/api.ts` — add to the `api` object (mirrors `search`):

```ts
relatedMix: (videoId: string, limit: number) =>
  invoke<SearchResult[]>("related_mix", { videoId, limit }),
```

---

## 5. Settings & persistence

**File:** `src/lib/types.ts` — extend `Settings` (mirror `crossfade`):

```ts
/** Auto-append similar (streamed) songs to keep the queue going. */
autoPlay: boolean;
```

- Default **false**. The existing `loadAll` `{...defaults, ...stored}` merge migrates
  older `library.json` files for free (same pattern used for `discordPresence`).
- **File:** `src/stores/libraryStore.ts` — add `autoPlay` to the defaults, persist it on
  change, and mirror it into the player store via a `setAutoPlay` setter **exactly** like
  `setCrossfade` (this avoids a `playerStore → libraryStore` import cycle — see the
  crossfade precedent).

---

## 6. Player store — the core integration

**File:** `src/stores/playerStore.ts`.

### 6a. New state

```ts
autoPlay: boolean;                 // mirrored from settings.autoPlay
_autoTopUpInFlight: boolean;       // guards the async fetch so it fires once
_recentVideoIds: string[];         // ring (~200) of videoIds seen this session
_deadSeeds: Set<string>;           // seeds whose Mix came back empty
```

Add a setter `setAutoPlay(on: boolean)`:

```ts
setAutoPlay: (on) => {
  // Infinite-extend and queue-looping are mutually exclusive.
  set({ autoPlay: on, ...(on ? { repeat: "off" as const } : {}) });
  if (on) void get()._autoTopUp(); // top up immediately if the queue is short
},
```

### 6b. Constants

```ts
const AUTO_LOW_WATER = 3;   // top up when this many or fewer unplayed tracks remain
const AUTO_BATCH = 18;      // candidates requested per Mix fetch
const RECENT_CAP = 200;     // session de-dupe ring size
```

### 6c. Trigger from `_onTime`

`_onTime` already runs on every time update and is where crossfade arms. Add an
auto-top-up check **before** the crossfade block so suggestions are queued ahead of the
fade window:

```ts
// inside _onTime, after the _consecutiveErrors/_errorRetried reset:
if (st.autoPlay && st.repeat === "off") {
  const unplayedAhead = st.queue.length - 1 - st.index;
  if (unplayedAhead <= AUTO_LOW_WATER && !st._autoTopUpInFlight) {
    void get()._autoTopUp();
  }
}
```

### 6d. End-of-queue safety net in `next()`

If a fetch was slow and the queue still emptied, don't hard-stop while auto-play is on.
In `next()`, replace the `else { audio.pause(); ... }` branch (currently
`playerStore.ts:192-196`) so that under auto-play it kicks a top-up and parks instead of
declaring the session over:

```ts
} else {
  if (get().autoPlay) {
    // Out of runway — fetch and resume from _autoTopUp's append hook.
    audio.pause();
    set({ isPlaying: false });
    void get()._autoTopUp();
    return;
  }
  audio.pause();
  set({ isPlaying: false });
  return;
}
```

### 6e. `_autoTopUp` — fetch, fallback, filter, append

```ts
_autoTopUp: async () => {
  const st = get();
  if (st._autoTopUpInFlight || !st.autoPlay) return;
  set({ _autoTopUpInFlight: true });
  try {
    // Build the ordered seed pool: current track first, then the rest of the
    // PLAYING PLAYLIST's songs (so an offline playlist can fall back), then any
    // other queue items. Skip known-dead seeds.
    const seeds = buildSeedPool(get()); // see §6f
    let appended = 0;

    for (const seed of seeds) {
      if (!get().autoPlay) break;
      if (!seed || get()._deadSeeds.has(seed)) continue;

      let results: SearchResult[] = [];
      try {
        results = await api.relatedMix(seed, AUTO_BATCH);
      } catch {
        results = []; // network/throttle → treat as empty, try next seed
      }
      if (results.length === 0) {
        get()._deadSeeds.add(seed); // dead/obscure/region-locked seed
        continue;
      }

      const fresh = filterCandidates(results, get()); // §6
      if (fresh.length === 0) continue;

      for (const r of fresh) {
        get().addToQueue(resultToStreamItem(r));
        get()._recentVideoIds.push(r.videoId);
        appended++;
      }
      // trim the recent ring
      if (get()._recentVideoIds.length > RECENT_CAP) {
        set((s) => ({ _recentVideoIds: s._recentVideoIds.slice(-RECENT_CAP) }));
      }
      break; // one good seed per top-up is enough
    }

    // If we parked at end-of-queue (6d) and just added songs, resume.
    const after = get();
    if (appended > 0 && !after.isPlaying && after.index >= 0) {
      void after._load();
    }
  } finally {
    set({ _autoTopUpInFlight: false });
  }
},
```

### 6f. Seed pool helper

```ts
// Current track is the primary seed; the rest of the playing playlist provides
// fallback seeds (this is what makes an offline playlist work). De-duped, order-
// preserving. Reads the playlist via libraryStore — pass songs in, don't import it
// here (avoid the cycle); e.g. accept a getter or read through the mirrored data.
function buildSeedPool(state): string[] {
  const ids: string[] = [];
  const cur = state.current();
  if (cur?.videoId) ids.push(cur.videoId);
  // playlist song videoIds (in order) for fallback seeds:
  for (const vid of playingPlaylistVideoIds(state)) ids.push(vid);
  // finally, any other queue items as last-resort seeds:
  for (const it of state.queue) if (it.videoId) ids.push(it.videoId);
  return [...new Set(ids)];
}
```

> Implementation note on the import cycle: `playingPlaylistVideoIds` needs the
> playlist→songs mapping that lives in `libraryStore`. Follow the existing crossfade
> pattern — have `libraryStore` push the current playlist's `videoId` list into
> `playerStore` (e.g. a `_seedPool` field updated when the playing playlist changes),
> rather than importing `libraryStore` from `playerStore`.

### 6g. Candidate filter (remix trap + dedupe)

```ts
const REMIX_MARKERS = [
  "slowed", "reverb", "sped up", "spedup", "nightcore", "8d", "lofi", "lo-fi",
  "remix", "mashup", "bass boost", "bassboost", "instrumental", "karaoke",
  "cover", "loop", "extended",
];

function normalizeTitle(t: string): string {
  return t.toLowerCase()
    .replace(/\(.*?\)|\[.*?\]/g, " ")          // strip (Official Video) / [Lyrics]
    .replace(/official|lyrics|audio|video|hd|mv/g, " ")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ").trim();
}

function filterCandidates(results: SearchResult[], state): SearchResult[] {
  const queued = new Set(state.queue.map((i) => i.videoId));
  const recent = new Set(state._recentVideoIds);
  const libIds = libraryVideoIds(state);        // already-downloaded songs
  const seedCores = new Set(
    [state.current(), ...state.queue].filter(Boolean)
      .map((i) => normalizeTitle(i.title)),
  );
  const out: SearchResult[] = [];
  const seenThisBatch = new Set<string>();
  for (const r of results) {
    if (!r.videoId) continue;
    if (queued.has(r.videoId) || recent.has(r.videoId) || libIds.has(r.videoId)) continue;
    if (seenThisBatch.has(r.videoId)) continue;
    const norm = normalizeTitle(r.title);
    const hasMarker = REMIX_MARKERS.some((m) => norm.includes(m));
    // Drop only if it's BOTH a remix-marked title AND a re-rendering of a song we're
    // already playing/queueing (so legit songs that merely contain "remix" survive
    // unless they shadow a current track).
    if (hasMarker && [...seedCores].some((c) => c && norm.includes(c))) continue;
    seenThisBatch.add(r.videoId);
    out.push(r);
  }
  return out;
}
```

---

## 7. UI

### 7a. Quick toggle in the transport bar

**File:** `src/components/NowPlayingBar.tsx` — add a toggle button next to
shuffle/repeat, bound to `autoPlay` (lucide `Radio` or `Infinity` icon; active = accent
`#7c5cff`). Clicking calls `libraryStore.setAutoPlay(!autoPlay)` so it persists. While
`autoPlay` is on, **disable the repeat button** (greyed) — the two are mutually
exclusive (§2).

### 7b. Settings row

**File:** `src/views/SettingsView.tsx` — add an "Auto-play radio" switch mirroring the
Crossfade/Discord rows (same component, same persistence path). Short description:
"When the queue runs low, automatically stream similar songs (not downloaded)."

### 7c. Queue badge

**File:** `src/components/QueuePanel.tsx` — items whose `source.kind === "stream"` and
that were auto-added show a small "Auto" / radio-icon badge so the user can tell
appended radio tracks from songs they queued themselves. (If distinguishing
user-streamed from auto-streamed matters, add an optional `auto?: boolean` to
`resultToStreamItem` and set it only on the auto path.)

---

## 8. Interactions to verify (no code, but confirm behavior)

- **Discord presence** (`src/lib/discordPresence.ts`) reads `current()` — auto items
  flow through unchanged; no edit needed. (Optional: show "Auto radio" as the playlist
  name line when the current item is auto-added.)
- **Crossfade**: an auto item is a normal stream `PlaybackItem`; `_startCrossfade`
  resolves its URL lazily via `_resolveSrc` like any stream. LOW_WATER=3 keeps the next
  track present before the fade arms.
- **Error/skip path** (`_onPlaybackError`): dead/region-locked auto picks are skipped by
  the existing retry-then-skip logic; the consecutive-error guard still stops a fully
  broken run.
- **Toggling off**: stops new appends immediately (the in-flight fetch checks
  `get().autoPlay` and won't append after the user turns it off).

---

## 9. Failure modes & fail-soft contract

| Situation | Behavior |
|---|---|
| No internet | `related_mix` errors → caught → treated as empty → no append; local songs keep playing; queue eventually ends → pause |
| Seed video deleted / region-locked | Empty mix → seed marked dead → re-seed from next playlist song |
| Every seed in the playlist is dead/obscure | Seed pool exhausted → stop appending this tick; retry on next trigger |
| YouTube throttling (429 / bot check) | Empty/non-zero exit → degrade to "no suggestions"; low-water + in-flight guard keep request volume low (≤ ~1 fetch per several tracks) |
| Mix drifts mainstream over a long session | Accepted limitation (documented in plan); recent-ring dedupe prevents literal repeats |

---

## 10. Build checklist

- [ ] `related_mix` command in `ytdlp.rs` + registered in `lib.rs`
- [ ] `api.relatedMix` binding
- [ ] `Settings.autoPlay` type + libraryStore default/persist/mirror (`setAutoPlay`)
- [ ] playerStore: state, `setAutoPlay`, `_autoTopUp`, seed pool, `filterCandidates`,
      `_onTime` trigger, `next()` end-of-queue safety net
- [ ] NowPlayingBar toggle (+ disable repeat while on)
- [ ] SettingsView row
- [ ] QueuePanel "Auto" badge
- [ ] Verify: offline downloaded playlist + auto-play on → streams similar songs;
      toggling off stops appends; empty-seed fallback re-seeds; no-internet fails soft
