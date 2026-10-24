import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { flushSync } from "react-dom";

import { dropIndex, moveKey, shiftFor, type ReorderSlot } from "@/components/ui/strip-reorder";
import { buzz } from "@/lib/haptics";

// Dragging a row up or down its list by its handle. The handle takes the touch (`touch-action: none`)
// so a finger on it drags at once while the rest of the list scrolls as before, and a mouse drags the
// same way. The other rows slide aside with transforms and the DOM keeps its order until the drop, as
// a strip's chips do (ui/strip-reorder.ts, whose slot arithmetic this reuses on the vertical axis: a
// slot's `start` and `width` are a row's top and height here). As there, the pointer is followed on
// the window, so a handle that leaves the DOM mid-drag (its workspace closed) still ends the drag.
// Arrow keys on a handle move its row.

// Dragged this close to the scroller's top or bottom edge, the list scrolls that way, faster deeper in.
const EDGE = 48;
const EDGE_SPEED = 12;
// Nothing moves until the pointer has travelled this far: a still press on a handle near the edge
// must not start the edge scroll under the finger.
const SLOP = 4;

interface Drag {
  key: string;
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
  /** The animation frame of a drag past SLOP; 0 before. */
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
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  };
}

/**
 * Rows carry `data-reorder-key`, inside `list`, in the order of `keys`; each row's handle spreads
 * `handle(key)`. A drop, or an arrow key, hands `onMove` every key in the new order and the one that
 * moved. A drag ends
 * without a move when `enabled` goes off or its row leaves `keys`.
 */
export function useListReorder({ list, keys, enabled, onMove }: {
  list: RefObject<HTMLElement | null>;
  keys: readonly string[];
  enabled: boolean;
  onMove: (order: string[], key: string) => void;
}): ListReorder {
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

  // Set once per mount: the window listeners a drag adds, and how it ends.
  const end = useRef<(drop: boolean) => void>(() => {});
  const follow = useRef<{ move: (e: PointerEvent) => void; up: (e: PointerEvent) => void; cancel: (e: PointerEvent) => void } | null>(null);
  if (!follow.current) {
    const finish = (drop: boolean) => {
      const d = drag.current;
      if (!d) return;
      drag.current = null;
      cancelAnimationFrame(d.frame);
      window.removeEventListener("pointermove", follow.current!.move);
      window.removeEventListener("pointerup", follow.current!.up);
      window.removeEventListener("pointercancel", follow.current!.cancel);
      // The transition goes first, so the rows land in their new places instead of sliding back.
      delete d.list.dataset.reordering;
      // The new order is in the DOM before the transforms come off, so nothing jumps back a frame.
      if (drop && d.frame !== 0 && d.to !== d.from) flushSync(() => latest.current.onMove(moveKey(d.keys, d.from, d.to), d.key));
      for (const row of d.rows) row.style.translate = "";
      setDragging(null);
    };
    end.current = finish;
    follow.current = {
      move: (e) => {
        const d = drag.current;
        if (d?.pointerId !== e.pointerId) return;
        d.y = e.clientY;
        if (d.frame === 0 && Math.abs(d.y - d.y0) > SLOP) d.frame = requestAnimationFrame(tick);
      },
      up: (e) => {
        const d = drag.current;
        if (d?.pointerId !== e.pointerId) return;
        d.y = e.clientY;
        if (d.frame !== 0) place(d);
        finish(true);
      },
      // The system took the pointer: the row goes back where it was.
      cancel: (e) => {
        if (drag.current?.pointerId === e.pointerId) finish(false);
      },
    };
  }

  // A drag whose row went away (its workspace closed, a filter left it out), or whose list stopped
  // being reordered, ends where it is.
  const keyText = keys.join("\n");
  useEffect(() => {
    const d = drag.current;
    if (d && (!enabled || !keyText.split("\n").includes(d.key))) end.current(false);
  }, [enabled, keyText]);
  useEffect(() => () => end.current(false), []);

  const handle = (key: string) => ({
    "data-reorder-handle": key,
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      const el = list.current;
      if (drag.current || !enabled || !el || !event.isPrimary || (event.pointerType === "mouse" && event.button !== 0)) return;
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
        // A pointer the browser no longer tracks has nothing to capture; the window listeners still follow it.
      }
      const scroller = scrollerOf(el);
      drag.current = {
        key, list: el, rows, slots, keys: slots.map((slot) => slot.key), from, to: from, pointerId: event.pointerId,
        y0: event.clientY, y: event.clientY, scroller, scroll0: scroller.scrollTop, frame: 0,
      };
      window.addEventListener("pointermove", follow.current!.move);
      window.addEventListener("pointerup", follow.current!.up);
      window.addEventListener("pointercancel", follow.current!.cancel);
      el.dataset.reordering = "";
      buzz();
      setDragging(key);
    },
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      const step = event.key === "ArrowUp" ? -1 : event.key === "ArrowDown" ? 1 : 0;
      const order = latest.current.keys;
      const from = order.indexOf(key);
      if (!step || drag.current || from + step < 0 || from + step >= order.length) return;
      event.preventDefault();
      latest.current.onMove(moveKey(order, from, from + step), key);
      // React moves the row's node, which can drop its focus: hand it back to the same handle.
      requestAnimationFrame(() => [...list.current?.querySelectorAll<HTMLElement>("[data-reorder-handle]") ?? []].find((el) => el.dataset.reorderHandle === key)?.focus());
    },
  });

  return { dragging, handle };
}
