import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useLibraryStore } from "../stores/libraryStore";
import { fileSrc } from "../lib/api";
import { bgKind } from "../lib/background";

export default function BackgroundLayer() {
  const bg = useLibraryStore((s) => s.settings.background);
  const videoRef = useRef<HTMLVideoElement>(null);
  const kind = bg ? bgKind(bg) : "image";
  const isVideo = !!bg && kind === "video";

  // Stop decoding the video whenever the app can't be seen — minimized, or its
  // tab/window hidden. A paused <video> does no work, so the wallpaper costs
  // nothing while you're in another app, then picks up where it left off. This
  // is the main reason a live wallpaper here stays cheap.
  useEffect(() => {
    if (!isVideo) return;
    const el = videoRef.current;
    if (!el) return;
    const win = getCurrentWindow();
    let disposed = false;

    const sync = async () => {
      if (disposed) return;
      let minimized = false;
      try {
        minimized = await win.isMinimized();
      } catch {
        /* ignore — treat as visible */
      }
      if (document.hidden || minimized) {
        el.pause();
      } else {
        // play() rejects if interrupted; the wallpaper is muted so this is safe.
        void el.play().catch(() => {});
      }
    };

    document.addEventListener("visibilitychange", sync);
    const unlisten = win.onResized(() => void sync());
    void sync();

    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", sync);
      void unlisten.then((f) => f());
    };
  }, [isVideo, bg?.path]);

  if (!bg) return null;
  const src = fileSrc(bg.path);
  const mediaStyle = { filter: `blur(${bg.blur}px)`, opacity: bg.opacity };

  return (
    <>
      {isVideo ? (
        <video
          ref={videoRef}
          className="app-bg app-bg-video"
          src={src}
          style={mediaStyle}
          autoPlay
          loop
          muted
          playsInline
          preload="auto"
          disablePictureInPicture
        />
      ) : (
        <div
          className="app-bg"
          style={{ ...mediaStyle, backgroundImage: `url("${src}")` }}
        />
      )}
      <div className="app-bg-scrim" />
    </>
  );
}
