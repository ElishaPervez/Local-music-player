import { Music } from "lucide-react";
import "./Thumb.css";

export default function Thumb({
  src,
  size = 44,
  radius = 6,
}: {
  src?: string | null;
  size?: number;
  radius?: number;
}) {
  return (
    <div className="thumb" style={{ width: size, height: size, borderRadius: radius }}>
      {src ? (
        <img src={src} alt="" loading="lazy" draggable={false} />
      ) : (
        <Music size={Math.round(size * 0.42)} />
      )}
    </div>
  );
}
