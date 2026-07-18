import { useRef, useState } from "react";
import { Search, FolderOpen, Trash2, Sparkles } from "lucide-react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Song } from "../../lib/types";
import { useLibraryStore } from "../../stores/libraryStore";
import { refreshMusicCredits } from "../../lib/downloadService";
import { formatDuration } from "../../lib/format";
import Thumb from "../../components/Thumb";

type CreditsRefresh =
  | { state: "idle" }
  | { state: "running"; done: number; total: number }
  | { state: "done"; updated: number };

/** Inline song manager for the Settings view — the only place a song can be
 *  deleted from the library (and its file removed from disk). */
export default function LibraryPanel() {
  const songsMap = useLibraryStore((s) => s.songs);
  const playlists = useLibraryStore((s) => s.playlists);
  const deleteSong = useLibraryStore((s) => s.deleteSong);
  const [q, setQ] = useState("");
  const [refresh, setRefresh] = useState<CreditsRefresh>({ state: "idle" });
  const doneTimer = useRef<number | undefined>(undefined);

  async function runCreditsRefresh() {
    if (refresh.state === "running") return;
    window.clearTimeout(doneTimer.current);
    setRefresh({ state: "running", done: 0, total: 0 });
    const { updated } = await refreshMusicCredits((done, total) =>
      setRefresh({ state: "running", done, total }),
    );
    setRefresh({ state: "done", updated });
    doneTimer.current = window.setTimeout(
      () => setRefresh({ state: "idle" }),
      6000,
    );
  }

  const all = Object.values(songsMap).sort((a, b) => b.addedAt - a.addedAt);
  const ql = q.trim().toLowerCase();
  const filtered = ql
    ? all.filter(
        (s) =>
          s.title.toLowerCase().includes(ql) ||
          (s.artist ?? "").toLowerCase().includes(ql),
      )
    : all;

  function confirmDelete(song: Song) {
    if (
      window.confirm(
        `Delete "${song.title}" from your library? This permanently removes the file and all playlist entries.`,
      )
    ) {
      void deleteSong(song.id);
    }
  }

  if (all.length === 0) {
    return (
      <div className="library-panel">
        <div className="library-empty">
          Your library is empty — download songs from the Finder.
        </div>
      </div>
    );
  }

  return (
    <div className="library-panel">
      <div className="library-toolbar">
        <div className="library-search">
          <Search size={15} />
          <input
            placeholder="Search songs…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <button
          className="btn-secondary library-fix-info"
          disabled={refresh.state === "running"}
          title="Re-check every song against YouTube's music credits and fix titles/artists that are really video names and channel names"
          onClick={() => void runCreditsRefresh()}
        >
          <Sparkles size={14} />
          {refresh.state === "running"
            ? refresh.total > 0
              ? `Checking ${refresh.done}/${refresh.total}…`
              : "Checking…"
            : refresh.state === "done"
              ? refresh.updated > 0
                ? `Fixed ${refresh.updated} song${refresh.updated === 1 ? "" : "s"}`
                : "Nothing to fix"
              : "Fix song info"}
        </button>
      </div>

      <div className="library-list">
        {filtered.length === 0 ? (
          <div className="library-empty">No matches</div>
        ) : (
          filtered.map((song) => {
            const inLists = playlists.filter((p) => p.songIds.includes(song.id));
            return (
              <div key={song.id} className="library-row">
                <Thumb src={song.thumbnail} size={36} />
                <div className="library-row-meta">
                  <span className="library-row-title">{song.title}</span>
                  <span
                    className="library-row-sub"
                    title={inLists.map((p) => p.name).join(", ")}
                  >
                    {song.artist || "Unknown"} ·{" "}
                    {formatDuration(song.durationSec)}
                    {inLists.length > 0 &&
                      ` · ${
                        inLists.length === 1
                          ? inLists[0].name
                          : `${inLists.length} playlists`
                      }`}
                  </span>
                </div>
                <button
                  className="icon-btn"
                  title="Reveal in folder"
                  onClick={() =>
                    void revealItemInDir(song.filePath).catch(() => {})
                  }
                >
                  <FolderOpen size={16} />
                </button>
                <button
                  className="icon-btn danger"
                  title="Delete from library"
                  onClick={() => confirmDelete(song)}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
