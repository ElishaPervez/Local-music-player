# Playback State Consistency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the latest queue or transport action the only action allowed to control audible playback and auto-play appends.

**Architecture:** Keep the existing Zustand store and two-element audio controller. Add separate freshness counters for playback commands and auto-play sessions, plus the identity of the loaded and crossfading items. Reset audio and visible timing at the start of a selection change, then guard every async completion.

**Tech Stack:** React 19, TypeScript, Zustand 5, Vite 7, Node 24 test runner, Tauri 2.

## Global Constraints

- Use code-only verification; do not control the app UI.
- Preserve all existing uncommitted auto-play and Discord work.
- Do not commit because the working tree already contains user-owned changes.
- Test each behavior against the real store and audio controller; replace only external desktop/network calls.

---

### Task 1: Regression harness and failing playback tests

**Files:**
- Create: `tests/playerState.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: `usePlayerStore`, `audio`, and the mutable `api` boundary.
- Produces: `npm test`, with controlled fake `HTMLAudioElement` instances and deferred network promises.

- [ ] **Step 1: Add tests for the confirmed races**

  Cover current-item removal before a slow replacement resolves, clear during
  load, A/B out-of-order completion, clear during auto-play top-up, rapid
  play/pause, timeline reset, and incoming-crossfade removal.

- [ ] **Step 2: Run tests and verify RED**

  Run: `npm test`

  Expected: assertions show old audio remains active, stale loads win, cleared
  queues refill, rapid pause loses, old timing remains, and removed crossfade
  audio stays audible.

### Task 2: Playback command freshness

**Files:**
- Modify: `src/stores/playerStore.ts`

**Interfaces:**
- Produces: `_playbackCommandId: number` and `_loadedKey: string | null`.

- [ ] **Step 1: Claim a new command at the start of each load**

  Pause existing audio, reset position/duration/loading state, capture the
  selected item and command number, resolve quietly, and re-check both before
  playing or changing state.

- [ ] **Step 2: Make pause/resume deterministic**

  Update the visible state before awaiting resume, invalidate it on pause, and
  reload instead of resuming when the selected item was never loaded.

- [ ] **Step 3: Run the focused tests and verify GREEN**

  Run: `node --test tests/playerState.test.mjs`

  Expected: removal, clear, out-of-order load, rapid toggle, and timeline tests pass.

### Task 3: Auto-play session freshness

**Files:**
- Modify: `src/stores/playerStore.ts`

**Interfaces:**
- Produces: `_autoSessionId: number`; every top-up captures and validates it.

- [ ] **Step 1: Invalidate old recommendation work**

  Increment the session when a queue is replaced/cleared or auto-play changes,
  cancel the old retry timer, and allow a new session to fetch independently.

- [ ] **Step 2: Guard every await and final state write**

  Abort result filtering/appending/resume/timer scheduling when the captured
  session no longer matches. An old request's `finally` must not clear the new
  request's in-flight flag.

- [ ] **Step 3: Run the focused tests and verify GREEN**

  Run: `node --test tests/playerState.test.mjs`

  Expected: a clear or queue replacement remains authoritative after late mix results.

### Task 4: Crossfade removal consistency

**Files:**
- Modify: `src/stores/playerStore.ts`
- Modify: `src/lib/audio.ts`

**Interfaces:**
- Produces: `_crossfadeTargetKey: string | null` and a boolean result from starting a crossfade.

- [ ] **Step 1: Record the audible incoming item**

  Set the target only if the overlap starts and clear it when the overlap ends,
  is cancelled, or fails.

- [ ] **Step 2: Cancel invalid overlaps**

  Removing the target or switching crossfade off cancels the overlap and clears
  the target/arm state.

- [ ] **Step 3: Run the focused tests and verify GREEN**

  Run: `node --test tests/playerState.test.mjs`

  Expected: removed incoming audio is paused immediately and no callback adopts it.

### Task 5: Full verification and report

**Files:**
- Create: `docs/playback-state-bug-hunt-report.html`

**Interfaces:**
- Consumes: the final diff and fresh test/build output.
- Produces: a self-contained user-facing HTML report with cause/effect findings and verification evidence.

- [ ] **Step 1: Run all automated checks**

  Run: `npm test`

  Run: `npm run build`

  Run: `cargo check --manifest-path src-tauri/Cargo.toml`

  Expected: every command exits 0.

- [ ] **Step 2: Inspect the final diff**

  Confirm only state-consistency tests/fixes/report files were added on top of
  the existing user-owned changes.

- [ ] **Step 3: Write and validate the HTML report**

  Explain what the user would have observed, why it happened, what now prevents
  it, and which checks passed. Keep code identifiers out of the explanation;
  include file links only as references.

