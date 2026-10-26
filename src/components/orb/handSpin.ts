/**
 * Turning the orb by hand: how a drag becomes rotation, what happens to the
 * throw when you let go, and how the steady spin fades back in.
 *
 * Kept as plain maths with no 3D and no browser in it, so the feel of the
 * thing can be tested directly instead of judged from screenshots.
 */

/** Radians turned per pixel dragged. Dragging halfway across the orb turns it
 *  about a quarter turn, which is roughly how a real globe behaves. */
export const DRAG_SENSITIVITY = 0.012;
/** How far it can be tipped up or down — about a third of a right angle. Past
 *  that you are looking at the poles, where the cover art is a smear. */
const MAX_TILT = 0.55;
/** Ceiling on a throw, so a fast swipe can't leave it a blur. */
const MAX_FLING = 14;
/**
 * How much of the recent past the throw speed is judged over.
 *
 * This one matters more than it looks. A pointer reports its position far less
 * often than the screen redraws, so plenty of frames see no movement at all.
 * Judging the throw on the last frame alone reads one of those empty frames as
 * "stopped", and the orb dies the instant you let go — which is exactly what
 * happened before this existed.
 *
 * Averaging over a window rather than trailing off gradually is what lets both
 * things be true at once: a dropped frame barely moves the average, while
 * genuinely holding still for longer than the window empties it completely, so
 * placing the orb somewhere and letting go leaves it exactly there.
 */
const FLING_WINDOW_SEC = 0.12;
/** Seconds for a throw's momentum to die away once you let go. */
const FLING_DECAY_SEC = 0.85;
/** Seconds for the steady spin to fade back in. Deliberately slower than the
 *  throw dies, so it drifts back into it rather than snapping. */
const SPIN_RETURN_SEC = 1.5;
/** Seconds for a tipped orb to level itself again. */
const TILT_RETURN_SEC = 1.1;
/**
 * When hand-turning counts as finished. Two different thresholds because they
 * measure different things: a speed of a fiftieth of a radian a second is a
 * degree a minute — invisible — while a tilt is a position you can actually
 * see. Setting either tighter than this just keeps the orb redrawing for
 * several extra seconds to finish a movement nobody can perceive.
 */
const FLING_STILL = 0.02;
const TILT_STILL = 0.004;

export type HandSpin = {
  /** Turn applied by hand, on top of whatever the steady spin is doing. */
  yaw: number;
  /** Tip up or down. Always on its way back to level once you let go. */
  tilt: number;
  /** Leftover speed from a throw, in radians per second. */
  fling: number;
  /** How much of the steady spin is in effect: 0 while held, back to 1 after. */
  spinBlend: number;
  /** The last handful of frames of pointer movement, newest last, covering at
   *  most FLING_WINDOW_SEC. Only meaningful while a hand is on the orb. */
  recent: ReadonlyArray<{ dx: number; dt: number }>;
};

export const HAND_SPIN_AT_REST: HandSpin = {
  yaw: 0,
  tilt: 0,
  fling: 0,
  spinBlend: 1,
  recent: [],
};

/** Average speed over the window, in radians per second. Frames that reported
 *  nothing still count toward the elapsed time, which is what makes coming to
 *  a stop read as a stop. */
function windowedSpeed(
  recent: ReadonlyArray<{ dx: number; dt: number }>,
): number {
  let pixels = 0;
  let seconds = 0;
  for (const sample of recent) {
    pixels += sample.dx;
    seconds += sample.dt;
  }
  if (seconds <= 0) return 0;
  return (pixels * DRAG_SENSITIVITY) / seconds;
}

/** Add a frame and drop whatever has fallen out of the back of the window. */
function remember(
  recent: ReadonlyArray<{ dx: number; dt: number }>,
  dx: number,
  dt: number,
): Array<{ dx: number; dt: number }> {
  const next = [...recent, { dx, dt }];
  let total = 0;
  for (const sample of next) total += sample.dt;
  while (next.length > 1 && total - next[0].dt >= FLING_WINDOW_SEC) {
    total -= next[0].dt;
    next.shift();
  }
  return next;
}

const ease = (from: number, to: number, dtSec: number, tau: number) =>
  tau <= 0 ? to : from + (to - from) * (1 - Math.exp(-dtSec / tau));

const clamp = (v: number, limit: number) => Math.max(-limit, Math.min(limit, v));

/**
 * Advance the hand-turning by one frame.
 *
 * `dx`/`dy` are the pixels the pointer moved since the last frame — zero on
 * any frame where it didn't report, which is normal and must not be mistaken
 * for the hand having stopped.
 */
export function stepHandSpin(
  state: HandSpin,
  dtSec: number,
  input: { dragging: boolean; dx: number; dy: number },
): HandSpin {
  if (dtSec <= 0) return state;

  if (input.dragging) {
    const recent = remember(state.recent, input.dx, dtSec);
    return {
      yaw: state.yaw + input.dx * DRAG_SENSITIVITY,
      tilt: clamp(state.tilt + input.dy * DRAG_SENSITIVITY, MAX_TILT),
      fling: clamp(windowedSpeed(recent), MAX_FLING),
      // The steady spin cuts out the moment a hand is on it, so the orb
      // follows the pointer exactly rather than creeping ahead of it.
      spinBlend: 0,
      recent,
    };
  }

  return {
    yaw: state.yaw + state.fling * dtSec,
    tilt: ease(state.tilt, 0, dtSec, TILT_RETURN_SEC),
    fling: ease(state.fling, 0, dtSec, FLING_DECAY_SEC),
    spinBlend: ease(state.spinBlend, 1, dtSec, SPIN_RETURN_SEC),
    recent: [],
  };
}

/** Is anything still moving of its own accord? While this is true the orb has
 *  to keep drawing, even with the music paused. */
export function handSpinIsSettling(state: HandSpin, dragging: boolean): boolean {
  // The steady spin fading back in is deliberately NOT a reason to keep
  // drawing. It only has any effect while the music is playing, and while the
  // music is playing the orb is redrawing anyway — so counting it here would
  // do nothing but keep a paused orb awake for another ten seconds.
  return (
    dragging ||
    Math.abs(state.fling) > FLING_STILL ||
    Math.abs(state.tilt) > TILT_STILL
  );
}
