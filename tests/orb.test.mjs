import { after, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "vite";

const vite = await createServer({
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "error",
});

const { smoothToward, bandAverage, levelsFromSpectrum, isBeat, stepSpring } =
  await vite.ssrLoadModule("/src/lib/audioLevels.ts");
const { dominantColor, FALLBACK_COLOR } =
  await vite.ssrLoadModule("/src/lib/coverColor.ts");
const { stepHandSpin, handSpinIsSettling, HAND_SPIN_AT_REST, DRAG_SENSITIVITY } =
  await vite.ssrLoadModule("/src/components/orb/handSpin.ts");

after(() => vite.close());

/* ————————————————————————— reading the sound ————————————————————————— */

test("a reading climbs far faster than it falls", () => {
  const dt = 1 / 60;
  const up = smoothToward(0, 1, dt);
  const down = smoothToward(1, 0, dt);
  // Rising covers most of the gap in a frame; falling barely moves. That gap
  // is what makes a beat look like a push rather than a flicker.
  assert.ok(up > 0.35, `rise was only ${up}`);
  assert.ok(1 - down < 0.06, `fall was ${1 - down}`);
});

test("the same elapsed time gives the same result at any frame rate", () => {
  let fast = 0;
  for (let i = 0; i < 120; i++) fast = smoothToward(fast, 1, 1 / 120);
  let slow = 0;
  for (let i = 0; i < 30; i++) slow = smoothToward(slow, 1, 1 / 30);
  assert.ok(
    Math.abs(fast - slow) < 0.01,
    `one second of rise differed by frame rate: ${fast} vs ${slow}`,
  );
});

test("a reading settles on its target and stays there", () => {
  let v = 0;
  for (let i = 0; i < 600; i++) v = smoothToward(v, 0.7, 1 / 60);
  assert.ok(Math.abs(v - 0.7) < 1e-6);
  assert.equal(smoothToward(0.7, 0.7, 1 / 60), 0.7);
});

test("no elapsed time means no change", () => {
  assert.equal(smoothToward(0.25, 1, 0), 0.25);
});

test("only the requested slice of the frequency range is averaged", () => {
  // 512 readings covering 0–24000 Hz, so each one spans just under 47 Hz.
  const bins = new Uint8Array(512);
  bins.fill(0);
  bins[1] = 255; // ~47–94 Hz — squarely in the bass
  bins[400] = 255; // ~18.7 kHz — well above it

  const bass = bandAverage(bins, 20, 160, 48000);
  assert.ok(bass > 0, "the low reading was missed");
  assert.ok(bass < 1, "the whole band should not read as full");

  // Five readings overlap 20–160 Hz, and exactly one of them is at full.
  assert.ok(Math.abs(bass - 1 / 5) < 0.02, `bass came out at ${bass}`);
});

test("silence reads as nothing and a full spectrum reads as everything", () => {
  const silent = new Uint8Array(512);
  const loud = new Uint8Array(512).fill(255);
  const quiet = levelsFromSpectrum(silent, 48000);
  assert.equal(quiet.level, 0);
  assert.equal(quiet.bass, 0);
  const full = levelsFromSpectrum(loud, 48000);
  assert.equal(full.level, 1);
  assert.equal(full.bass, 1);
});

test("an empty set of readings is not a crash", () => {
  assert.equal(bandAverage(new Uint8Array(0), 20, 160, 48000), 0);
  assert.equal(bandAverage(new Uint8Array(8), 20, 160, 0), 0);
});

/* ————————————————————————————— beats ————————————————————————————— */

test("a jump well above the recent normal counts as a beat", () => {
  assert.equal(isBeat(0.62, 0.30, 1), true);
});

test("steady low end never registers as a beat", () => {
  // Loud, but exactly as loud as it has been — a sustained bass note, not a hit.
  assert.equal(isBeat(0.55, 0.55, 1), false);
  assert.equal(isBeat(0.9, 0.9, 1), false);
});

test("a quiet passage still produces beats", () => {
  // The same proportional jump, an order of magnitude quieter overall.
  assert.equal(isBeat(0.32, 0.14, 1), true);
});

test("near-silence never produces beats, however sharp the jump", () => {
  // Twenty times its recent normal, and still far too quiet to be a kick.
  assert.equal(isBeat(0.06, 0.003, 1), false);
});

test("one hit ringing out is not counted as several beats", () => {
  const justFired = 0.02; // seconds since the last beat
  assert.equal(isBeat(0.62, 0.30, justFired), false);
  assert.equal(isBeat(0.62, 0.30, 0.2), true);
});

/* —————————————————————————— the beat punch —————————————————————————— */

/** Run the spring forward from an inward shove and record where it goes. */
function punch(seconds = 2, impulse = -1.15) {
  const dt = 1 / 60;
  let offset = 0;
  let velocity = impulse;
  const path = [];
  for (let i = 0; i < seconds * 60; i++) {
    ({ offset, velocity } = stepSpring(offset, velocity, dt, 190, 15));
    path.push(offset);
  }
  return path;
}

test("a beat squeezes the orb inward, then springs back past its size", () => {
  const path = punch();
  const tightest = Math.min(...path);
  assert.ok(tightest < -0.03, `barely moved: ${tightest}`);
  // Overshooting outward after the squeeze is what makes it read as a punch
  // rather than a slow deflate.
  const reboundAfterSqueeze = Math.max(...path.slice(path.indexOf(tightest)));
  assert.ok(reboundAfterSqueeze > 0, `never sprang back out: ${reboundAfterSqueeze}`);
});

test("the squeeze stays subtle enough to keep the cover readable", () => {
  assert.ok(Math.min(...punch()) > -0.13, "the orb collapsed too far");
});

test("the orb always comes back to its resting size", () => {
  const path = punch(4);
  assert.ok(Math.abs(path[path.length - 1]) < 0.001, `left off-size: ${path.at(-1)}`);
});

test("a spring at rest with nothing pushing it stays exactly put", () => {
  const still = stepSpring(0, 0, 1 / 60, 190, 15);
  assert.equal(still.offset, 0);
  assert.equal(still.velocity, 0);
});

/* ————————————————————————— spinning it by hand ————————————————————————— */

const FRAME = 1 / 60;

/**
 * Play out a drag. `moves` is the pixels the pointer reported on each frame —
 * a 0 means that frame got no report at all, which is what really happens.
 * Then let go and run on for `coastFrames`.
 */
function dragThen(moves, coastFrames) {
  let s = HAND_SPIN_AT_REST;
  for (const dx of moves) {
    s = stepHandSpin(s, FRAME, { dragging: true, dx, dy: 0 });
  }
  const atRelease = s;
  const path = [];
  for (let i = 0; i < coastFrames; i++) {
    s = stepHandSpin(s, FRAME, { dragging: false, dx: 0, dy: 0 });
    path.push(s);
  }
  return { atRelease, after: s, path };
}

test("dragging turns the orb by exactly what the pointer moved", () => {
  const s = stepHandSpin(HAND_SPIN_AT_REST, FRAME, { dragging: true, dx: 100, dy: 0 });
  assert.ok(Math.abs(s.yaw - 100 * DRAG_SENSITIVITY) < 1e-9);
});

test("letting go mid-sweep leaves the orb gliding on", () => {
  const { atRelease, path } = dragThen(Array(20).fill(10), 30);
  assert.ok(atRelease.fling > 1, `no throw speed at release: ${atRelease.fling}`);
  // Still turning half a second later.
  assert.ok(
    path[29].yaw > atRelease.yaw + 0.1,
    `it stopped dead instead of gliding: ${path[29].yaw} vs ${atRelease.yaw}`,
  );
});

test("frames where the pointer didn't report don't kill the throw", () => {
  // A pointer reports far less often than the screen redraws, so a real drag
  // looks like this — movement, nothing, nothing, movement. This is the exact
  // case that made the orb stop dead the moment you let go.
  const stuttered = [];
  for (let i = 0; i < 24; i++) stuttered.push(i % 3 === 0 ? 30 : 0);
  const smooth = Array(24).fill(10); // same total distance, reported every frame

  const a = dragThen(stuttered, 1).atRelease;
  const b = dragThen(smooth, 1).atRelease;
  assert.ok(a.fling > 1, `a stuttering drag lost its throw: ${a.fling}`);
  assert.ok(
    Math.abs(a.fling - b.fling) / b.fling < 0.5,
    `stuttered ${a.fling} vs smooth ${b.fling} — too far apart to feel the same`,
  );
});

test("coming to a stop before letting go leaves it where you put it", () => {
  // Dragged, then held still for a fifth of a second, then released.
  const moves = [...Array(20).fill(10), ...Array(12).fill(0)];
  const { atRelease, after } = dragThen(moves, 60);
  assert.ok(Math.abs(atRelease.fling) < 0.6, `it flew off anyway: ${atRelease.fling}`);
  assert.ok(
    Math.abs(after.yaw - atRelease.yaw) < 0.05,
    `it drifted after being placed: ${after.yaw} vs ${atRelease.yaw}`,
  );
});

test("a throw runs out instead of spinning forever", () => {
  const { path } = dragThen(Array(20).fill(14), 60 * 6);
  const last = path[path.length - 1];
  const secondLast = path[path.length - 2];
  // A fiftieth of a radian a second is about a degree a minute — gone.
  assert.ok(Math.abs(last.fling) < 0.02, `still gliding: ${last.fling}`);
  assert.ok(Math.abs(last.yaw - secondLast.yaw) < 1e-3, "never came to rest");
});

test("the steady spin cuts out under your hand and fades back after", () => {
  let s = stepHandSpin(HAND_SPIN_AT_REST, FRAME, { dragging: true, dx: 5, dy: 0 });
  assert.equal(s.spinBlend, 0, "the orb kept spinning under the pointer");
  for (let i = 0; i < 60 * 8; i++) {
    s = stepHandSpin(s, FRAME, { dragging: false, dx: 0, dy: 0 });
  }
  assert.ok(s.spinBlend > 0.99, `the steady spin never came back: ${s.spinBlend}`);
});

test("the orb can't be tipped past its poles", () => {
  let s = HAND_SPIN_AT_REST;
  for (let i = 0; i < 200; i++) {
    s = stepHandSpin(s, FRAME, { dragging: true, dx: 0, dy: 100 });
  }
  assert.ok(s.tilt <= 0.55 + 1e-9, `tipped too far: ${s.tilt}`);
});

test("a tipped orb levels itself once you let go", () => {
  let s = stepHandSpin(HAND_SPIN_AT_REST, FRAME, { dragging: true, dx: 0, dy: 40 });
  assert.ok(s.tilt > 0.1, "the drag didn't tip it");
  for (let i = 0; i < 60 * 8; i++) {
    s = stepHandSpin(s, FRAME, { dragging: false, dx: 0, dy: 0 });
  }
  assert.ok(Math.abs(s.tilt) < 0.004, `left leaning: ${s.tilt}`);
});

test("the orb keeps drawing while anything is still moving, and not after", () => {
  assert.equal(handSpinIsSettling(HAND_SPIN_AT_REST, true), true, "held but idle");
  assert.equal(handSpinIsSettling(HAND_SPIN_AT_REST, false), false, "idle but busy");
  const { atRelease, after } = dragThen(Array(20).fill(12), 60 * 8);
  assert.equal(handSpinIsSettling(atRelease, false), true, "gliding but idle");
  assert.equal(handSpinIsSettling(after, false), false, "still busy long after");
});

/* ————————————————————————— reading the cover ————————————————————————— */

/** Build raw pixels: `counts` maps a colour to how many pixels of it appear. */
function pixels(entries) {
  const out = [];
  for (const [[r, g, b, a], count] of entries) {
    for (let i = 0; i < count; i++) out.push(r, g, b, a ?? 255);
  }
  return out;
}

test("a mostly-black cover with one strong colour reports that colour", () => {
  const data = pixels([
    [[8, 8, 10], 900], // dark background, the bulk of the image
    [[220, 40, 60], 124], // the artwork itself
  ]);
  const [r, g, b] = dominantColor(data);
  assert.ok(r > g && r > b, `expected a red result, got ${r},${g},${b}`);
  // A plain average would have been swamped by the background and come out
  // almost black; the result has to be bright enough to light the orb.
  assert.ok(Math.max(r, g, b) >= 150, `too dark to glow: ${r},${g},${b}`);
});

test("a grey cover stays grey rather than inventing a colour", () => {
  const [r, g, b] = dominantColor(pixels([[[128, 128, 128], 256]]));
  assert.ok(Math.abs(r - g) < 12 && Math.abs(g - b) < 12, `drifted: ${r},${g},${b}`);
});

test("transparent pixels are ignored", () => {
  const opaqueOnly = dominantColor(pixels([[[30, 200, 120], 64]]));
  const withGhosts = dominantColor(
    pixels([
      [[30, 200, 120], 64],
      [[255, 0, 0, 0], 400],
    ]),
  );
  assert.deepEqual(withGhosts, opaqueOnly);
});

test("an unreadable cover falls back to the app's own colour", () => {
  assert.deepEqual(dominantColor([]), FALLBACK_COLOR);
  assert.deepEqual(dominantColor(pixels([[[0, 0, 0, 0], 100]])), FALLBACK_COLOR);
});

test("every channel stays inside the range a colour can hold", () => {
  const [r, g, b] = dominantColor(pixels([[[255, 250, 245], 100]]));
  for (const v of [r, g, b]) {
    assert.ok(v >= 0 && v <= 255 && Number.isInteger(v), `out of range: ${v}`);
  }
});
