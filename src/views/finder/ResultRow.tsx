import { useState } from "react";
import { Play, Download, Check, Loader2, AlertCircle } from "lucide-react";
import type { SearchResult } from "../../lib/types";
import { formatDuration } from "../../lib/format";
import { resultToStreamItem } from "../../lib/playback";
import { usePlayerStore } from "../../stores/playerStore";
import { useDownloadsStore } from "../../stores/downloadsStore";
import { useLibraryStore } from "../../stores/libraryStore";
import Thumb from "../../components/Thumb";
import PlaylistPicker from "../../components/PlaylistPicker";

export default function ResultRow({ result }: { result: SearchResult }) {
  const playNow = usePlayerStore((s) => s.playNow);
  const dl = useDownloadsStore((s) => s.byVideo[result.videoId]);
  const inLibrary = useLibraryStore((s) => !!s.songs[result.videoId]);
  const [pickerOpen, setPickerOpen] = useState(false);

  function renderAction() {
    if (dl?.status === "downloading") {
      return (
        <div className="result-progress" title={`${Math.round(dl.percent)}%`}>
          <Loader2 size={16} className="spin" />
          <span>{Math.round(dl.percent)}%</span>
        </div>
      );
    }
    if (dl?.status === "error") {
      return (
        <span className="result-error" title="Download failed">
          <AlertCircle size={18} />
        </span>
      );
    }
    if (dl?.status === "done" || inLibrary) {
      return (
        <button
          className="result-btn downloaded"
          onClick={() => setPickerOpen(true)}
          title="In library — add to another playlist"
        >
          <Check size={18} />
        </button>
      );
    }
    return (
      <button
        className="result-btn"
        onClick={() => setPickerOpen(true)}
        title="Download to a playlist"
      >
        <Download size={18} />
      </button>
    );
  }

  return (
    <div className="result-row">
      <button
        className="result-play"
        onClick={() => void playNow(resultToStreamItem(result))}
        title="Play now (stream)"
      >
        <Play size={16} fill="currentColor" />
      </button>
      <Thumb src={result.thumbnail} size={44} />
      <div className="result-meta">
        <span className="result-title">{result.title}</span>
        <span className="result-artist">{result.artist || "Unknown"}</span>
      </div>
      <span className="result-duration">
        {formatDuration(result.durationSec)}
      </span>
      <div className="result-actions">{renderAction()}</div>

      {pickerOpen && (
        <PlaylistPicker result={result} onClose={() => setPickerOpen(false)} />
      )}
    </div>
  );
}
