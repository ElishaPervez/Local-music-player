import { getCurrentWindow } from "@tauri-apps/api/window";
import "./ResizeHandles.css";

const appWindow = getCurrentWindow();

// ResizeDirection isn't exported by the API package, but its values are these
// strings, which is exactly what startResizeDragging forwards to the backend.
type Dir =
  | "North"
  | "South"
  | "East"
  | "West"
  | "NorthEast"
  | "NorthWest"
  | "SouthEast"
  | "SouthWest";

const startResize = appWindow.startResizeDragging as unknown as (
  d: Dir,
) => Promise<void>;

const HANDLES: { cls: string; dir: Dir }[] = [
  { cls: "rz-n", dir: "North" },
  { cls: "rz-s", dir: "South" },
  { cls: "rz-e", dir: "East" },
  { cls: "rz-w", dir: "West" },
  { cls: "rz-ne", dir: "NorthEast" },
  { cls: "rz-nw", dir: "NorthWest" },
  { cls: "rz-se", dir: "SouthEast" },
  { cls: "rz-sw", dir: "SouthWest" },
];

export default function ResizeHandles() {
  return (
    <>
      {HANDLES.map((h) => (
        <div
          key={h.cls}
          className={`rz ${h.cls}`}
          onMouseDown={(e) => {
            if (e.button === 0) void startResize.call(appWindow, h.dir);
          }}
        />
      ))}
    </>
  );
}
