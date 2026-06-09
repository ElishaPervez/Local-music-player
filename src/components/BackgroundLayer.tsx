import { useLibraryStore } from "../stores/libraryStore";
import { fileSrc } from "../lib/api";

export default function BackgroundLayer() {
  const bg = useLibraryStore((s) => s.settings.background);
  if (!bg) return null;
  const src = fileSrc(bg.path);
  return (
    <>
      <div
        className="app-bg"
        style={{
          backgroundImage: `url("${src}")`,
          filter: `blur(${bg.blur}px)`,
          opacity: bg.opacity,
        }}
      />
      <div className="app-bg-scrim" />
    </>
  );
}
