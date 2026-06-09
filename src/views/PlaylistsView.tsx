import { useState } from "react";
import { Plus, ListMusic } from "lucide-react";
import { useLibraryStore } from "../stores/libraryStore";
import { useUIStore } from "../stores/uiStore";
import QueuePanel from "../components/QueuePanel";
import Thumb from "../components/Thumb";
import PlaylistDetail from "./playlists/PlaylistDetail";
import "./views.css";
import "./PlaylistsView.css";

export default function PlaylistsView() {
  const playlists = useLibraryStore((s) => s.playlists);
  const songs = useLibraryStore((s) => s.songs);
  const createPlaylist = useLibraryStore((s) => s.createPlaylist);
  const selectedId = useUIStore((s) => s.selectedPlaylistId);
  const setSelected = useUIStore((s) => s.setSelectedPlaylist);

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  const selected = playlists.find((p) => p.id === selectedId) ?? null;
  if (selected) {
    return (
      <div className="view">
        <PlaylistDetail playlist={selected} onBack={() => setSelected(null)} />
        <QueuePanel />
      </div>
    );
  }

  function commitCreate() {
    const n = name.trim();
    if (!n) {
      setCreating(false);
      return;
    }
    const pl = createPlaylist(n);
    setName("");
    setCreating(false);
    setSelected(pl.id);
  }

  return (
    <div className="view">
      <div className="view-content">
        <div className="view-header">
          <h2>Playlists</h2>
          <button className="btn-primary" onClick={() => setCreating(true)}>
            <Plus size={16} /> New playlist
          </button>
        </div>

        <div className="playlists-body">
          {creating && (
            <div className="playlist-create">
              <input
                autoFocus
                placeholder="Playlist name…"
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitCreate();
                  if (e.key === "Escape") {
                    setCreating(false);
                    setName("");
                  }
                }}
                onBlur={commitCreate}
              />
            </div>
          )}

          {playlists.length === 0 && !creating ? (
            <div className="empty-state">
              <ListMusic size={42} strokeWidth={1.5} />
              <p>No playlists yet</p>
              <span>
                Create a playlist, then download songs into it from the Finder
              </span>
            </div>
          ) : (
            <div className="playlist-grid">
              {playlists.map((p) => {
                const first = p.songIds
                  .map((id) => songs[id])
                  .find((s) => s?.thumbnail);
                return (
                  <button
                    key={p.id}
                    className="playlist-card"
                    onClick={() => setSelected(p.id)}
                  >
                    <Thumb src={first?.thumbnail} size={140} radius={10} />
                    <span className="playlist-card-name">{p.name}</span>
                    <span className="playlist-card-count">
                      {p.songIds.length}{" "}
                      {p.songIds.length === 1 ? "song" : "songs"}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>

      <QueuePanel />
    </div>
  );
}
