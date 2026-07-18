import type { BackgroundConfig } from "./types";

/** File extensions we treat as a still image (painted via CSS background-image).
 *  GIF stays here on purpose: the browser animates it as an image, which is far
 *  cheaper than decoding it as video. */
export const IMAGE_EXTS = [
  "png",
  "jpg",
  "jpeg",
  "webp",
  "gif",
  "bmp",
  "jfif",
  "avif",
];

/** File extensions we treat as a live wallpaper (played in a <video> element).
 *  Actual decode support depends on WebView2 — mp4 (H.264) and webm are the
 *  safe bets; the rest are offered in case the user's system codecs handle them. */
export const VIDEO_EXTS = ["mp4", "webm", "mov", "m4v", "mkv", "ogv"];

export function extOf(path: string): string {
  return (path.split(".").pop() || "").toLowerCase();
}

/** Decide how a file should be rendered from its extension. */
export function bgKindFromPath(path: string): "image" | "video" {
  return VIDEO_EXTS.includes(extOf(path)) ? "video" : "image";
}

/** The effective kind of a saved background, tolerating older configs that were
 *  written before the `kind` field existed. */
export function bgKind(bg: BackgroundConfig): "image" | "video" {
  return bg.kind ?? bgKindFromPath(bg.path);
}
