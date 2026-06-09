import { useLayoutEffect, useRef } from "react";

/**
 * FLIP-animates the direct children of the returned ref's element whenever
 * `trigger` changes value. Each child must carry a stable `data-flip-key`
 * attribute. Only the tracked element's rows animate — the rest of the UI is
 * left untouched (no page-level transition, no frozen background).
 *
 * The element captures every child's position on each commit, so reorders that
 * don't bump `trigger` (e.g. drag-and-drop, which animates itself) are recorded
 * silently and never double-animate.
 */
export function useFlipReorder<T extends HTMLElement>(trigger: number) {
  const ref = useRef<T>(null);
  const prevRects = useRef<Map<string, DOMRect>>(new Map());
  const lastTrigger = useRef(trigger);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const children = Array.from(el.children) as HTMLElement[];
    const rects = new Map<string, DOMRect>();
    for (const child of children) {
      const key = child.dataset.flipKey;
      if (key) rects.set(key, child.getBoundingClientRect());
    }

    const shouldAnimate = trigger !== lastTrigger.current;
    lastTrigger.current = trigger;

    if (shouldAnimate) {
      for (const child of children) {
        const key = child.dataset.flipKey;
        if (!key) continue;
        const prev = prevRects.current.get(key);
        const next = rects.get(key);
        if (!prev || !next) continue;
        const dx = prev.left - next.left;
        const dy = prev.top - next.top;
        if (dx === 0 && dy === 0) continue;
        child.animate(
          [
            { transform: `translate(${dx}px, ${dy}px)` },
            { transform: "translate(0, 0)" },
          ],
          { duration: 460, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
        );
      }
    }

    prevRects.current = rects;
  });

  return ref;
}
