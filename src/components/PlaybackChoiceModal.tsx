import { useEffect, useRef } from "react";
import { ListPlus, ListX, PlayCircle, X } from "lucide-react";
import type { PlaybackItem } from "../lib/types";
import Thumb from "./Thumb";
import "./PlaylistPicker.css";
import "./PlaybackChoiceModal.css";

export type PlaybackChoice = "replace" | "append" | "once";

export default function PlaybackChoiceModal({
  item,
  queueLength,
  currentTitle,
  onChoose,
  onClose,
}: {
  item: PlaybackItem;
  queueLength: number;
  currentTitle: string | null;
  onChoose: (choice: PlaybackChoice) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDivElement>(null);
  const firstAction = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    firstAction.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key !== "Tab") return;
      const buttons = Array.from(
        dialog.current?.querySelectorAll<HTMLButtonElement>(
          "button:not(:disabled)",
        ) ?? [],
      );
      if (buttons.length === 0) return;
      const first = buttons[0];
      const last = buttons[buttons.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  const countLabel = `${queueLength} ${queueLength === 1 ? "song" : "songs"}`;

  return (
    <div className="picker-overlay" onMouseDown={onClose}>
      <div
        ref={dialog}
        className="playback-choice"
        role="dialog"
        aria-modal="true"
        aria-labelledby="playback-choice-title"
        aria-describedby="playback-choice-song"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="playback-choice-head">
          <div className="playback-choice-song">
            <Thumb src={item.thumbnail} size={48} radius={9} />
            <div>
              <span className="playback-choice-kicker">Recently played</span>
              <h2 id="playback-choice-title">How should this play?</h2>
              <p id="playback-choice-song" title={item.title}>
                {item.title}
              </p>
            </div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="Cancel">
            <X size={18} />
          </button>
        </header>

        <div className="playback-routes">
          <button
            ref={firstAction}
            className="playback-route"
            onClick={() => onChoose("replace")}
          >
            <span className="playback-route-icon replace">
              <ListX size={19} />
            </span>
            <span className="playback-route-copy">
              <strong>Clear playlist and play</strong>
              <small>
                {queueLength > 0
                  ? `Stops playback, removes ${countLabel}, and starts this song.`
                  : "Starts a new queue with only this song."}
              </small>
            </span>
            <span className="route-diagram replace" aria-hidden="true">
              <i />
              <b />
            </span>
          </button>

          <button
            className="playback-route"
            onClick={() => onChoose("append")}
          >
            <span className="playback-route-icon append">
              <ListPlus size={19} />
            </span>
            <span className="playback-route-copy">
              <strong>Add to end</strong>
              <small>
                {queueLength > 0
                  ? `Keeps playback going and adds this after all ${countLabel}.`
                  : "Adds this to the empty queue and starts playing it."}
              </small>
            </span>
            <span className="route-diagram append" aria-hidden="true">
              <i />
              <i />
              <b />
            </span>
          </button>

          <button
            className="playback-route playback-route-featured"
            onClick={() => onChoose("once")}
          >
            <span className="playback-route-icon once">
              <PlayCircle size={19} />
            </span>
            <span className="playback-route-copy">
              <strong>Play once, keep playlist</strong>
              <small>
                {currentTitle
                  ? `Plays this now, then returns to “${currentTitle}” where it paused.`
                  : "Plays this without adding it to the queue."}
              </small>
            </span>
            <span className="route-diagram once" aria-hidden="true">
              <i />
              <b />
              <i />
            </span>
          </button>
        </div>

        <footer className="playback-choice-foot">
          The playing playlist changes only after you choose.
        </footer>
      </div>
    </div>
  );
}
