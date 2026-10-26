/**
 * The orb itself: a sphere wearing the album cover under a glass shell, with
 * particles orbiting it and a soft glow behind.
 *
 * Deliberately free of React — it owns nothing but a drawing surface and knows
 * nothing about tracks, playback or stores. Everything that changes over time
 * arrives through `update`, which makes the whole thing possible to reason
 * about on its own.
 *
 * One rule runs through all of it: every kind of motion is multiplied by
 * `energy`. At energy 0 the sphere is perfectly round and still, the particles
 * hang where they are and the highlight stops sliding — so the caller can stop
 * asking for frames entirely and the last one drawn still looks deliberate.
 */
import * as THREE from "three";
import { stepSpring } from "../../lib/audioLevels";
import {
  HAND_SPIN_AT_REST,
  handSpinIsSettling,
  stepHandSpin,
} from "./handSpin";

/** Design size of the drawing surface. Sizes tuned against this, then scaled. */
const REFERENCE_PX = 420;
/** How far back the camera sits. Together with the field of view this leaves
 *  the sphere about three fifths as wide as the surface, so the particles have
 *  somewhere to orbit and the rays have somewhere to reach. */
const CAMERA_Z = 4.21;
const FIELD_OF_VIEW = 42;
const PARTICLE_COUNT = 600;
/** Seconds for one full turn while playing. */
const SPIN_PERIOD_SEC = 12;

/** The punch on a beat. Stiffness is how hard it snaps back, damping how fast
 *  the wobble dies; the impulse is how hard each beat shoves it inward. */
const PUNCH_STIFFNESS = 190;
const PUNCH_DAMPING = 15;
const PUNCH_IMPULSE = 1.15;
/** Hard limit on the squeeze, so a run of heavy beats can't collapse it. */
const PUNCH_LIMIT = 0.13;


export type OrbInputs = {
  /** Overall loudness, 0–1. */
  level: number;
  /** Low-end energy, 0–1. Drives the swell of the surface. */
  bass: number;
  /** 1 the instant a beat lands, fading over a fraction of a second. Flares
   *  the rays. */
  hit: number;
  /** True on the single frame a beat is detected. Shoves the orb inward. */
  beat: boolean;
  /** How alive it is: 1 while playing, easing to 0 once paused. */
  energy: number;
  /** Overall brightness: full while playing, lower at rest, lowest with no
   *  track loaded at all. */
  dim: number;
};

export type OrbScene = {
  /** Match the drawing surface to a new on-screen size, in CSS pixels. */
  setSize(cssPx: number): void;
  /** Whether a hand is currently on the orb. While it is, the steady spin
   *  stops and the orb follows the pointer instead. */
  setDragging(on: boolean): void;
  /** Turn the orb by hand. Distances are in screen pixels moved. */
  drag(dxPx: number, dyPx: number): void;
  /** True while a flick is still gliding, a tip is still levelling, or the
   *  steady spin is still fading back in — all reasons to keep drawing even
   *  when the music is paused. */
  isSettling(): boolean;
  /** Wrap a square image around the sphere, or strip it back to bare colour. */
  setCover(image: HTMLCanvasElement | null): void;
  /** The colour the glow, rim light and particles take. Channels 0–255. */
  setColor(rgb: [number, number, number]): void;
  /** Advance everything by `dtSec` and draw one frame. */
  update(dtSec: number, inputs: OrbInputs): void;
  /** Release the graphics memory. Nothing may be called afterwards. */
  dispose(): void;
};

/* ————————————————————————— shader building blocks ————————————————————————— */

/**
 * Standard simplex noise (Ashima Arts / Stefan Gustavson, MIT). Produces a
 * smooth, non-repeating value for any point in space, which is what gives the
 * sphere's surface an organic swell instead of a regular ripple.
 */
const NOISE_GLSL = /* glsl */ `
vec3 mod289(vec3 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 mod289(vec4 x){ return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 permute(vec4 x){ return mod289(((x * 34.0) + 1.0) * x); }
vec4 taylorInvSqrt(vec4 r){ return 1.79284291400159 - 0.85373472095314 * r; }

float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i  = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = mod289(i);
  vec4 p = permute(permute(permute(
             i.z + vec4(0.0, i1.z, i2.z, 1.0))
           + i.y + vec4(0.0, i1.y, i2.y, 1.0))
           + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = taylorInvSqrt(vec4(dot(p0,p0), dot(p1,p1), dot(p2,p2), dot(p3,p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0,x0), dot(x1,x1), dot(x2,x2), dot(x3,x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0,x0), dot(p1,x1), dot(p2,x2), dot(p3,x3)));
}
`;

/* ————————————————————————————————— build ————————————————————————————————— */

export function createOrbScene(canvas: HTMLCanvasElement): OrbScene {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "low-power",
  });
  // Nothing is converted on the way in or out, so the cover art comes back out
  // of the screen looking exactly like the file — no washed-out or crushed
  // colours to explain away.
  renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(FIELD_OF_VIEW, 1, 0.1, 40);
  camera.position.z = CAMERA_Z;

  const color = new THREE.Color(0.486, 0.36, 1.0); // the app's purple

  /* ——— the sphere wearing the cover ——— */

  const artUniforms = {
    uTime: { value: 0 },
    uBass: { value: 0 },
    uLevel: { value: 0 },
    uEnergy: { value: 0 },
    uDim: { value: 0 },
    uColor: { value: color },
    uMap: { value: null as THREE.Texture | null },
    uHasMap: { value: 0 },
  };

  const artGeometry = new THREE.SphereGeometry(1, 96, 64);
  const artMaterial = new THREE.ShaderMaterial({
    uniforms: artUniforms,
    vertexShader: /* glsl */ `
      ${NOISE_GLSL}
      uniform float uTime;
      uniform float uBass;
      uniform float uEnergy;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vSwell;

      void main() {
        vUv = uv;
        vNormal = normalize(normalMatrix * normal);

        // Two scales of noise: a slow broad swell with finer detail riding on
        // top, so the surface never settles into an obvious pattern.
        float broad = snoise(position * 1.7 + vec3(0.0, uTime * 0.30, 0.0));
        float fine  = snoise(position * 4.1 - vec3(uTime * 0.20));
        float swell = broad * 0.75 + fine * 0.25;
        vSwell = swell;

        // Kept small on purpose: push it much further and the artwork starts
        // to smear instead of reading as a picture.
        float amount = (0.010 + uBass * 0.080) * uEnergy;
        vec3 displaced = position + normal * swell * amount;

        vec4 mv = modelViewMatrix * vec4(displaced, 1.0);
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uLevel;
      uniform float uEnergy;
      uniform float uDim;
      uniform vec3 uColor;
      uniform sampler2D uMap;
      uniform float uHasMap;
      varying vec2 vUv;
      varying vec3 vNormal;
      varying vec3 vView;
      varying float vSwell;

      void main() {
        // With no cover, the sphere falls back to a deep gradient of the
        // app's own colour rather than showing nothing.
        vec3 base = uHasMap > 0.5
          ? texture2D(uMap, vUv).rgb
          : mix(uColor * 0.16, uColor * 0.55, vUv.y);

        vec3 N = normalize(vNormal);
        vec3 V = normalize(vView);
        vec3 L = normalize(vec3(-0.45, 0.72, 0.85));

        float lit = 0.42 + 0.58 * max(dot(N, L), 0.0);
        // The vertex displacement doesn't change the surface direction, so
        // parts pushed outward are brightened by hand instead. Without this
        // the swell is invisible on a busy cover.
        lit *= 1.0 + vSwell * 0.22 * uEnergy;

        // Edge-on parts of a sphere catch the most light — this is what stops
        // it reading as a flat circle.
        float rim = pow(1.0 - max(dot(N, V), 0.0), 2.6);

        vec3 col = base * lit;
        col += uColor * rim * (0.30 + uLevel * 0.55);
        gl_FragColor = vec4(col * uDim, 1.0);
      }
    `,
  });
  const artMesh = new THREE.Mesh(artGeometry, artMaterial);

  // The sphere and its glass shell are punched inward together on a beat, so
  // they live in one group that gets scaled as a unit. The rays and the glow
  // stay put — they belong to the space around the orb, not to the orb.
  const body = new THREE.Group();
  body.add(artMesh);
  scene.add(body);

  /* ——— the glass shell ——— */

  const shellUniforms = {
    uTime: { value: 0 },
    uLevel: { value: 0 },
    uHit: { value: 0 },
    uDim: { value: 0 },
    uColor: { value: color },
  };

  const shellGeometry = new THREE.SphereGeometry(1.045, 64, 48);
  const shellMaterial = new THREE.ShaderMaterial({
    uniforms: shellUniforms,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec3 vNormal;
      varying vec3 vView;
      void main() {
        vNormal = normalize(normalMatrix * normal);
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vView = -mv.xyz;
        gl_Position = projectionMatrix * mv;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uLevel;
      uniform float uHit;
      uniform float uDim;
      uniform vec3 uColor;
      varying vec3 vNormal;
      varying vec3 vView;

      void main() {
        vec3 N = normalize(vNormal);
        vec3 V = normalize(vView);

        float rim = pow(1.0 - max(dot(N, V), 0.0), 3.2);

        // A tight bright spot that drifts around the shell. The shell is not
        // attached to the spinning sphere, so this reads as light in the room
        // rather than a mark painted on the surface.
        vec3 lightDir = normalize(vec3(sin(uTime * 0.33) * 0.85, 0.5, cos(uTime * 0.33) * 0.85 + 0.6));
        float spot = pow(max(dot(N, lightDir), 0.0), 26.0);

        // The edge lights up on every beat, so the punch reads even on a
        // cover so busy that the change in size is hard to see.
        float alpha = rim * (0.30 + uLevel * 0.35 + uHit * 0.55) + spot * 0.55;
        vec3 col = mix(uColor, vec3(1.0), 0.35 + uHit * 0.25) * (0.6 + spot);
        gl_FragColor = vec4(col, alpha * uDim);
      }
    `,
  });
  const shellMesh = new THREE.Mesh(shellGeometry, shellMaterial);
  body.add(shellMesh);

  /* ——— the particles ——— */

  const particleUniforms = {
    uSpin: { value: 0 },
    uBass: { value: 0 },
    uEnergy: { value: 0 },
    uDim: { value: 0 },
    uColor: { value: color },
    uSizeScale: { value: 1 },
  };

  const particleGeometry = buildParticles();
  const particleMaterial = new THREE.ShaderMaterial({
    uniforms: particleUniforms,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexShader: /* glsl */ `
      uniform float uSpin;
      uniform float uBass;
      uniform float uEnergy;
      uniform float uSizeScale;
      attribute float aRadius;
      attribute float aPhase;
      attribute float aSpeed;
      attribute float aTilt;
      attribute float aAxis;
      attribute float aSize;
      varying float vFade;

      vec3 rotateX(vec3 p, float a) {
        float s = sin(a), c = cos(a);
        return vec3(p.x, p.y * c - p.z * s, p.y * s + p.z * c);
      }
      vec3 rotateY(vec3 p, float a) {
        float s = sin(a), c = cos(a);
        return vec3(p.x * c + p.z * s, p.y, -p.x * s + p.z * c);
      }

      void main() {
        // The angle comes from an accumulated spin rather than raw elapsed
        // time, so slowing to a stop never makes them jump backwards.
        float angle = aPhase + uSpin * aSpeed;

        // Loud moments push them outward; at rest they draw in close and hang
        // there, which is what makes a paused orb look settled.
        float radius = aRadius * (0.68 + 0.32 * uEnergy) + uBass * 0.22 * uEnergy;

        vec3 orbit = vec3(cos(angle), 0.0, sin(angle)) * radius;
        orbit = rotateX(orbit, aTilt);
        orbit = rotateY(orbit, aAxis);

        vec4 mv = modelViewMatrix * vec4(orbit, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = aSize * uSizeScale * (3.6 / max(-mv.z, 0.1));

        // Fade out anything drifting toward the edge of the drawing surface,
        // so particles dissolve instead of being sliced off by a hard square
        // boundary you'd otherwise see.
        vec2 ndc = gl_Position.xy / max(gl_Position.w, 0.0001);
        vFade = 1.0 - smoothstep(0.62, 0.98, length(ndc));
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      uniform float uDim;
      varying float vFade;

      void main() {
        // Square points, drawn as soft round dots.
        float d = length(gl_PointCoord - 0.5);
        float dot_ = smoothstep(0.5, 0.08, d);
        gl_FragColor = vec4(uColor, dot_ * vFade * uDim * 0.85);
      }
    `,
  });
  const particles = new THREE.Points(particleGeometry, particleMaterial);
  scene.add(particles);

  /* ——— the rays ——— */

  const rayUniforms = {
    uTime: { value: 0 },
    uLevel: { value: 0 },
    uHit: { value: 0 },
    uEnergy: { value: 0 },
    uDim: { value: 0 },
    uColor: { value: color },
  };

  // Sits just behind the orb, so the sphere blocks the middle of it and the
  // rays appear to come out from behind the silhouette rather than lying on
  // top of the artwork.
  const rayGeometry = new THREE.PlaneGeometry(8, 8);
  const rayMaterial = new THREE.ShaderMaterial({
    uniforms: rayUniforms,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uTime;
      uniform float uLevel;
      uniform float uHit;
      uniform float uEnergy;
      uniform float uDim;
      uniform vec3 uColor;
      varying vec2 vUv;

      void main() {
        vec2 p = (vUv - 0.5) * 2.0;
        // Back into the same units the sphere is measured in, where the orb's
        // edge is exactly 1 — so the numbers below mean something.
        float R = length(p) * 4.0;
        float angle = atan(p.y, p.x);
        // How far out from the orb's edge this pixel is. Everything about a
        // ray is a function of this.
        float out_ = R - 1.0;

        // Rays taper to points as they travel. Sharpening the spokes with
        // distance is what makes them read as light thrown outward rather than
        // as bars laid on top of the picture.
        float taper = 1.0 + out_ * 3.4;

        // Three sets of spokes at counts that don't divide into each other,
        // drifting at different speeds. Overlapping like that is what stops it
        // looking like a clean star and makes it churn instead.
        float spokes =
            pow(abs(sin(angle *  7.0 + uTime * 0.28)), 13.0 * taper)
          + pow(abs(sin(angle * 11.0 - uTime * 0.17 + 1.7)), 21.0 * taper) * 0.70
          + pow(abs(sin(angle * 17.0 + uTime * 0.41 + 3.1)), 29.0 * taper) * 0.45;
        // A dim haze under the sharp spokes, so they sit in their own light
        // instead of reading as bare lines scratched on black.
        float haze = pow(abs(sin(angle * 7.0 + uTime * 0.28)), 4.0 * taper) * 0.14;

        // Brightness dies away with distance rather than stopping at a set
        // length: a ray that simply ended would show a flat cut across its tip.
        // A beat carries the light further out.
        float carry = 0.20 + uHit * 0.13 + uLevel * 0.04;
        float along = exp(-max(out_, 0.0) / carry) * smoothstep(0.0, 0.05, out_);

        // Hard guarantee that nothing is still lit by the time it reaches the
        // edge of the drawing surface. Without this, a beat throws the rays
        // past the boundary and they get sliced off in a straight line.
        float guard = 1.0 - smoothstep(0.24, 0.62, out_);

        float alpha = (spokes + haze) * along * guard
                    * (0.34 + uHit * 1.10 + uLevel * 0.24) * uEnergy * uDim;
        gl_FragColor = vec4(mix(uColor, vec3(1.0), 0.25 + uHit * 0.30), alpha);
      }
    `,
  });
  const rays = new THREE.Mesh(rayGeometry, rayMaterial);
  rays.position.z = -0.25;
  scene.add(rays);

  /* ——— the glow behind ——— */

  const glowUniforms = {
    uLevel: { value: 0 },
    uDim: { value: 0 },
    uColor: { value: color },
  };

  const glowGeometry = new THREE.PlaneGeometry(7, 7);
  const glowMaterial = new THREE.ShaderMaterial({
    uniforms: glowUniforms,
    transparent: true,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform float uLevel;
      uniform float uDim;
      uniform vec3 uColor;
      varying vec2 vUv;
      void main() {
        float d = length(vUv - 0.5) * 2.0;
        float falloff = pow(max(1.0 - d, 0.0), 2.6);
        gl_FragColor = vec4(uColor, falloff * (0.22 + uLevel * 0.40) * uDim);
      }
    `,
  });
  const glow = new THREE.Mesh(glowGeometry, glowMaterial);
  glow.position.z = -1.4;
  scene.add(glow);

  /* ——————————————————————————— running state ——————————————————————————— */

  let coverTexture: THREE.Texture | null = null;
  /** Accumulated, not elapsed: advancing it by less each frame is how the
   *  whole scene coasts to a halt without anything snapping. */
  let clock = 0;
  let spin = 0;
  let cssSize = REFERENCE_PX;
  let disposed = false;
  /** How far the orb is squeezed in from its resting size, and how fast that
   *  is changing. Beats shove this inward; the spring brings it back. */
  let punch = 0;
  let punchVelocity = 0;

  /** Hand-turning, kept separate from the steady spin and simply added to it,
   *  so neither has to know about the other. */
  let dragging = false;
  let hand = HAND_SPIN_AT_REST;
  /** Drag distance collected since the last frame was drawn. */
  let pendingX = 0;
  let pendingY = 0;

  function setSize(px: number) {
    cssSize = Math.max(1, Math.round(px));
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    renderer.setPixelRatio(ratio);
    // Lets three size the element itself: the surface holds more pixels than
    // it occupies on a high-density screen, and only three knows both numbers.
    renderer.setSize(cssSize, cssSize, true);
    particleUniforms.uSizeScale.value = ratio * (cssSize / REFERENCE_PX);
  }

  setSize(REFERENCE_PX);

  return {
    setSize,

    setDragging(on) {
      dragging = on;
      if (on) {
        // Taking hold kills any leftover glide and forgets the last drag, so
        // the orb is under your control the instant you touch it rather than
        // fighting you or inheriting a throw from a minute ago.
        hand = { ...hand, fling: 0, recent: [] };
        pendingX = 0;
        pendingY = 0;
      }
    },

    drag(dxPx, dyPx) {
      pendingX += dxPx;
      pendingY += dyPx;
    },

    isSettling() {
      return handSpinIsSettling(hand, dragging);
    },

    setCover(image) {
      coverTexture?.dispose();
      coverTexture = null;
      if (image) {
        coverTexture = new THREE.CanvasTexture(image);
        coverTexture.colorSpace = THREE.NoColorSpace;
        coverTexture.anisotropy = renderer.capabilities.getMaxAnisotropy();
        coverTexture.needsUpdate = true;
      }
      artUniforms.uMap.value = coverTexture;
      artUniforms.uHasMap.value = coverTexture ? 1 : 0;
    },

    setColor([r, g, b]) {
      // One shared colour object, so every part of the orb agrees.
      color.setRGB(r / 255, g / 255, b / 255);
    },

    update(dtSec, { level, bass, hit, beat, energy, dim }) {
      if (disposed) return;

      hand = stepHandSpin(hand, dtSec, { dragging, dx: pendingX, dy: pendingY });
      pendingX = 0;
      pendingY = 0;

      clock += dtSec * energy;
      spin += dtSec * energy * hand.spinBlend;
      artMesh.rotation.y = (spin / SPIN_PERIOD_SEC) * Math.PI * 2 + hand.yaw;
      artMesh.rotation.x = hand.tilt;

      if (beat) punchVelocity -= PUNCH_IMPULSE;
      ({ offset: punch, velocity: punchVelocity } = stepSpring(
        punch,
        punchVelocity,
        dtSec,
        PUNCH_STIFFNESS,
        PUNCH_DAMPING,
      ));
      punch = Math.max(-PUNCH_LIMIT, Math.min(PUNCH_LIMIT, punch));
      // Faded out by energy, so a stopped orb is always exactly its resting
      // size — it can never freeze mid-squeeze.
      body.scale.setScalar(1 + punch * energy);

      artUniforms.uTime.value = clock;
      artUniforms.uBass.value = bass;
      artUniforms.uLevel.value = level;
      artUniforms.uEnergy.value = energy;
      artUniforms.uDim.value = dim;

      shellUniforms.uTime.value = clock;
      shellUniforms.uLevel.value = level;
      shellUniforms.uHit.value = hit;
      shellUniforms.uDim.value = dim;

      rayUniforms.uTime.value = clock;
      rayUniforms.uLevel.value = level;
      rayUniforms.uHit.value = hit;
      rayUniforms.uEnergy.value = energy;
      rayUniforms.uDim.value = dim;

      particleUniforms.uSpin.value = spin;
      particleUniforms.uBass.value = bass;
      particleUniforms.uEnergy.value = energy;
      particleUniforms.uDim.value = dim;

      glowUniforms.uLevel.value = level;
      glowUniforms.uDim.value = dim;

      renderer.render(scene, camera);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      coverTexture?.dispose();
      artGeometry.dispose();
      artMaterial.dispose();
      shellGeometry.dispose();
      shellMaterial.dispose();
      particleGeometry.dispose();
      particleMaterial.dispose();
      rayGeometry.dispose();
      rayMaterial.dispose();
      glowGeometry.dispose();
      glowMaterial.dispose();
      renderer.dispose();
      // Hands the graphics memory back immediately rather than whenever the
      // browser next gets round to it — this runs every time you leave Home.
      renderer.forceContextLoss();
    },
  };
}

/**
 * Scatter the particles onto tilted circular orbits.
 *
 * Each one gets its own radius, tilt, starting point and speed, so they never
 * fall into visible rings — the arrangement has to look like a cloud that
 * happens to circle, not a set of tracks.
 */
function buildParticles(): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  const positions = new Float32Array(PARTICLE_COUNT * 3); // filled in by the shader
  const radius = new Float32Array(PARTICLE_COUNT);
  const phase = new Float32Array(PARTICLE_COUNT);
  const speed = new Float32Array(PARTICLE_COUNT);
  const tilt = new Float32Array(PARTICLE_COUNT);
  const axis = new Float32Array(PARTICLE_COUNT);
  const size = new Float32Array(PARTICLE_COUNT);

  for (let i = 0; i < PARTICLE_COUNT; i++) {
    // Square-rooted so they don't bunch up against the sphere: without it,
    // evenly spread numbers put far more of them near the inner edge.
    radius[i] = 1.14 + Math.sqrt(Math.random()) * 0.52;
    phase[i] = Math.random() * Math.PI * 2;
    // Mixed directions, so the cloud swirls rather than marching in step.
    speed[i] = (0.10 + Math.random() * 0.26) * (Math.random() < 0.28 ? -1 : 1);
    tilt[i] = Math.random() * Math.PI;
    axis[i] = Math.random() * Math.PI * 2;
    size[i] = 1.6 + Math.random() * 2.6;
  }

  geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute("aRadius", new THREE.BufferAttribute(radius, 1));
  geometry.setAttribute("aPhase", new THREE.BufferAttribute(phase, 1));
  geometry.setAttribute("aSpeed", new THREE.BufferAttribute(speed, 1));
  geometry.setAttribute("aTilt", new THREE.BufferAttribute(tilt, 1));
  geometry.setAttribute("aAxis", new THREE.BufferAttribute(axis, 1));
  geometry.setAttribute("aSize", new THREE.BufferAttribute(size, 1));
  // The positions are computed in the shader, so the automatic bounds are
  // meaningless — set them by hand or the orb vanishes when it drifts.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 2.2);

  return geometry;
}
