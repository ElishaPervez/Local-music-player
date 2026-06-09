import { useState } from "react";
import { Plus, Library, ListMusic } from "lucide-react";
import type { SearchResult } from "../lib/types";
import { useLibraryStore } from "../stores/libraryStore";
import { downloadToPlaylist } from "../lib/downloadService";
import "./PlaylistPicker.css";

export default function PlaylistPicker({
  result,
  onClose,
}: {
  result: SearchResult;
  onClose: () => void;
}) {
  const playlists = useLibraryStore((s) => s.playlists);
  const createPlaylist = useLibraryStore((s) => s.createPlaylist);
  const [newName, setNewName] = useState("");

  function choose(playlistId: string | null) {
    void downloadToPlaylist(result, playlistId);
    onClose();
  }

  function createAndChoose() {
    const name = newName.trim();
    if (!name) return;
    const pl = createPlaylist(name);
    choose(pl.id);
  }

  return (
    <div className="picker-overlay" onClick={onClose}>
      <div className="picker" onClick={(e) => e.stopPropagation()}>
        <div className="picker-header">Download to…</div>

        <div className="picker-list">
          <button className="picker-item" onClick={() => choose(null)}>
            <Library size={16} />
            <span>Library only</span>
          </button>
          {playlists.map((p) => (
            <button
              key={p.id}
              className="picker-item"
              onClick={() => choose(p.id)}
            >
              <ListMusic size={16} />
              <span>{p.name}</span>
              <span className="picker-count">{p.songIds.length}</span>
            </button>
          ))}
        </div>

        <div className="picker-new">
          <input
            autoFocus
            placeholder="New playlist…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createAndChoose()}
          />
          <button
            className="picker-create"
            onClick={createAndChoose}
            disabled={!newName.trim()}
            title="Create & download"
          >
            <Plus size={16} />
          </button>
        </div>
      </div>
    </div>
  );
}
