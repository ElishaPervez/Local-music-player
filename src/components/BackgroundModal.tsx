import { useState, type CSSProperties } from "react";
import { X } from "lucide-react";
import "./BackgroundModal.css";

export default function BackgroundModal({
  previewSrc,
  kind,
  initBlur,
  initOpacity,
  busy,
  onApply,
  onCancel,
}: {
  previewSrc: string;
  kind: "image" | "video";
  initBlur: number;
  initOpacity: number;
  busy?: boolean;
  onApply: (blur: number, opacity: number) => void;
  onCancel: () => void;
}) {
  const [blur, setBlur] = useState(initBlur);
  const [opacity, setOpacity] = useState(initOpacity);
  const aspect = `${window.innerWidth} / ${window.innerHeight}`;
  const previewStyle: CSSProperties = { filter: `blur(${blur}px)`, opacity };

  return (
    <div className="picker-overlay" onClick={onCancel}>
      <div className="bg-modal" onClick={(e) => e.stopPropagation()}>
        <div className="bg-modal-header">
          <span>Adjust background</span>
          <button className="icon-btn" onClick={onCancel}>
            <X size={18} />
          </button>
        </div>

        <div className="bg-preview" style={{ aspectRatio: aspect }}>
          {kind === "video" ? (
            <video
              className="bg-preview-img"
              src={previewSrc}
              style={previewStyle}
              autoPlay
              loop
              muted
              playsInline
            />
          ) : (
            <div
              className="bg-preview-img"
              style={{ ...previewStyle, backgroundImage: `url("${previewSrc}")` }}
            />
          )}
          <div className="bg-preview-scrim" />
          <div className="bg-preview-ui">
            <span className="bg-preview-chip">Library preview</span>
          </div>
        </div>

        <div className="bg-sliders">
          <label className="bg-slider">
            <span>
              Blur <b>{blur}px</b>
            </span>
            <input
              type="range"
              className="np-range"
              min={0}
              max={24}
              step={1}
              value={blur}
              onChange={(e) => setBlur(Number(e.target.value))}
              style={{ "--pct": `${(blur / 24) * 100}%` } as CSSProperties}
            />
          </label>
          <label className="bg-slider">
            <span>
              Opacity <b>{Math.round(opacity * 100)}%</b>
            </span>
            <input
              type="range"
              className="np-range"
              min={0.05}
              max={1}
              step={0.01}
              value={opacity}
              onChange={(e) => setOpacity(Number(e.target.value))}
              style={{ "--pct": `${opacity * 100}%` } as CSSProperties}
            />
          </label>
        </div>

        <div className="bg-modal-actions">
          <button className="btn-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="btn-primary"
            onClick={() => onApply(blur, opacity)}
            disabled={busy}
          >
            {busy ? "Applying…" : "Apply background"}
          </button>
        </div>
      </div>
    </div>
  );
}
