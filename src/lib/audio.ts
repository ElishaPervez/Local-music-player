/** How often the crossfade ramp re-applies volumes (~20 updates/sec). */
const FADE_TICK_MS = 50;

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
  private fade?: {
    outEl: HTMLAudioElement;
    inEl: HTMLAudioElement;
    durationMs: number;
    elapsed: number;
    lastTs: number | null;
    timer: number | null;
    done: () => void;
  };

  onEnded?: () => void;
  onTime?: (current: number, duration: number) => void;
  onError?: (e: unknown) => void;
  private wired = false;

  constructor() {
    this.els = [new Audio(), new Audio()];
    for (const el of this.els) el.preload = "auto";
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
    const el = this.activeEl;
    el.src = src;
    el.load();
    el.volume = this.masterVolume;
    await el.play();
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
    inEl.src = src;
    inEl.load();
    inEl.volume = 0;
    this.crossfading = true;
    try {
      await inEl.play();
    } catch {
      // Couldn't start the next track — abandon the fade and let the normal
      // end-of-track path take over instead.
      this.crossfading = false;
      return;
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
        inEl.volume = this.masterVolume;
        this.crossfading = false;
        this.fade = undefined;
        onDone();
        // Push the new track's time/duration immediately for a snappy UI.
        this.onTime?.(inEl.currentTime, inEl.duration || 0);
      },
    };
    this.startFadeClock();
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
    f.outEl.volume = this.masterVolume * Math.cos((p * Math.PI) / 2);
    f.inEl.volume = this.masterVolume * Math.sin((p * Math.PI) / 2);
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
    this.activeEl.volume = this.masterVolume;
  }

  resume() {
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
    if (!this.fade) this.activeEl.volume = this.masterVolume;
  }
}

export const audio = new AudioController();
