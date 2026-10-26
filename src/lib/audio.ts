/** How often the crossfade ramp re-applies volumes (~20 updates/sec). */
const FADE_TICK_MS = 50;

/** Side-channel boost while stereo widening is on. 1 reproduces the input
 *  untouched, so this is how far past "normal stereo" the effect pushes. */
const WIDE_SIDE_GAIN = 1.9;
/** Seconds the width change ramps over, so flipping the toggle never clicks. */
const WIDTH_RAMP_SEC = 0.15;

/**
 * Two HTMLAudioElements so playback can crossfade: while one track fades out,
 * the next plays and fades in on the other element. With crossfade off only the
 * active element is ever used, so behaviour matches a single-element player.
 */
class AudioController {
  private els: [HTMLAudioElement, HTMLAudioElement];
  private active = 0;
  private masterVolume = 1;
  /** True while a crossfade is overlapping; suppresses the outgoing `ended`. */
  private crossfading = false;
  /** src currently primed (src-assigned + load()ed) on the idle element, or null. */
  private primedSrc: string | null = null;
  private fade?: {
    outEl: HTMLAudioElement;
    inEl: HTMLAudioElement;
    durationMs: number;
    elapsed: number;
    lastTs: number | null;
    timer: number | null;
    done: () => void;
  };

  /**
   * Processing chain, built once at startup. It carries stereo widening AND
   * the read-only tap the Home-screen visualiser listens to, so it exists even
   * with widening switched off — an element can only ever be tapped once, so
   * there is no way to add the visualiser's listener later on a separate path.
   * At width 1 the chain reproduces its input exactly, so "off" costs nothing.
   */
  private graph: {
    ctx: AudioContext;
    /** Per-element level control; replaces `el.volume` once routed. */
    gains: Map<HTMLAudioElement, GainNode>;
    /** Gain on the L−R difference: 1 = untouched, higher = wider. */
    side: GainNode;
    /** Listen-only branch: measures the output without being part of the path
     *  to the speakers, so nothing it does can alter what you hear. */
    analyser: AnalyserNode;
  } | null = null;
  /** Set if building the chain ever throws; playback then just runs dry. */
  private graphFailed = false;

  onEnded?: () => void;
  onTime?: (current: number, duration: number) => void;
  onError?: (e: unknown) => void;
  private wired = false;

  constructor() {
    this.els = [new Audio(), new Audio()];
    for (const el of this.els) {
      el.preload = "auto";
      // Must be set before any src is assigned. Without it the webview treats
      // the audio as foreign and the widening chain would only ever receive
      // silence. Both sources we play — the asset protocol for library files
      // and the loopback proxy for streams — return the matching permission.
      el.crossOrigin = "anonymous";
    }
  }

  /**
   * Level for one element. Once the chain exists the element's own volume is
   * left wide open and levels are set inside the chain instead, so crossfades
   * don't depend on where the element's volume control sits relative to the
   * point the chain taps its output.
   */
  private setGain(el: HTMLAudioElement, v: number) {
    const gain = this.graph?.gains.get(el);
    if (gain) gain.gain.value = v;
    else el.volume = v;
  }

  /** The context suspends itself when the app is idle/hidden; playback through
   *  it would then be silent, so every start path wakes it first. */
  private wake() {
    const ctx = this.graph?.ctx;
    if (ctx && ctx.state !== "running") void ctx.resume();
  }

  /**
   * Build the chain and route both elements into it.
   *
   * Mid/side: mid = (L+R)/2 is what both ears share, side = (L−R)/2 is what
   * separates them. Rebuilding as mid ± side*width leaves anything centred
   * (vocals, bass) exactly where it was and pushes the rest further out. At
   * width 1 the two halves recombine into the original signal bit for bit,
   * which is what makes "off" free rather than a second code path.
   */
  private ensureGraph() {
    if (this.graph || this.graphFailed) return;
    try {
      const ctx = new AudioContext();

      // Both elements sum in here. Forcing stereo means a mono track still
      // reaches both ears (its side signal is zero, so widening correctly
      // leaves it alone) instead of collapsing into the left channel.
      const preSplit = ctx.createGain();
      preSplit.channelCount = 2;
      preSplit.channelCountMode = "explicit";
      preSplit.channelInterpretation = "speakers";

      const splitter = ctx.createChannelSplitter(2);
      const merger = ctx.createChannelMerger(2);
      const mid = ctx.createGain();
      const side = ctx.createGain();
      const sideInverted = ctx.createGain();
      side.gain.value = 1; // untouched until setWiden turns it up
      sideInverted.gain.value = -1;

      const halved = (sign: number) => {
        const g = ctx.createGain();
        g.gain.value = 0.5 * sign;
        return g;
      };
      const leftToMid = halved(1);
      const rightToMid = halved(1);
      const leftToSide = halved(1);
      const rightToSide = halved(-1);

      preSplit.connect(splitter);
      splitter.connect(leftToMid, 0);
      splitter.connect(rightToMid, 1);
      splitter.connect(leftToSide, 0);
      splitter.connect(rightToSide, 1);
      leftToMid.connect(mid);
      rightToMid.connect(mid);
      leftToSide.connect(side);
      rightToSide.connect(side);
      side.connect(sideInverted);
      mid.connect(merger, 0, 0);
      mid.connect(merger, 0, 1);
      side.connect(merger, 0, 0);
      sideInverted.connect(merger, 0, 1);
      merger.connect(ctx.destination);

      // Hangs off the output as a dead end — it is deliberately NOT connected
      // onward to the speakers, so it can only ever observe.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      // Some averaging happens here for free; the rest of the smoothing is
      // done where the readings are used, which needs the frame timing.
      analyser.smoothingTimeConstant = 0.55;
      analyser.minDecibels = -85;
      analyser.maxDecibels = -12;
      merger.connect(analyser);

      const gains = new Map<HTMLAudioElement, GainNode>();
      for (const el of this.els) {
        const source = ctx.createMediaElementSource(el);
        const gain = ctx.createGain();
        gain.gain.value = el.volume; // carry the current level across
        el.volume = 1;
        source.connect(gain);
        gain.connect(preSplit);
        gains.set(el, gain);
      }
      this.graph = { ctx, gains, side, analyser };
    } catch (error) {
      // Never surfaced through onError: that path treats a failure as a bad
      // track and skips it. Losing the effect must not cost you the song, and
      // the visualiser falls back to animating on a clock.
      this.graphFailed = true;
      console.error("audio processing chain unavailable:", error);
    }
  }

  /** The visualiser's listener, or null if the chain couldn't be built. */
  getAnalyser(): AnalyserNode | null {
    return this.graph?.analyser ?? null;
  }

  /** Turn stereo widening on or off. Applies to whatever is already playing;
   *  the ramp keeps the change from clicking. */
  setWiden(on: boolean) {
    if (on) this.ensureGraph();
    const g = this.graph;
    if (!g) return;
    this.wake();
    const now = g.ctx.currentTime;
    g.side.gain.cancelScheduledValues(now);
    g.side.gain.setValueAtTime(g.side.gain.value, now);
    g.side.gain.linearRampToValueAtTime(on ? WIDE_SIDE_GAIN : 1, now + WIDTH_RAMP_SEC);
  }

  private get activeEl() {
    return this.els[this.active];
  }
  private get idleEl() {
    return this.els[this.active === 0 ? 1 : 0];
  }

  init() {
    if (this.wired) return;
    this.wired = true;
    // Built up front rather than on demand: the visualiser's listener can only
    // be attached to an element once, before anything has played through it.
    this.ensureGraph();
    // Both elements are wired, but only the active one drives the store.
    for (const el of this.els) {
      const emitTime = () => {
        if (el === this.activeEl) this.onTime?.(el.currentTime, el.duration || 0);
      };
      el.addEventListener("timeupdate", emitTime);
      el.addEventListener("durationchange", emitTime);
      el.addEventListener("loadedmetadata", emitTime);
      el.addEventListener("ended", () => {
        if (el === this.activeEl && !this.crossfading) this.onEnded?.();
      });
      el.addEventListener("error", () => {
        if (el === this.activeEl) this.onError?.(el.error);
      });
    }
  }

  /** Play a track on the active element, replacing whatever was there. */
  async play(src: string) {
    this.stopFade();
    this.idleEl.pause();
    // A stale prime for a track that is no longer next must not be falsely
    // reused later; the idle src is harmlessly overwritten on the next prime.
    this.primedSrc = null;
    const el = this.activeEl;
    el.src = src;
    el.load();
    this.setGain(el, this.masterVolume);
    this.wake();
    await el.play();
  }

  /**
   * Pre-buffer `src` on the idle element so a later crossfadeTo / playPrimed
   * starts instantly. Does NOT play, does NOT touch the active element or any
   * in-flight fade. Safe to call repeatedly; a no-op if already primed with src.
   */
  prime(src: string) {
    // Never disturb the idle element while it is the OUTGOING/INCOMING side of a
    // running fade — both physical elements are in use during a crossfade.
    if (this.fade) return;
    if (this.primedSrc === src && this.idleEl.src) return; // already warm
    const el = this.idleEl;
    el.src = src;
    el.load();
    this.setGain(el, 0); // stays silent; crossfadeTo / playPrimed set the real volume
    this.primedSrc = src;
  }

  /**
   * Normal (non-crossfade) advance. If the idle element is already primed with
   * `src`, adopt it as active and play at full volume — no cold load. Otherwise
   * fall back to a regular play() on the active element.
   */
  async playPrimed(src: string) {
    if (this.primedSrc === src && this.idleEl.src) {
      this.stopFade();
      const oldActive = this.activeEl;
      oldActive.pause();
      try {
        oldActive.currentTime = 0;
      } catch {
        /* ignore */
      }
      this.active = this.active === 0 ? 1 : 0; // primed idle becomes active
      this.primedSrc = null;
      const el = this.activeEl; // now the formerly-idle, primed element
      this.setGain(el, this.masterVolume);
      this.wake();
      await el.play();
      // Snap the UI to the new element's time immediately.
      this.onTime?.(el.currentTime, el.duration || 0);
      return;
    }
    await this.play(src);
  }

  /** Forget any pre-buffered idle element (its track is no longer next). */
  clearPrime() {
    this.primedSrc = null;
    // Leave idleEl.src alone; it will be overwritten by the next prime/crossfade.
  }

  /**
   * Start `src` on the idle element and crossfade the two over `durationMs`.
   * When the overlap finishes the elements swap roles and `onDone` fires so the
   * store can officially advance to the next track.
   */
  async crossfadeTo(src: string, durationMs: number, onDone: () => void) {
    this.stopFade();
    const outEl = this.activeEl;
    const inEl = this.idleEl;
    if (this.primedSrc === src && inEl.src) {
      // Idle element already primed with this exact URL — reuse the warm buffer.
    } else {
      inEl.src = src;
      inEl.load();
    }
    this.setGain(inEl, 0);
    this.primedSrc = null; // it's being consumed by the fade now
    this.crossfading = true;
    this.wake();
    try {
      await inEl.play();
    } catch {
      // Couldn't start the next track — abandon the fade and let the normal
      // end-of-track path take over instead.
      this.crossfading = false;
      return false;
    }
    this.fade = {
      outEl,
      inEl,
      durationMs,
      elapsed: 0,
      lastTs: null,
      timer: null,
      done: () => {
        outEl.pause();
        try {
          outEl.currentTime = 0;
        } catch {
          /* some sources disallow seeking; harmless */
        }
        this.active = this.active === 0 ? 1 : 0; // inEl is now active
        this.setGain(inEl, this.masterVolume);
        this.crossfading = false;
        this.fade = undefined;
        onDone();
        // Push the new track's time/duration immediately for a snappy UI.
        this.onTime?.(inEl.currentTime, inEl.duration || 0);
      },
    };
    this.startFadeClock();
    return true;
  }

  /**
   * The ramp runs on a wall-clock setInterval, NOT requestAnimationFrame:
   * WebView2 suspends rAF while the window is hidden/minimized, which would
   * freeze the fade with the incoming track stuck near volume 0.
   */
  private startFadeClock() {
    const f = this.fade;
    if (!f || f.timer != null) return;
    f.lastTs = null;
    f.timer = window.setInterval(this.fadeTick, FADE_TICK_MS);
  }

  private fadeTick = () => {
    const f = this.fade;
    if (!f) return;
    const now = performance.now();
    if (f.lastTs == null) f.lastTs = now;
    f.elapsed += now - f.lastTs;
    f.lastTs = now;
    const p = f.durationMs <= 0 ? 1 : Math.min(1, f.elapsed / f.durationMs);
    // Equal-power curve keeps perceived loudness roughly steady through the mix.
    this.setGain(f.outEl, this.masterVolume * Math.cos((p * Math.PI) / 2));
    this.setGain(f.inEl, this.masterVolume * Math.sin((p * Math.PI) / 2));
    if (p >= 1) {
      if (f.timer != null) {
        clearInterval(f.timer);
        f.timer = null;
      }
      f.done();
    }
  };

  /** Drop any in-flight fade without swapping elements. */
  private stopFade() {
    const f = this.fade;
    if (!f) return;
    if (f.timer != null) clearInterval(f.timer);
    this.fade = undefined;
    this.crossfading = false;
  }

  /** True while two tracks are overlapping in a crossfade. */
  get isCrossfading() {
    return this.fade != null;
  }

  /** True once the audible track has played through to its end. */
  get activeEnded() {
    return this.activeEl.ended;
  }

  /**
   * Abort an in-flight crossfade and stay on the outgoing (still-active) track
   * at full volume — used when the user seeks or hits Previous mid-fade.
   */
  cancelCrossfade() {
    const f = this.fade;
    if (!f) return;
    this.stopFade();
    f.inEl.pause();
    try {
      f.inEl.currentTime = 0;
    } catch {
      /* ignore */
    }
    this.setGain(this.activeEl, this.masterVolume);
  }

  resume() {
    this.wake();
    if (this.fade) {
      void this.fade.outEl.play();
      void this.fade.inEl.play();
      this.startFadeClock(); // lastTs resets, so paused time isn't counted
      return Promise.resolve();
    }
    return this.activeEl.play();
  }
  pause() {
    const f = this.fade;
    if (f?.timer != null) {
      clearInterval(f.timer);
      f.timer = null;
      f.lastTs = null;
    }
    this.els[0].pause();
    this.els[1].pause();
  }
  seek(sec: number) {
    if (isFinite(sec)) this.activeEl.currentTime = sec;
  }
  setVolume(v: number) {
    this.masterVolume = Math.max(0, Math.min(1, v));
    // During a fade, fadeTick re-applies volume each frame.
    if (!this.fade) this.setGain(this.activeEl, this.masterVolume);
  }
}

export const audio = new AudioController();
