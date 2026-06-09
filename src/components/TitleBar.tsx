import { useEffect, useState } from "react";
import { Minus, Square, Copy, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./TitleBar.css";

const appWindow = getCurrentWindow();

export default function TitleBar() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    void appWindow.isMaximized().then(setMaximized);
    void appWindow
      .onResized(() => {
        void appWindow.isMaximized().then(setMaximized);
      })
      .then((u) => {
        unlisten = u;
      });
    return () => unlisten?.();
  }, []);

  return (
    <div className="title-bar" data-tauri-drag-region>
      <div className="title-bar-left" data-tauri-drag-region>
        <span className="title-bar-mark">🎵</span>
        <span className="title-bar-title">Local Music Player</span>
      </div>
      <div className="title-bar-controls">
        <button
          className="tb-btn"
          onClick={() => void appWindow.minimize()}
          title="Minimize"
        >
          <Minus size={16} />
        </button>
        <button
          className="tb-btn"
          onClick={() => void appWindow.toggleMaximize()}
          title={maximized ? "Restore" : "Maximize"}
        >
          {maximized ? <Copy size={12} /> : <Square size={12} />}
        </button>
        <button
          className="tb-btn tb-close"
          onClick={() => void appWindow.close()}
          title="Close"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
