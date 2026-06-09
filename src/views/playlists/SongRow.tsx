import { useState } from "react";
import {
  GripVertical,
  Play,
  MoreHorizontal,
  Pencil,
  FolderOpen,
  ListPlus,
  X,
} from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { Song } from "../../lib/types";
import { formatDuration } from "../../lib/format";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlayerStore } from "../../stores/playerStore";
import { songToItem } from "../../lib/playback";
import Thumb from "../../components/Thumb";

export default function SongRow({
  song,
  index,
  playlistId,
  onPlay,
}: {
  song: Song;
  index: number;
  playlistId: string;
  onPlay: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: song.id });

  const playlists = useLibraryStore((s) => s.playlists);
  const addToPlaylist = useLibraryStore((s) => s.addToPlaylist);
  const removeFromPlaylist = useLibraryStore((s) => s.removeFromPlaylist);
  const updateSong = useLibraryStore((s) => s.updateSong);
  const addToQueue = usePlayerStore((s) => s.addToQueue);

  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(song.title);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
    zIndex: isDragging ? 1 : undefined,
  };

  function commitTitle() {
    const t = title.trim();
    if (t && t !== song.title) updateSong(song.id, { title: t });
    else setTitle(song.title);
    setEditing(false);
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`song-row ${menuOpen ? "menu-open" : ""}`}
    >
      <button className="song-grip" {...attributes} {...listeners} title="Drag to reorder">
        <GripVertical size={16} />
      </button>
      <span className="song-index">{index + 1}</span>

      <button className="song-play" onClick={onPlay} title="Play">
        <Play size={15} fill="currentColor" />
      </button>
      <Thumb src={song.thumbnail} size={40} />

      <div className="song-meta">
        {editing ? (
          <input
            className="song-title-input"
            autoFocus
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitTitle();
              if (e.key === "Escape") {
                setTitle(song.title);
                setEditing(false);
              }
            }}
            onBlur={commitTitle}
          />
        ) : (
          <span
            className="song-title"
            onDoubleClick={() => {
              setTitle(song.title);
              setEditing(true);
            }}
          >
            {song.title}
          </span>
        )}
        <span className="song-artist">{song.artist || "Unknown"}</span>
      </div>

      <span className="song-duration">{formatDuration(song.durationSec)}</span>

      <div className="song-menu-wrap">
        <button
          className="song-menu-btn"
          onClick={() => setMenuOpen((v) => !v)}
          title="More"
        >
          <MoreHorizontal size={18} />
        </button>
        {menuOpen && (
          <>
            <div className="menu-backdrop" onClick={() => setMenuOpen(false)} />
            <div className="row-menu">
              <button
                className="row-menu-item"
                onClick={() => {
                  addToQueue(songToItem(song));
                  setMenuOpen(false);
                }}
              >
                <ListPlus size={15} /> Add to queue
              </button>
              <button
                className="row-menu-item"
                onClick={() => {
                  setTitle(song.title);
                  setEditing(true);
                  setMenuOpen(false);
                }}
              >
                <Pencil size={15} /> Rename
              </button>
              <button
                className="row-menu-item"
                onClick={() => {
                  removeFromPlaylist(playlistId, song.id);
                  setMenuOpen(false);
                }}
              >
                <X size={15} /> Remove from playlist
              </button>
              <button
                className="row-menu-item"
                onClick={() => {
                  void revealItemInDir(song.filePath).catch(() => {});
                  setMenuOpen(false);
                }}
              >
                <FolderOpen size={15} /> Reveal in folder
              </button>
              {playlists.filter((p) => p.id !== playlistId).length > 0 && (
                <div className="row-menu-section">
                  <span className="row-menu-label">Add to playlist</span>
                  {playlists
                    .filter((p) => p.id !== playlistId)
                    .map((p) => (
                      <button
                        key={p.id}
                        className="row-menu-item"
                        onClick={() => {
                          addToPlaylist(p.id, song.id);
                          setMenuOpen(false);
                        }}
                      >
                        <ListPlus size={15} /> {p.name}
                      </button>
                    ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
