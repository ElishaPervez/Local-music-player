/**
 * The original spinning record, kept alive for one reason only: a machine
 * where the webview can't produce a 3D surface at all would otherwise show an
 * empty hole where the orb belongs. It is never shown otherwise.
 *
 * Its styling still lives in HomeView.css alongside the rest of the hero,
 * because it relies on the hero's playing / idle state to spin and dim.
 */
import { Music } from "lucide-react";

type Props = {
  thumbnail?: string | null;
  title: string;
  onClick: () => void;
};

export default function RecordFallback({ thumbnail, title, onClick }: Props) {
  return (
    <div className="disc-stage">
      <div className="disc-glow" />
      <button className="disc" onClick={onClick} title={title}>
        <div className="disc-spin">
          <div className="disc-grooves" />
          <div className="disc-label">
            {thumbnail ? (
              <img src={thumbnail} alt="" draggable={false} />
            ) : (
              <Music size={30} />
            )}
          </div>
          <div className="disc-hole" />
        </div>
        <div className="disc-sheen" />
      </button>
      <div className="tonearm">
        <div className="tonearm-pivot" />
        <div className="tonearm-rod">
          <div className="tonearm-head" />
        </div>
      </div>
    </div>
  );
}
