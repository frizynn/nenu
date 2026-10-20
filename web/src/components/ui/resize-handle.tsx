import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { cn } from "@/lib/utils";

/** A column's widths in px: the narrowest, the one a double-click returns to, the widest, and a key's step. */
export interface WidthRange {
  min: number;
  initial: number;
  max: number;
  step: number;
}

export const clampTo = (range: WidthRange, width: number, max = range.max) =>
  Math.round(Math.min(Math.max(range.min, max), Math.max(range.min, width)));

/**
 * The edge of a desk's column, dragged to set its width: a grip centred on the column's border that
 * shows a seam under the pointer, while held and on focus. A drag writes the column's width on the
 * element itself (no render per move) and hands the end to `onChange`; arrows step it (Shift four
 * steps), Home and End go to the limits, a double-click returns to the default. `edge` is the side of
 * its column it sits on: the sidebar's end, a right column's start. `limit` is the widest the window
 * leaves room for now, below `range.max`.
 */
export function ResizeHandle({ label, edge, width, range, limit, onChange, className }: {
  label: string;
  edge: "start" | "end";
  width: number;
  range: WidthRange;
  limit?: (column: HTMLElement) => number;
  onChange: (width: number) => void;
  className?: string;
}) {
  const drag = useRef<{ x: number; width: number; max: number; moved: boolean; column: HTMLElement } | null>(null);
  const [dragging, setDragging] = useState(false);
  const max = (column: HTMLElement | null) => Math.min(range.max, column && limit ? limit(column) : range.max);
  // Away from its column widens it: right for the sidebar's end, left for a right column's start.
  const sign = edge === "end" ? 1 : -1;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const column = event.currentTarget.parentElement;
    if (event.button !== 0 || !column) return;
    // No text selection in the chat while the edge moves.
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, width: Math.round(column.getBoundingClientRect().width), max: max(column), moved: false, column };
    document.documentElement.dataset.resizing = "";
    setDragging(true);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const next = clampTo(range, state.width + sign * (event.clientX - state.x), state.max);
    state.moved ||= next !== state.width;
    state.column.style.width = `${next}px`;
  };
  // The capture ends on a release, a cancel, or the column leaving mid-drag (a fold, a docked thread
  // gone): each ends the drag, so the page never keeps the drag's cursor and its selection off.
  const endDrag = () => {
    const state = drag.current;
    if (!state) return;
    drag.current = null;
    delete document.documentElement.dataset.resizing;
    setDragging(false);
    // A press that moved nothing chooses no width, and a column that left keeps the one it had.
    if (state.moved && state.column.isConnected) onChange(Math.round(state.column.getBoundingClientRect().width));
  };
  useEffect(() => () => { if (drag.current) delete document.documentElement.dataset.resizing; }, []);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? range.step * 4 : range.step;
    const widest = max(event.currentTarget.parentElement);
    const next = event.key === "Home" ? range.min
      : event.key === "End" ? widest
      : event.key === "ArrowRight" ? width + sign * step
      : event.key === "ArrowLeft" ? width - sign * step
      : undefined;
    if (next === undefined) return;
    event.preventDefault();
    onChange(clampTo(range, next, widest));
  };

  return (
    <div role="separator" aria-orientation="vertical" aria-label={label} tabIndex={0}
      aria-valuenow={width} aria-valuemin={range.min} aria-valuemax={range.max}
      title="Drag to resize · double-click to reset"
      data-edge={edge} data-dragging={dragging || undefined}
      className={cn("resize-handle", className)}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onLostPointerCapture={endDrag} onPointerUp={endDrag} onPointerCancel={endDrag}
      onDoubleClick={(event) => onChange(clampTo(range, range.initial, max(event.currentTarget.parentElement)))} onKeyDown={onKeyDown} />
  );
}
