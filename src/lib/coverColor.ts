/**
 * Prepares a track's cover art for the orb: a square copy to wrap around the
 * sphere, and the one colour that best represents the image for the glow, the
 * rim light and the particles.
 *
 * Both come out of a single download. The image server YouTube serves covers
 * from allows any page to read the pixels back, which is what makes this
 * possible at all — without that permission the image could be shown but never
 * measured, and the sphere could not wear it.
 */

/** Side length of the square handed to the 3D scene. Larger buys nothing at
 *  the size the orb is drawn. */
const TEXTURE_SIZE = 512;
/** The colour is measured from a tiny copy — a few hundred pixels is plenty to
 *  find the dominant tone and costs nothing to scan. */
const SAMPLE_SIZE = 32;

/** The app's purple, used whenever there is no cover or it can't be read. */
export const FALLBACK_COLOR: [number, number, number] = [124, 92, 255];

export type Cover = {
  /** Square image, ready to be wrapped around the sphere. */
  image: HTMLCanvasElement;
  /** Representative colour, each channel 0–255. */
  color: [number, number, number];
};

/**
 * Pick the colour that best represents an image.
 *
 * A plain average of every pixel drifts toward mud, because dark backgrounds
 * and grey outnumber the colour that actually makes the cover recognisable.
 * So each pixel is weighted by how colourful it is and how far it sits from
 * pure black or pure white, which pulls the result toward the tone a person
 * would name if asked what colour the cover is.
 *
 * Exported for its own tests — it takes raw pixel values and needs no browser.
 */
export function dominantColor(
  pixels: ArrayLike<number>,
): [number, number, number] {
  let wr = 0;
  let wg = 0;
  let wb = 0;
  let total = 0;

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const r = pixels[i];
    const g = pixels[i + 1];
    const b = pixels[i + 2];
    const a = pixels[i + 3];
    if (a < 128) continue; // transparent pixels say nothing about the cover

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    // How colourful: 0 for any shade of grey, 1 for a fully saturated hue.
    const colourfulness = max === 0 ? 0 : (max - min) / max;
    // How far from the extremes: near-black and blown-out white both score 0.
    const midness = 1 - Math.abs((max + min) / 2 / 255 - 0.5) * 2;
    const weight = 0.15 + colourfulness * midness * 3;

    wr += r * weight;
    wg += g * weight;
    wb += b * weight;
    total += weight;
  }

  if (total === 0) return FALLBACK_COLOR;

  let r = wr / total;
  let g = wg / total;
  let b = wb / total;

  // A washed-out result would leave the orb looking grey and lit by nothing in
  // particular, so anything too timid gets pushed away from grey until it has
  // some presence. Covers that really are monochrome still end up neutral,
  // just brighter.
  const mean = (r + g + b) / 3;
  const spread = Math.max(Math.abs(r - mean), Math.abs(g - mean), Math.abs(b - mean));
  if (spread < 40) {
    const boost = 1.6;
    r = mean + (r - mean) * boost;
    g = mean + (g - mean) * boost;
    b = mean + (b - mean) * boost;
  }

  // Lift dim results so the glow is actually visible against a dark app.
  const brightest = Math.max(r, g, b);
  if (brightest > 0 && brightest < 150) {
    const lift = 150 / brightest;
    r *= lift;
    g *= lift;
    b *= lift;
  }

  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return [clamp(r), clamp(g), clamp(b)];
}

/** Load an image, giving up rather than hanging if the server never answers. */
function loadImage(url: string, timeoutMs = 8000): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Must be set before the address is assigned. Without it the pixels can be
    // drawn but never read back, which would cost both the colour and the
    // ability to wrap the image around the sphere.
    img.crossOrigin = "anonymous";
    const timer = window.setTimeout(() => {
      img.src = "";
      reject(new Error("cover art timed out"));
    }, timeoutMs);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img);
    };
    img.onerror = () => {
      clearTimeout(timer);
      reject(new Error("cover art failed to load"));
    };
    img.src = url;
  });
}

/**
 * Fetch a cover and turn it into everything the orb needs.
 *
 * Covers arrive as widescreen rectangles, so the largest centred square is
 * taken. What that leaves out ends up at the top and bottom of the wrapped
 * image, which lands on the poles of the sphere where almost nothing is
 * visible — so the part of the cover you actually see is the middle of it.
 */
export async function loadCover(url: string): Promise<Cover> {
  const img = await loadImage(url);
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  if (!side) throw new Error("cover art has no size");

  const canvas = document.createElement("canvas");
  canvas.width = TEXTURE_SIZE;
  canvas.height = TEXTURE_SIZE;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no drawing surface for cover art");
  ctx.drawImage(
    img,
    (img.naturalWidth - side) / 2,
    (img.naturalHeight - side) / 2,
    side,
    side,
    0,
    0,
    TEXTURE_SIZE,
    TEXTURE_SIZE,
  );

  return { image: canvas, color: sampleColor(canvas) };
}

/** Shrink the square down and measure it. Failure here is never fatal — the
 *  cover still gets worn, just with the app's own purple around it. */
function sampleColor(square: HTMLCanvasElement): [number, number, number] {
  try {
    const small = document.createElement("canvas");
    small.width = SAMPLE_SIZE;
    small.height = SAMPLE_SIZE;
    const ctx = small.getContext("2d", { willReadFrequently: true });
    if (!ctx) return FALLBACK_COLOR;
    ctx.drawImage(square, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    return dominantColor(ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
  } catch {
    return FALLBACK_COLOR;
  }
}
