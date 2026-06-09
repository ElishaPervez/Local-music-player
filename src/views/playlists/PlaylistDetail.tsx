import { useState } from "react";
import {
  ChevronLeft,
  Play,
  Shuffle,
  Trash2,
  Check,
  Pencil,
  Plus,
} from "lucide-react";
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  arrayMove,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import type { Playlist } from "../../lib/types";
import { useLibraryStore } from "../../stores/libraryStore";
import { usePlayerStore } from "../../stores/playerStore";
import { songToItem } from "../../lib/playback";
import SongRow from "./SongRow";
import AddSongsModal from "./AddSongsModal";
import "./PlaylistDetail.css";

export default function PlaylistDetail({
  playlist,
  onBack,
}: {
  playlist: Playlist;
  onBack: () => void;
}) {
  const songsMap = useLibraryStore((s) => s.songs);
  const reorderPlaylist = useLibraryStore((s) => s.reorderPlaylist);
  const renamePlaylist = useLibraryStore((s) => s.renamePlaylist);
  const deletePlaylist = useLibraryStore((s) => s.deletePlaylist);
  const playQueue = usePlayerStore((s) => s.playQueue);
  const playShuffled = usePlayerStore((s) => s.playShuffled);

  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(playlist.name);
  const [addOpen, setAddOpen] = useState(false);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const songs = playlist.songIds
    .map((id) => songsMap[id])
    .filter((s): s is NonNullable<typeof s> => Boolean(s));

  function playAll(startIndex = 0) {
    if (songs.length === 0) return;
    playQueue(songs.map(songToItem), startIndex, playlist.id);
  }

  function shufflePlay() {
    if (songs.length === 0) return;
    playShuffled(songs.map(songToItem), playlist.id);
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const ids = playlist.songIds;
    const oldI = ids.indexOf(String(active.id));
    const newI = ids.indexOf(String(over.id));
    if (oldI === -1 || newI === -1) return;
    reorderPlaylist(playlist.id, arrayMove(ids, oldI, newI));
  }

  function commitName() {
    renamePlaylist(playlist.id, name);
    setEditing(false);
  }

  function removePlaylist() {
    if (
      !window.confirm(
        `Delete playlist "${playlist.name}"? Its songs stay in your library.`,
      )
    ) {
      return;
    }
    deletePlaylist(playlist.id);
    onBack();
  }

  return (
    <div className="view-content">
      <div className="detail-header">
        <button className="icon-btn" onClick={onBack} title="Back">
          <ChevronLeft size={20} />
        </button>

        {editing ? (
          <input
            className="detail-name-input"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitName();
              if (e.key === "Escape") {
                setName(playlist.name);
                setEditing(false);
              }
            }}
            onBlur={commitName}
          />
        ) : (
          <h2 className="detail-name" onDoubleClick={() => setEditing(true)}>
            {playlist.name}
          </h2>
        )}

        {editing ? (
          <button className="icon-btn" onClick={commitName} title="Save">
            <Check size={18} />
          </button>
        ) : (
          <button
            className="icon-btn"
            onClick={() => {
              setName(playlist.name);
              setEditing(true);
            }}
            title="Rename playlist"
          >
            <Pencil size={16} />
          </button>
        )}

        <div className="detail-spacer" />

        <button
          className="btn-secondary"
          onClick={() => setAddOpen(true)}
          title="Add songs from your library"
        >
          <Plus size={16} /> Add songs
        </button>
        <button
          className="btn-primary"
          onClick={() => playAll(0)}
          disabled={songs.length === 0}
        >
          <Play size={16} fill="currentColor" /> Play
        </button>
        <button
          className="btn-secondary"
          onClick={shufflePlay}
          disabled={songs.length === 0}
          title="Shuffle play"
        >
          <Shuffle size={16} />
        </button>
        <button
          className="icon-btn danger"
          onClick={removePlaylist}
          title="Delete playlist"
        >
          <Trash2 size={18} />
        </button>
      </div>

      <div className="detail-body">
        {songs.length === 0 ? (
          <div className="empty-state">
            <p>This playlist is empty</p>
            <span>
              Add songs from your library, or download new ones in the Finder
            </span>
            <button
              className="btn-primary add-songs-cta"
              onClick={() => setAddOpen(true)}
            >
              <Plus size={16} /> Add songs
            </button>
          </div>
        ) : (
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={playlist.songIds}
              strategy={verticalListSortingStrategy}
            >
              <div className="song-list">
                {songs.map((song, i) => (
                  <SongRow
                    key={song.id}
                    song={song}
                    index={i}
                    playlistId={playlist.id}
                    onPlay={() => playAll(i)}
                  />
                ))}
              </div>
            </SortableContext>
          </DndContext>
        )}
      </div>

      {addOpen && (
        <AddSongsModal playlist={playlist} onClose={() => setAddOpen(false)} />
      )}
    </div>
  );
}
