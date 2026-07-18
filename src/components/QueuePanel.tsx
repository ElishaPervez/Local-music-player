import { useRef, useState } from "react";
import {
  ListVideo,
  X,
  GripVertical,
  Radio,
  Save,
  Check,
  AlertCircle,
  ListX,
  AudioLines,
  Download,
  PlayCircle,
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
  useSortable,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { PlaybackItem } from "../lib/types";
import { usePlayerStore } from "../stores/playerStore";
import { useDownloadsStore } from "../stores/downloadsStore";
import { useUIStore, QUEUE_W_DEFAULT } from "../stores/uiStore";
import { useFlipReorder } from "../lib/useFlipReorder";
import { saveQueueAsPlaylist, ensureSongInLibrary } from "../lib/downloadService";
import Thumb from "./Thumb";
import "./QueuePanel.css";

function QueueRow({
  item,
  index,
  isCurrent,
}: {
  item: PlaybackItem;
  index: number;
  isCurrent: boolean;
}) {
  const jumpTo = usePlayerStore((s) => s.jumpTo);
  const removeFromQueue = usePlayerStore((s) => s.removeFromQueue);
  const isPlaying = usePlayerStore((s) => s.isPlaying);
  const adoptDownloadedSong = usePlayerStore((s) => s.adoptDownloadedSong);
  // Live download state while this track is being saved into a playlist.
  const dl = useDownloadsStore((s) => s.byVideo[item.videoId]);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } =
    useSortable({ id: item.key });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    // The whole row is the drag handle; the 5px activation distance on the
    // PointerSensor keeps plain clicks and double-clicks working as before.
    <div
      ref={setNodeRef}
      style={style}
      data-flip-key={item.key}
      className={`queue-row ${isCurrent ? "current" : ""}`}
      onDoubleClick={() => jumpTo(index)}
      {...attributes}
      {...listeners}
    >
      <span className="queue-lead">
        <span className="queue-index">{index + 1}</span>
        <span className="queue-grip">
          <GripVertical size={14} />
        </span>
      </span>
      <Thumb src={item.thumbnail} size={34} radius={5} />
      <div className="queue-meta" onClick={() => jumpTo(index)}>
        <span className="queue-title">
          {isCurrent && (
            <span
              className={`queue-wave ${isPlaying ? "playing" : ""}`}
              title={isPlaying ? "Now playing" : "Paused"}
            >
              <AudioLines size={13} />
            </span>
          )}
          <span className="queue-title-text">{item.title}</span>
        </span>
        <span className="queue-artist">
          {item.auto && item.source.kind === "stream" && (
            <span className="queue-auto-badge" title="Auto-played radio pick">
              <Radio size={11} />
              Auto
            </span>
          )}
          {item.artist || "Unknown"}
        </span>
      </div>
      {dl ? (
        <span
          className={`queue-dl ${dl.status}`}
          title={
            dl.status === "error"
              ? "Download failed"
              : dl.status === "done"
                ? "Saved"
                : `Downloading… ${Math.round(dl.percent)}%`
          }
        >
          {dl.status === "downloading" ? (
            `${Math.round(dl.percent)}%`
          ) : dl.status === "done" ? (
            <Check size={14} />
          ) : (
            <AlertCircle size={14} />
          )}
        </span>
      ) : (
        <span className="queue-actions">
          {item.source.kind === "stream" && (
            <button
              className="queue-action queue-dl-btn"
              onClick={() => {
                void ensureSongInLibrary({
                  videoId: item.videoId,
                  title: item.title,
                  artist: item.artist,
                  durationSec: item.durationSec,
                  thumbnail: item.thumbnail,
                  url: `https://www.youtube.com/watch?v=${item.videoId}`,
                }).then((song) => {
                  if (song) adoptDownloadedSong(song);
                });
              }}
              title="Download to library"
            >
              <Download size={14} />
            </button>
          )}
          <button
            className="queue-action"
            onClick={() => removeFromQueue(item.key)}
            title="Remove from queue"
          >
            <X size={15} />
          </button>
        </span>
      )}
    </div>
  );
}

export default function QueuePanel() {
  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  const oneOffItem = usePlayerStore((s) => s.oneOffItem);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const shuffleTick = usePlayerStore((s) => s.shuffleTick);
  const reorderQueue = usePlayerStore((s) => s.reorderQueue);
  const clearQueue = usePlayerStore((s) => s.clearQueue);
  const queueWidth = useUIStore((s) => s.queueWidth);
  const setQueueWidth = useUIStore((s) => s.setQueueWidth);
  const [resizing, setResizing] = useState(false);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  // Pressing Enter unmounts the input, which also fires its blur — both call
  // commitSave. This guard makes the save run exactly once per session so the
  // queue isn't downloaded into two playlists.
  const committing = useRef(false);

  const listRef = useFlipReorder<HTMLDivElement>(shuffleTick);

  async function commitSave() {
    if (committing.current) return;
    const n = name.trim();
    if (!n) {
      setNaming(false);
      setName("");
      return;
    }
    committing.current = true;
    setNaming(false);
    setName("");
    setSaving(true);
    try {
      // Downloads every queued track (in order) into a new playlist; streamed
      // radio picks are fetched, already-downloaded songs are just referenced.
      await saveQueueAsPlaylist(n);
    } finally {
      setSaving(false);
      committing.current = false;
    }
  }

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  function onResizeStart(e: React.PointerEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    const handle = e.currentTarget;
    const startX = e.clientX;
    const startW = useUIStore.getState().queueWidth;
    handle.setPointerCapture(e.pointerId);
    setResizing(true);
    const move = (ev: PointerEvent) => {
      // The panel sits on the right, so dragging left makes it wider.
      setQueueWidth(startW + (startX - ev.clientX));
    };
    const stop = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", stop);
      handle.removeEventListener("pointercancel", stop);
      setResizing(false);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", stop);
    handle.addEventListener("pointercancel", stop);
  }

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const keys = queue.map((q) => q.key);
    const oldI = keys.indexOf(String(active.id));
    const newI = keys.indexOf(String(over.id));
    if (oldI === -1 || newI === -1) return;
    reorderQueue(arrayMove(queue, oldI, newI));
  }

  return (
    <aside className="queue-panel" style={{ width: queueWidth }}>
      <div
        className={`queue-resize ${resizing ? "resizing" : ""}`}
        onPointerDown={onResizeStart}
        onDoubleClick={() => setQueueWidth(QUEUE_W_DEFAULT)}
        title="Drag to resize · double-click to reset"
      />
      <div className="queue-header">
        <ListVideo size={16} />
        <span>Playing playlist</span>
        {shuffle && <span className="queue-shuffle-tag">Shuffled</span>}
        {queue.length > 0 && (
          <div className="queue-head-actions">
            <button
              className="queue-head-btn"
              onClick={() => setNaming(true)}
              disabled={saving || naming}
              title="Save the current queue as a downloaded playlist"
            >
              <Save size={13} />
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              className="queue-head-btn danger"
              onClick={() => clearQueue()}
              disabled={saving || naming}
              title="Clear the running playlist and stop playback"
            >
              <ListX size={13} />
              Clear
            </button>
            <span className="queue-badge" key={queue.length}>
              {queue.length}
            </span>
          </div>
        )}
      </div>

      {naming && (
        <div className="queue-save-row">
          <input
            autoFocus
            placeholder="New playlist name…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void commitSave();
              if (e.key === "Escape") {
                setNaming(false);
                setName("");
              }
            }}
            onBlur={() => void commitSave()}
          />
        </div>
      )}

      {oneOffItem && (
        <div className="queue-once" aria-live="polite">
          <span className="queue-once-icon">
            <PlayCircle size={15} />
          </span>
          <span className="queue-once-copy">
            <b>Playing once</b>
            <span title={oneOffItem.title}>{oneOffItem.title}</span>
          </span>
          <span className="queue-once-note">Queue resumes after</span>
        </div>
      )}

      {queue.length === 0 ? (
        <div className="queue-empty">
          <ListVideo size={32} />
          <p>Queue is empty</p>
          <span>Play something to build the queue</span>
        </div>
      ) : (
        <div className="queue-list" ref={listRef}>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            onDragEnd={onDragEnd}
          >
            <SortableContext
              items={queue.map((q) => q.key)}
              strategy={verticalListSortingStrategy}
            >
              {queue.map((item, i) => (
                <QueueRow
                  key={item.key}
                  item={item}
                  index={i}
                  isCurrent={!oneOffItem && i === index}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      )}
    </aside>
  );
}
