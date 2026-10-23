import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";

import { dropIndex, moveKey, shiftFor, type ReorderSlot } from "@/components/ui/strip-reorder";
import { buzz } from "@/lib/haptics";

// Dragging a row up or down its list by its handle. The handle takes the touch (`touch-action: none`)
// so a finger on it drags at once while the rest of the list scrolls as before, and a mouse drags the
// same way. The other rows slide aside with transforms and the DOM keeps its order until the drop, as
// a strip's chips do (ui/strip-reorder.ts, whose slot arithmetic this reuses on the vertical axis: a
// slot's `start` and `width` are a row's top and height here). Arrow keys on a handle move its row.

// Dragged this close to the scroller's top or bottom edge, the list scrolls that way, faster deeper in.
const EDGE = 48;
const EDGE_SPEED = 12;

interface Drag {
  list: HTMLElement;
  rows: HTMLElement[];
  slots: ReorderSlot[];
  keys: string[];
  from: number;
  to: number;
  pointerId: number;
  y0: number;
  y: number;
  scroller: HTMLElement;
  scroll0: number;
  frame: number;
}

/** The element whose scrolling moves `el`: its nearest ancestor that scrolls, else the page. */
function scrollerOf(el: HTMLElement): HTMLElement {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const { overflowY } = getComputedStyle(node);
    if ((overflowY === "auto" || overflowY === "scroll") && node.scrollHeight > node.clientHeight) return node;
  }
  return (document.scrollingElement ?? document.documentElement) as HTMLElement;
}

export interface ListReorder {
  /** The row being dragged right now, which its list lifts. */
  dragging: string | null;
  /** What a row's handle spreads: the drag, and Up/Down to move it one place. */
  handle: (key: string) => {
    "data-reorder-handle": string;
    onPointerDown: (event: PointerEvent<HTMLElement>) => void;
    onPointerMove: (event: PointerEvent<HTMLElement>) => void;
    onPointerUp: (event: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (event: PointerEvent<HTMLElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  };
}

/**
 * Rows carry `data-reorder-key`, inside `list`, in the order of `keys`; each row's handle spreads
 * `handle(key)`. A drop, or an arrow key, hands `onMove` every key in the new order.
 */
export function useListReorder({ list, keys, onMove }: { list: RefObject<HTMLElement | null>; keys: readonly string[]; onMove: (order: string[]) => void }): ListReorder {
  const [dragging, setDragging] = useState<string | null>(null);
  const drag = useRef<Drag | null>(null);
  const latest = useRef({ keys, onMove });
  useEffect(() => {
    latest.current = { keys, onMove };
  });

  const place = useCallback((d: Drag) => {
    const dy = d.y - d.y0 + d.scroller.scrollTop - d.scroll0;
    d.to = dropIndex(d.slots, d.from, dy);
    d.rows.forEach((row, i) => {
      row.style.translate = `0 ${i === d.from ? dy : shiftFor(d.slots, d.from, d.to, i)}px`;
    });
  }, []);

  const tick = useCallback(() => {
    const d = drag.current;
    if (!d) return;
    const page = d.scroller === document.scrollingElement || d.scroller === document.documentElement;
    const { top, bottom } = page ? { top: 0, bottom: window.innerHeight } : d.scroller.getBoundingClientRect();
    const depth = Math.max(0, top + EDGE - d.y) - Math.max(0, d.y - (bottom - EDGE));
    if (depth !== 0) d.scroller.scrollTop -= Math.sign(depth) * Math.ceil((EDGE_SPEED * Math.min(EDGE, Math.abs(depth))) / EDGE);
    place(d);
    d.frame = requestAnimationFrame(tick);
  }, [place]);

  const end = useCallback((drop: boolean) => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    cancelAnimationFrame(d.frame);
    // The transition goes first, so the rows land in their new places instead of sliding back.
    delete d.list.dataset.reordering;
    // The new order is in the DOM before the transforms come off, so nothing jumps back a frame.
    if (drop && d.to !== d.from) flushSync(() => latest.current.onMove(moveKey(d.keys, d.from, d.to)));
    for (const row of d.rows) row.style.translate = "";
    setDragging(null);
  }, []);

  useEffect(() => () => {
    if (drag.current) cancelAnimationFrame(drag.current.frame);
  }, []);

  const handle = (key: string) => ({
    "data-reorder-handle": key,
    onPointerDown: (event: PointerEvent<HTMLElement>) => {
      const el = list.current;
      if (drag.current || !el || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
      const rows = [...el.querySelectorAll<HTMLElement>("[data-reorder-key]")];
      const base = el.getBoundingClientRect().top;
      const slots = rows.map((row) => {
        const box = row.getBoundingClientRect();
        return { key: row.dataset.reorderKey!, start: box.top - base, width: box.height };
      });
      const from = slots.findIndex((slot) => slot.key === key);
      if (from < 0) return;
      event.preventDefault();
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // A pointer the browser no longer tracks has nothing to capture.
      }
      const scroller = scrollerOf(el);
      drag.current = {
        list: el, rows, slots, keys: slots.map((slot) => slot.key), from, to: from, pointerId: event.pointerId,
        y0: event.clientY, y: event.clientY, scroller, scroll0: scroller.scrollTop, frame: requestAnimationFrame(tick),
      };
      el.dataset.reordering = "";
      buzz();
      setDragging(key);
    },
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      if (drag.current?.pointerId === event.pointerId) drag.current.y = event.clientY;
    },
    onPointerUp: (event: PointerEvent<HTMLElement>) => {
      const d = drag.current;
      if (d?.pointerId !== event.pointerId) return;
      d.y = event.clientY;
      place(d);
      end(true);
    },
    // The system took the pointer: the row goes back where it was.
    onPointerCancel: (event: PointerEvent<HTMLElement>) => {
      if (drag.current?.pointerId === event.pointerId) end(false);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      const order = latest.current.keys;
      const from = order.indexOf(key);
      if (!step || drag.current || from + step < 0 || from + step >= order.length) return;
      event.preventDefault();
      latest.current.onMove(moveKey(order, from, from + step));
      // React moves the row's node, which can drop its focus: hand it back to the same handle.
      requestAnimationFrame(() => [...list.current?.querySelectorAll<HTMLElement>("[data-reorder-handle]") ?? []].find((el) => el.dataset.reorderHandle === key)?.focus());
    },
  });

  return { dragging, handle };
}
