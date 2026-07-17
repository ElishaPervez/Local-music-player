import type { CSSProperties } from "react";
import {
  SkipBack,
  SkipForward,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Repeat,
  Repeat1,
  Shuffle,
  Radio,
  Loader2,
} from "lucide-react";
import { usePlayerStore } from "../stores/playerStore";
import { useLibraryStore } from "../stores/libraryStore";
import { formatDuration } from "../lib/format";
import Thumb from "./Thumb";
import "./NowPlayingBar.css";

export default function NowPlayingBar() {
  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const position = usePlayerStore((s) => s.position);
  const duration = usePlayerStore((s) => s.duration);
  const volume = usePlayerStore((s) => s.volume);
  const repeat = usePlayerStore((s) => s.repeat);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const autoPlay = usePlayerStore((s) => s.autoPlay);
  const loadingStream = usePlayerStore((s) => s.loadingStream);

  const setAutoPlay = useLibraryStore((s) => s.setAutoPlay);
  const togglePlay = usePlayerStore((s) => s.togglePlay);
  const next = usePlayerStore((s) => s.next);
  const prev = usePlayerStore((s) => s.prev);
  const seek = usePlayerStore((s) => s.seek);
  const setVolume = usePlayerStore((s) => s.setVolume);
  const toggleMute = usePlayerStore((s) => s.toggleMute);
  const toggleShuffle = usePlayerStore((s) => s.toggleShuffle);
  const cycleRepeat = usePlayerStore((s) => s.cycleRepeat);

  const current = index >= 0 && index < queue.length ? queue[index] : null;
  const dur = duration || current?.durationSec || 0;
  const pct = dur > 0 ? (position / dur) * 100 : 0;

  return (
    <footer className="now-playing">
      {/* Keyed by track: a song change remounts this block and replays the
          slide-up entrance. */}
      <div className="np-track" key={current?.key ?? "idle"}>
        <div className="np-thumb-wrap">
          <Thumb src={current?.thumbnail} size={52} radius={8} />
        </div>
        <div className="np-meta">
          <span className="np-title">{current?.title ?? "Nothing playing"}</span>
          <span className="np-artist">
            {current?.artist || "Currently playing vibe"}
          </span>
        </div>
      </div>

      <div className="np-center">
        <div className="np-buttons">
          <button
            className={`np-btn np-shuffle ${shuffle ? "active" : ""}`}
            onClick={toggleShuffle}
            title="Shuffle"
          >
            <Shuffle size={16} />
          </button>
          <button className="np-btn" onClick={prev} title="Previous">
            <SkipBack size={18} fill="currentColor" />
          </button>
          <button
            className="np-btn np-play"
            onClick={togglePlay}
            disabled={!current}
            title={isPlaying ? "Pause" : "Play"}
          >
            {loadingStream ? (
              <Loader2 size={20} className="spin" />
            ) : isPlaying ? (
              <Pause size={20} fill="currentColor" />
            ) : (
              <Play size={20} fill="currentColor" />
            )}
          </button>
          <button className="np-btn" onClick={next} title="Next">
            <SkipForward size={18} fill="currentColor" />
          </button>
          <button
            className={`np-btn ${repeat !== "off" ? "active" : ""}`}
            onClick={cycleRepeat}
            disabled={autoPlay}
            title={
              autoPlay
                ? "Repeat is off while Auto-play is on"
                : `Repeat: ${repeat}`
            }
          >
            {repeat === "one" ? <Repeat1 size={16} /> : <Repeat size={16} />}
          </button>
          <button
            className={`np-btn ${autoPlay ? "active" : ""}`}
            onClick={() => setAutoPlay(!autoPlay)}
            title="Auto-play similar songs"
          >
            <Radio size={16} />
          </button>
        </div>

        <div className="np-seek">
          <span className="np-time">{formatDuration(position)}</span>
          <input
            type="range"
            className="np-range"
            min={0}
            max={dur || 0}
            step={0.1}
            value={Math.min(position, dur || 0)}
            onChange={(e) => seek(Number(e.target.value))}
            disabled={!current}
            style={{ "--pct": `${pct}%` } as CSSProperties}
          />
          <span className="np-time">{formatDuration(dur)}</span>
        </div>
      </div>

      <div className="np-volume">
        <button
          className="np-vol-icon"
          onClick={toggleMute}
          title={volume === 0 ? "Unmute" : "Mute"}
        >
          {volume === 0 ? <VolumeX size={18} /> : <Volume2 size={18} />}
        </button>
        <input
          type="range"
          className="np-range np-vol-range"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => setVolume(Number(e.target.value))}
          style={{ "--pct": `${volume * 100}%` } as CSSProperties}
        />
      </div>
    </footer>
  );
}
