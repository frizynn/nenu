import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { flushSync } from "react-dom";

import { LONG_PRESS_MS, MOVE_CANCEL_PX } from "@/hooks/use-long-press";
import { buzz } from "@/lib/haptics";

// Dragging a chip along its strip to put it somewhere else. A finger holds the chip first: before the
// hold a sideways swipe is the strip scrolling, and after it the chip lifts and follows the finger. A
// mouse drags as soon as it moves with the button down. The other chips slide aside with transforms
// and the DOM keeps its order until the drop: React moving the dragged node would release its
// pointer capture mid-drag. A hold released in place, and a right-click, open the chip's actions.

// A hold and a finger's slop are the long-press's own (use-long-press.ts), so a hold means the same
// thing on every chip: past the slop before the hold, the finger is scrolling the strip.
// After the hold, this far from where the chip lifted starts the drag; less is a held finger's jitter.
const LIFTED_SLOP = 8;
// A mouse that travels this far with its button down is dragging.
const MOUSE_SLOP = 5;
// The click a hold or a drop ends with can trail the release by a task or two (iOS after touchend).
const CLICK_AFTER_MS = 600;
// Dragged into the strip's edge fade (chip.tsx EDGE_FADE), the strip scrolls that way, faster deeper in.
const EDGE = 40;
const EDGE_SPEED = 12;

export interface ReorderSlot {
  key: string;
  /** Where the item starts along its axis and how long it is: here a chip's offsetLeft/offsetWidth in the
   *  strip's scroll coordinates, transforms aside; ui/list-reorder.ts gives a row's top and height. */
  start: number;
  width: number;
}

/** Where a chip dragged `dx` from slot `from` lands: past every other chip whose middle it crossed. */
export function dropIndex(slots: readonly ReorderSlot[], from: number, dx: number): number {
  const dragged = slots[from]!;
  const middle = dragged.start + dragged.width / 2 + dx;
  return slots.filter((slot, i) => i !== from && slot.start + slot.width / 2 < middle).length;
}

/** `keys` with the key at `from` moved to index `to`. */
export function moveKey(keys: readonly string[], from: number, to: number): string[] {
  const next = keys.filter((_, i) => i !== from);
  next.splice(to, 0, keys[from]!);
  return next;
}

/** How far each chip slides while the one at `from` hovers over index `to`: the dragged chip's
 *  width plus the gap, toward the slot it left. The dragged chip itself follows the pointer. */
export function shiftFor(slots: readonly ReorderSlot[], from: number, to: number, i: number): number {
  const gap = slots.length > 1 ? slots[1]!.start - slots[0]!.start - slots[0]!.width : 0;
  const step = slots[from]!.width + gap;
  if (from < to && i > from && i <= to) return -step;
  if (to < from && i >= to && i < from) return step;
  return 0;
}

interface Gesture {
  key: string;
  chip: HTMLElement;
  pointerId: number;
  mouse: boolean;
  x0: number;
  y0: number;
  x: number;
  y: number;
  timer: ReturnType<typeof setTimeout>;
  /** Where the pointer was when the chip lifted; null until the hold completes. */
  lifted: { x: number; y: number } | null;
  /** Set once the chip moves: the order it started from and the slots measured then. */
  drag: { keys: string[]; slots: ReorderSlot[]; chips: HTMLElement[]; from: number; to: number; x0: number; scroll0: number } | null;
}

interface Options {
  scroller: RefObject<HTMLElement | null>;
  /** The chips' keys in the order the data has them. */
  keys: readonly string[];
  /** Off: the chips are plain tap targets (no write access, or nowhere to send a move). */
  enabled: boolean;
  /** Commit a move: `key` now sits before `before` (null: last). Resolves whether it took. */
  onMove: (key: string, before: string | null) => Promise<boolean>;
  /** A hold released in place, or a right-click: the chip's actions. */
  onHold: (key: string) => void;
}

export interface StripReorder {
  /** The order to draw: a move on its way to Herdr shows at once, and reverts if Herdr refuses it. */
  order: readonly string[];
  /** The chip held or dragged right now, which strips.css lifts. */
  lifted: string | null;
  /** Move a chip to index `to` of `order` without a drag (the actions sheet's Move left/right). */
  moveTo: (key: string, to: number) => void;
}

export function useStripReorder({ scroller, keys, enabled, onMove, onHold }: Options): StripReorder {
  const [lifted, setLifted] = useState<string | null>(null);
  // A move on its way to Herdr, drawn over the order it was made on. Any other order from the data
  // (Herdr's answer, or a move made somewhere else meanwhile) ends it: Herdr's order is the truth.
  const [pending, setPending] = useState<{ base: string; order: string[] } | null>(null);
  const keyText = keys.join("\n");
  const order = pending?.base === keyText ? pending.order : keys;
  useEffect(() => {
    if (pending && pending.base !== keyText) setPending(null);
  }, [pending, keyText]);

  const latest = useRef({ keyText, order, onMove, onHold });
  useEffect(() => {
    latest.current = { keyText, order, onMove, onHold };
  });

  const commit = useCallback((next: string[], key: string) => {
    const before = next[next.indexOf(key) + 1] ?? null;
    void latest.current.onMove(key, before).then((ok) => { if (!ok) setPending(null); }, () => setPending(null));
  }, []);

  const moveTo = useCallback((key: string, to: number) => {
    const current = latest.current.order;
    const from = current.indexOf(key);
    if (from < 0 || to < 0 || to >= current.length || to === from) return;
    const next = moveKey(current, from, to);
    setPending({ base: latest.current.keyText, order: next });
    commit(next, key);
  }, [commit]);

  useEffect(() => {
    const el = scroller.current;
    if (!el || !enabled) return;
    let g: Gesture | null = null;
    let swallowClicksUntil = 0;
    let frame = 0;

    const chipAt = (target: EventTarget | null) => {
      const chip = target instanceof Element ? target.closest<HTMLElement>("[data-reorder-key]") : null;
      return chip && el.contains(chip) ? chip : null;
    };

    const finish = () => {
      if (!g) return;
      clearTimeout(g.timer);
      cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", cancel);
      if (g.drag) {
        // The transition goes first, so the chips land in their new slots instead of sliding back.
        delete el.dataset.reordering;
        for (const chip of g.drag.chips) chip.style.translate = "";
      }
      g = null;
      setLifted(null);
    };

    // The dragged chip under the pointer, the others aside, and the slot it would drop into.
    const place = (drag: NonNullable<Gesture["drag"]>, x: number) => {
      const dx = x - drag.x0 + el.scrollLeft - drag.scroll0;
      drag.to = dropIndex(drag.slots, drag.from, dx);
      drag.chips.forEach((chip, i) => {
        chip.style.translate = `${i === drag.from ? dx : shiftFor(drag.slots, drag.from, drag.to, i)}px 0`;
      });
    };

    // Each frame of a drag: scroll toward an edge the pointer is in, then place the chips.
    const tick = () => {
      if (!g?.drag) return;
      const box = el.getBoundingClientRect();
      const depth = Math.max(0, box.left + EDGE - g.x) - Math.max(0, g.x - (box.right - EDGE));
      if (depth !== 0) el.scrollLeft -= Math.sign(depth) * Math.ceil((EDGE_SPEED * Math.min(EDGE, Math.abs(depth))) / EDGE);
      place(g.drag, g.x);
      frame = requestAnimationFrame(tick);
    };

    const startDrag = (gesture: Gesture) => {
      const chips = [...el.querySelectorAll<HTMLElement>("[data-reorder-key]")];
      const slots = chips.map((chip) => ({ key: chip.dataset.reorderKey!, start: chip.offsetLeft, width: chip.offsetWidth }));
      const from = slots.findIndex((slot) => slot.key === gesture.key);
      gesture.drag = { keys: slots.map((slot) => slot.key), slots, chips, from, to: from, x0: gesture.x0, scroll0: el.scrollLeft };
      if (!gesture.lifted) {
        gesture.lifted = { x: gesture.x, y: gesture.y };
        setLifted(gesture.key);
      }
      el.dataset.reordering = "";
      try {
        gesture.chip.setPointerCapture?.(gesture.pointerId);
      } catch {
        // A pointer the browser no longer tracks has nothing to capture; the window listeners still follow it.
      }
      frame = requestAnimationFrame(tick);
    };

    const lift = () => {
      if (!g || g.lifted) return;
      g.lifted = { x: g.x, y: g.y };
      buzz();
      setLifted(g.key);
    };

    const down = (e: PointerEvent) => {
      if (g || !e.isPrimary) return;
      const chip = chipAt(e.target);
      if (!chip || (e.pointerType === "mouse" && e.button !== 0)) return;
      swallowClicksUntil = 0;
      g = {
        key: chip.dataset.reorderKey!, chip, pointerId: e.pointerId, mouse: e.pointerType === "mouse",
        x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, timer: setTimeout(lift, LONG_PRESS_MS), lifted: null, drag: null,
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
      window.addEventListener("pointercancel", cancel);
    };

    const move = (e: PointerEvent) => {
      if (!g || e.pointerId !== g.pointerId) return;
      g.x = e.clientX;
      g.y = e.clientY;
      if (g.drag) return;
      const origin = g.lifted ?? { x: g.x0, y: g.y0 };
      const far = Math.max(Math.abs(e.clientX - origin.x), Math.abs(e.clientY - origin.y));
      if (far <= (g.mouse ? MOUSE_SLOP : g.lifted ? LIFTED_SLOP : MOVE_CANCEL_PX)) return;
      if (g.mouse || g.lifted) {
        clearTimeout(g.timer);
        startDrag(g);
      } else {
        finish();
      }
    };

    const up = (e: PointerEvent) => {
      if (!g || e.pointerId !== g.pointerId) return;
      const { key, lifted: held, drag } = g;
      if (drag) {
        place(drag, e.clientX);
        swallowClicksUntil = performance.now() + CLICK_AFTER_MS;
        const next = moveKey(drag.keys, drag.from, drag.to);
        // The new order is in the DOM before the transforms come off, so nothing jumps back a frame.
        if (drag.to !== drag.from) flushSync(() => setPending({ base: latest.current.keyText, order: next }));
        finish();
        if (drag.to !== drag.from) commit(next, key);
      } else if (held) {
        swallowClicksUntil = performance.now() + CLICK_AFTER_MS;
        finish();
        latest.current.onHold(key);
      } else {
        finish();
      }
    };

    // The browser took the touch (a scroll began), or the system did. A drag goes back where it was;
    // a chip already held still opens its actions, as a long-press did before the drag existed.
    const cancel = (e: PointerEvent) => {
      if (!g || e.pointerId !== g.pointerId) return;
      const { key, lifted: held, drag } = g;
      finish();
      if (held && !drag) latest.current.onHold(key);
    };

    // Android raises contextmenu at the end of a long-press, a desk on a right-click. A finger's hold
    // is ours to finish; a right-click opens the actions at once.
    const menu = (e: MouseEvent) => {
      const chip = chipAt(e.target);
      if (!chip) return;
      e.preventDefault();
      if (g && !g.mouse) return;
      latest.current.onHold(chip.dataset.reorderKey!);
    };

    // A held chip owns the finger: the strip must not scroll under it.
    const touchMove = (e: TouchEvent) => {
      if (g?.lifted && e.cancelable) e.preventDefault();
    };

    // The click a hold or a drop ends with is not a tap on the chip.
    const click = (e: MouseEvent) => {
      if (performance.now() > swallowClicksUntil) return;
      swallowClicksUntil = 0;
      e.preventDefault();
      e.stopPropagation();
    };

    el.addEventListener("pointerdown", down);
    el.addEventListener("contextmenu", menu);
    el.addEventListener("touchmove", touchMove, { passive: false });
    el.addEventListener("click", click, true);
    return () => {
      finish();
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("contextmenu", menu);
      el.removeEventListener("touchmove", touchMove);
      el.removeEventListener("click", click, true);
    };
  }, [scroller, enabled, commit]);

  return { order, lifted, moveTo };
}
