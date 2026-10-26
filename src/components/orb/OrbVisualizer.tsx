/**
 * The Home screen's orb: owns the drawing surface, feeds it the sound and the
 * cover art, and — just as importantly — knows when to stop drawing.
 *
 * If the machine can't do 3D at all, the old record renders in its place. That
 * fallback is the only reason the record's styling still exists.
 */
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { audio } from "../../lib/audio";
import { LevelMeter } from "../../lib/audioLevels";
import { FALLBACK_COLOR, loadCover } from "../../lib/coverColor";
import { createOrbScene, type OrbScene } from "./scene";
import RecordFallback from "./RecordFallback";
import "./Orb.css";

/** Layout size of the orb — near enough the record it replaces. */
const STAGE_PX = 260;
/** The drawing surface overhangs the layout box on every side, so the rays,
 *  particles and glow have somewhere to go without pushing the page around.
 *  The hero's top padding is set to clear this — see HomeView.css. */
const OVERHANG_PX = 80;

/** Seconds to reach full life on play, and to settle to a stop on pause. */
const RISE_SEC = 0.25;
const SETTLE_SEC = 0.45;
/** Below this, nothing on screen would change again — time to stop asking for
 *  frames. */
const STILL = 0.004;
/** A single hitch (a slow load, a restored window) must not make the orb lurch
 *  forward by however long it was away. */
const MAX_STEP_SEC = 0.05;
/** Move further than this while pressing and it was a drag, not a click — so
 *  spinning the orb by hand never accidentally pauses the music. */
const DRAG_SLOP_PX = 5;

type Props = {
  thumbnail?: string | null;
  isPlaying: boolean;
  hasTrack: boolean;
  title: string;
  onClick: () => void;
};

export default function OrbVisualizer({
  thumbnail,
  isPlaying,
  hasTrack,
  title,
  onClick,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const sceneRef = useRef<OrbScene | null>(null);
  const [supported, setSupported] = useState(true);

  // Read every frame, so the loop always sees the latest without being torn
  // down and rebuilt each time playback changes.
  const targets = useRef({ energy: 0, dim: 0.25 });
  const frame = useRef<number | null>(null);
  const kick = useRef<() => void>(() => {});

  /* ——— the scene and its frame loop ——— */
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // The drawing surface is created here rather than by React on purpose. A
    // surface can only ever hold one 3D context, and releasing it is permanent
    // — so reusing an element that has already been torn down leaves a dead
    // surface that can never draw again. Making a fresh one per mount is the
    // only way tearing down and rebuilding stays reliable.
    const canvas = document.createElement("canvas");
    canvas.className = "orb-canvas";
    canvas.style.inset = `${-OVERHANG_PX}px`;
    canvas.setAttribute("aria-hidden", "true");
    host.prepend(canvas);

    let scene: OrbScene;
    try {
      scene = createOrbScene(canvas);
    } catch (error) {
      console.error("3D orb unavailable, falling back to the record:", error);
      canvas.remove();
      setSupported(false);
      return;
    }
    sceneRef.current = scene;
    scene.setSize(STAGE_PX + OVERHANG_PX * 2);

    let meter: LevelMeter | null = null;
    let energy = 0;
    let dim = targets.current.dim;
    let last = 0;
    // Only used when the sound can't be read — keeps the orb moving instead of
    // sitting there dead.
    let fakeClock = 0;
    let fakeBeatHeld = false;

    const ease = (from: number, to: number, dt: number, tau: number) =>
      tau <= 0 ? to : from + (to - from) * (1 - Math.exp(-dt / tau));

    const tick = (now: number) => {
      frame.current = null;
      const dt = last ? Math.min((now - last) / 1000, MAX_STEP_SEC) : 1 / 60;
      last = now;

      const target = targets.current;
      energy = ease(energy, target.energy, dt, target.energy > energy ? RISE_SEC : SETTLE_SEC);
      dim = ease(dim, target.dim, dt, 0.4);

      if (!meter) {
        const analyser = audio.getAnalyser();
        if (analyser) meter = new LevelMeter(analyser);
      }

      let level = 0;
      let bass = 0;
      let hit = 0;
      let beat = false;
      if (meter) {
        const levels = target.energy > 0 ? meter.read(dt) : meter.decay(dt);
        level = levels.level;
        bass = levels.bass;
        hit = levels.hit;
        beat = levels.beat;
      } else if (target.energy > 0) {
        // No reading of the sound available — keep it moving on a clock, with
        // a steady pulse standing in for the beat.
        fakeClock += dt;
        level = 0.34 + Math.sin(fakeClock * 1.1) * 0.12;
        bass = 0.26 + Math.sin(fakeClock * 1.9 + 1.2) * 0.16;
        hit = Math.max(0, Math.sin(fakeClock * 3.2)) ** 6;
        beat = hit > 0.98 && !fakeBeatHeld;
        fakeBeatHeld = hit > 0.5;
      }

      const settled =
        target.energy === 0 &&
        energy < STILL &&
        level < STILL &&
        bass < STILL &&
        hit < STILL &&
        Math.abs(dim - target.dim) < STILL &&
        // A paused orb that has just been spun by hand still has a flick to
        // glide out and a tilt to level off.
        !scene.isSettling();

      if (settled) {
        // Land exactly on the resting values so the held frame is the one the
        // scene would draw at a dead stop — no half-swollen surface or
        // half-squeezed orb frozen in place.
        scene.update(dt, {
          level: 0,
          bass: 0,
          hit: 0,
          beat: false,
          energy: 0,
          dim: target.dim,
        });
        return;
      }

      scene.update(dt, { level, bass, hit, beat, energy, dim });
      frame.current = requestAnimationFrame(tick);
    };

    const start = () => {
      if (frame.current != null || document.hidden) return;
      last = 0; // time away must not count as elapsed
      frame.current = requestAnimationFrame(tick);
    };
    kick.current = start;

    const stop = () => {
      if (frame.current != null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };

    // A hidden window gets no frames anyway; stopping explicitly means the
    // orb doesn't spend the first moments back catching up.
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);

    start();

    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      stopWatching.current();
      stop();
      kick.current = () => {};
      sceneRef.current = null;
      scene.dispose();
      canvas.remove();
    };
  }, []);

  /* ——— cover art ——— */
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    let stale = false;

    if (!thumbnail) {
      scene.setCover(null);
      scene.setColor(FALLBACK_COLOR);
      kick.current();
      return;
    }

    void loadCover(thumbnail)
      .then((cover) => {
        if (stale) return;
        scene.setCover(cover.image);
        scene.setColor(cover.color);
        kick.current();
      })
      .catch(() => {
        if (stale) return;
        // A cover that won't load costs the picture, never the orb.
        scene.setCover(null);
        scene.setColor(FALLBACK_COLOR);
        kick.current();
      });

    return () => {
      stale = true;
    };
  }, [thumbnail]);

  /* ——— playback state, and waking the loop to act on it ——— */
  useEffect(() => {
    targets.current = {
      energy: isPlaying ? 1 : 0,
      dim: !hasTrack ? 0.25 : isPlaying ? 1 : 0.55,
    };
    kick.current();
  }, [isPlaying, hasTrack]);

  /* ——— spinning it by hand ——— */

  const grab = useRef({ active: false, moved: 0, x: 0, y: 0 });
  /** Removes the in-flight drag listeners. Held so the drag can be torn down
   *  from anywhere — including the component unmounting mid-throw. */
  const stopWatching = useRef<() => void>(() => {});

  function onPointerDown(e: ReactPointerEvent<HTMLButtonElement>) {
    if (e.button !== 0 || !sceneRef.current) return;
    grab.current = { active: true, moved: 0, x: e.clientX, y: e.clientY };
    sceneRef.current.setDragging(true);
    kick.current();

    // Watched on the window rather than on the orb itself. A throw naturally
    // carries the pointer off the edge of the circle, and anything listening
    // only on the orb stops hearing about the movement at exactly the moment
    // that decides how hard the throw was — so the orb would come to a dead
    // stop on release instead of gliding.
    const onMove = (ev: PointerEvent) => {
      const g = grab.current;
      if (!g.active || !sceneRef.current) return;
      const dx = ev.clientX - g.x;
      const dy = ev.clientY - g.y;
      g.x = ev.clientX;
      g.y = ev.clientY;
      g.moved += Math.abs(dx) + Math.abs(dy);
      sceneRef.current.drag(dx, dy);
    };
    const onUp = () => {
      grab.current.active = false;
      sceneRef.current?.setDragging(false);
      stopWatching.current();
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    stopWatching.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      stopWatching.current = () => {};
    };
  }

  function handleClick() {
    // A click that came at the end of a drag is the release of a throw, not a
    // request to pause. The counter is left alone so keyboard presses — which
    // never move — always come through.
    if (grab.current.moved > DRAG_SLOP_PX) {
      grab.current.moved = 0;
      return;
    }
    onClick();
  }

  if (!supported) return <RecordFallback thumbnail={thumbnail} onClick={onClick} title={title} />;

  return (
    <div
      className="orb-stage"
      ref={hostRef}
      style={{ width: STAGE_PX, height: STAGE_PX }}
    >
      <button
        className="orb-hit"
        onClick={handleClick}
        onPointerDown={onPointerDown}
        title={`${title} — drag to spin it`}
      />
    </div>
  );
}
