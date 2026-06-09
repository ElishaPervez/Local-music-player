import { useState } from "react";
import { Search, Check, Plus, X } from "lucide-react";
import type { Playlist } from "../../lib/types";
import { useLibraryStore } from "../../stores/libraryStore";
import { formatDuration } from "../../lib/format";
import Thumb from "../../components/Thumb";
import "./AddSongsModal.css";

export default function AddSongsModal({
  playlist,
  onClose,
}: {
  playlist: Playlist;
  onClose: () => void;
}) {
  const songsMap = useLibraryStore((s) => s.songs);
  const playlists = useLibraryStore((s) => s.playlists);
  const addToPlaylist = useLibraryStore((s) => s.addToPlaylist);
  const removeFromPlaylist = useLibraryStore((s) => s.removeFromPlaylist);
  const [q, setQ] = useState("");

  // Read the live playlist so membership toggles update instantly.
  const current = playlists.find((p) => p.id === playlist.id) ?? playlist;
  const inPlaylist = new Set(current.songIds);

  const all = Object.values(songsMap).sort((a, b) => b.addedAt - a.addedAt);
  const ql = q.trim().toLowerCase();
  const filtered = ql
    ? all.filter(
        (s) =>
          s.title.toLowerCase().includes(ql) ||
          (s.artist ?? "").toLowerCase().includes(ql),
      )
    : all;

  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="add-songs" onClick={(e) => e.stopPropagation()}>
        <div className="add-songs-header">
          <span>
            Add to <b>{current.name}</b>
          </span>
          <button className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="add-songs-search">
          <Search size={16} />
          <input
            autoFocus
            placeholder="Search your library…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>

        <div className="add-songs-list">
          {all.length === 0 ? (
            <div className="add-songs-empty">
              <p>Your library is empty</p>
              <span>Download songs from the Finder first</span>
            </div>
          ) : filtered.length === 0 ? (
            <div className="add-songs-empty">
              <p>No matches</p>
            </div>
          ) : (
            filtered.map((song) => {
              const added = inPlaylist.has(song.id);
              return (
                <button
                  key={song.id}
                  className={`add-song-row ${added ? "added" : ""}`}
                  onClick={() =>
                    added
                      ? removeFromPlaylist(current.id, song.id)
                      : addToPlaylist(current.id, song.id)
                  }
                >
                  <Thumb src={song.thumbnail} size={40} />
                  <div className="add-song-meta">
                    <span className="add-song-title">{song.title}</span>
                    <span className="add-song-artist">
                      {song.artist || "Unknown"}
                    </span>
                  </div>
                  <span className="add-song-dur">
                    {formatDuration(song.durationSec)}
                  </span>
                  <span className="add-song-toggle">
                    {added ? <Check size={18} /> : <Plus size={18} />}
                  </span>
                </button>
              );
            })
          )}
        </div>

        <div className="add-songs-footer">
          <span className="add-songs-count">
            {current.songIds.length}{" "}
            {current.songIds.length === 1 ? "song" : "songs"} in playlist
          </span>
          <button className="btn-primary" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
