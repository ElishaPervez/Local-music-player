import { useState } from "react";
import { ListVideo, X, GripVertical, Volume2 } from "lucide-react";
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
import { useUIStore, QUEUE_W_DEFAULT } from "../stores/uiStore";
import { useFlipReorder } from "../lib/useFlipReorder";
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
      {isCurrent ? (
        <span className="queue-eq">
          <Volume2 size={14} />
        </span>
      ) : (
        <Thumb src={item.thumbnail} size={34} radius={5} />
      )}
      <div className="queue-meta" onClick={() => jumpTo(index)}>
        <span className="queue-title">{item.title}</span>
        <span className="queue-artist">{item.artist || "Unknown"}</span>
      </div>
      <button
        className="queue-remove"
        onClick={() => removeFromQueue(item.key)}
        title="Remove from queue"
      >
        <X size={15} />
      </button>
    </div>
  );
}

export default function QueuePanel() {
  const queue = usePlayerStore((s) => s.queue);
  const index = usePlayerStore((s) => s.index);
  const shuffle = usePlayerStore((s) => s.shuffle);
  const shuffleTick = usePlayerStore((s) => s.shuffleTick);
  const reorderQueue = usePlayerStore((s) => s.reorderQueue);
  const queueWidth = useUIStore((s) => s.queueWidth);
  const setQueueWidth = useUIStore((s) => s.setQueueWidth);
  const [resizing, setResizing] = useState(false);

  const listRef = useFlipReorder<HTMLDivElement>(shuffleTick);

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
        {queue.length > 0 && <span className="queue-badge">{queue.length}</span>}
      </div>

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
                  isCurrent={i === index}
                />
              ))}
            </SortableContext>
          </DndContext>
        </div>
      )}
    </aside>
  );
}
