/**
 * Turns the raw sound of whatever is playing into the handful of numbers the
 * orb moves by: how loud it is, how much low end there is, and the moment a
 * beat lands.
 *
 * The smoothing is the whole trick for the first two. Raw readings jump around
 * every frame, and driving anything visual straight off them looks like a
 * twitch rather than a dance. Rising fast and falling slowly is what makes a
 * kick drum read as a push that then relaxes.
 *
 * A beat is the opposite problem: it has to be caught the instant it happens,
 * before any smoothing has flattened it out.
 */

/** Bass band, in Hz. Kick drums and bass lines live here. */
const BASS_LO_HZ = 20;
const BASS_HI_HZ = 160;
/** Above this the content is mostly air and hiss; including it flattens the
 *  overall reading toward a constant, so it's left out. */
const LEVEL_HI_HZ = 8000;

/** Seconds to close most of the gap when a reading is climbing / falling. */
const RISE_SEC = 0.035;
const FALL_SEC = 0.32;

/** How far above its recent normal the low end must jump to count as a beat.
 *  Both parts matter: the multiplier catches a hit in a quiet passage, the
 *  fixed part stops near-silence from registering every tiny flicker. */
const BEAT_RATIO = 1.3;
const BEAT_MARGIN = 0.05;
/** Nothing this quiet is a beat, however sharp the jump. */
const BEAT_FLOOR = 0.1;
/** Shortest gap between beats. Anything faster is the same hit ringing out. */
const BEAT_GAP_SEC = 0.11;
/** How long the "a beat just landed" signal takes to fade. */
const BEAT_DECAY_SEC = 0.18;
/** How quickly "recent normal" follows the music. Long enough to survive a
 *  whole bar, short enough to track a song getting louder. */
const BEAT_AVERAGE_SEC = 1.2;

export type Levels = {
  /** Overall loudness, 0–1. */
  level: number;
  /** Low-end energy, 0–1. */
  bass: number;
  /** 1 the instant a beat lands, fading to 0 over a fraction of a second. */
  hit: number;
  /** True only on the single frame a beat is detected. */
  beat: boolean;
};

/**
 * Move `prev` toward `target` by an amount that depends on elapsed time, so
 * the feel of the motion doesn't change with the frame rate. Separate rise and
 * fall constants give the asymmetry described above.
 */
export function smoothToward(
  prev: number,
  target: number,
  dtSec: number,
  riseSec = RISE_SEC,
  fallSec = FALL_SEC,
): number {
  const tau = target > prev ? riseSec : fallSec;
  if (tau <= 0 || dtSec <= 0) return dtSec <= 0 ? prev : target;
  return prev + (target - prev) * (1 - Math.exp(-dtSec / tau));
}

/**
 * Average the readings that fall inside a frequency range.
 *
 * The readings arrive as one value per evenly-spaced slice of the frequency
 * range up to half the sample rate, so which slices to average is just
 * arithmetic on where the range boundaries land.
 */
export function bandAverage(
  bins: ArrayLike<number>,
  loHz: number,
  hiHz: number,
  sampleRate: number,
): number {
  const n = bins.length;
  if (n === 0 || sampleRate <= 0) return 0;
  const hzPerBin = sampleRate / 2 / n;
  const first = Math.max(0, Math.floor(loHz / hzPerBin));
  const last = Math.min(n - 1, Math.ceil(hiHz / hzPerBin));
  if (last < first) return 0;
  let sum = 0;
  for (let i = first; i <= last; i++) sum += bins[i];
  return sum / (last - first + 1) / 255;
}

/** The unsmoothed loudness and bass for one set of readings. */
export function levelsFromSpectrum(
  bins: ArrayLike<number>,
  sampleRate: number,
): { level: number; bass: number } {
  return {
    level: bandAverage(bins, 0, LEVEL_HI_HZ, sampleRate),
    bass: bandAverage(bins, BASS_LO_HZ, BASS_HI_HZ, sampleRate),
  };
}

/**
 * Does this instant count as a beat?
 *
 * Compared against the low end's own recent normal rather than a fixed level,
 * so a quiet song still gets beats and a loud one doesn't register every
 * moment as one. `sinceLast` blocks the ring-out of a hit from being counted
 * as several beats in a row.
 */
export function isBeat(
  rawBass: number,
  recentNormal: number,
  sinceLastSec: number,
): boolean {
  if (sinceLastSec < BEAT_GAP_SEC) return false;
  if (rawBass < BEAT_FLOOR) return false;
  return rawBass > recentNormal * BEAT_RATIO + BEAT_MARGIN;
}

/**
 * One step of a weight on a spring: the motion behind the orb's punch on a
 * beat. Kicking the velocity inward makes it contract, spring back out past
 * where it started, and settle — which is what a hit looks like, as opposed to
 * a size that simply follows the volume up and down.
 *
 * `stiffness` sets how fast it snaps back, `damping` how quickly the wobble
 * dies out.
 */
export function stepSpring(
  offset: number,
  velocity: number,
  dtSec: number,
  stiffness: number,
  damping: number,
): { offset: number; velocity: number } {
  const nextVelocity =
    velocity + (-stiffness * offset - damping * velocity) * dtSec;
  return { offset: offset + nextVelocity * dtSec, velocity: nextVelocity };
}

/**
 * Holds the smoothed readings between frames. One of these lives for as long
 * as the orb is on screen.
 */
export class LevelMeter {
  private bins: Uint8Array;
  private level = 0;
  private bass = 0;
  private hit = 0;
  /** What the low end has been doing lately, for a beat to stand out against. */
  private recentNormal = 0;
  private sinceLastBeat = BEAT_GAP_SEC;

  constructor(private analyser: AnalyserNode) {
    this.bins = new Uint8Array(analyser.frequencyBinCount);
  }

  /** Read the sound as it is right now and fold it into the running values. */
  read(dtSec: number): Levels {
    // The typed-array overloads disagree across TS DOM versions about the
    // exact buffer type; the call itself is the same either way.
    this.analyser.getByteFrequencyData(this.bins as unknown as Uint8Array<ArrayBuffer>);
    const raw = levelsFromSpectrum(this.bins, this.analyser.context.sampleRate);

    this.sinceLastBeat += dtSec;
    const beat = isBeat(raw.bass, this.recentNormal, this.sinceLastBeat);
    if (beat) {
      this.sinceLastBeat = 0;
      this.hit = 1;
    } else {
      this.hit = smoothToward(this.hit, 0, dtSec, BEAT_DECAY_SEC, BEAT_DECAY_SEC);
    }
    // Updated from the raw value AFTER the test, so a beat doesn't raise the
    // bar it just cleared.
    this.recentNormal = smoothToward(
      this.recentNormal,
      raw.bass,
      dtSec,
      BEAT_AVERAGE_SEC,
      BEAT_AVERAGE_SEC,
    );

    this.level = smoothToward(this.level, raw.level, dtSec);
    this.bass = smoothToward(this.bass, raw.bass, dtSec);
    return { level: this.level, bass: this.bass, hit: this.hit, beat };
  }

  /** Let the readings fall to nothing without touching the sound — used while
   *  the music is paused so the orb relaxes instead of holding its last shape. */
  decay(dtSec: number): Levels {
    this.level = smoothToward(this.level, 0, dtSec);
    this.bass = smoothToward(this.bass, 0, dtSec);
    this.hit = smoothToward(this.hit, 0, dtSec, BEAT_DECAY_SEC, BEAT_DECAY_SEC);
    return { level: this.level, bass: this.bass, hit: this.hit, beat: false };
  }
}
