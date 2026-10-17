import { useCallback, useEffect, useReducer, useRef } from "react";

/**
 * The time a list sorts each row by, held at what it was when the row first came on screen, so rows
 * already in view never trade places under a finger or a pointer while their agents work. A row that
 * arrives takes its own time and lands where it belongs; a row that finishes stays put and says so in
 * place (New, +1). The hold lets go when the operator comes back to the page (it was hidden, or the
 * window lost focus), on `reorder` (the list's "N updates"), and with every fresh mount. Not on a
 * navigation: on a desk the bar stays up, and the row just clicked moved 120 px when its own visit
 * re-sorted it. A live order measured 250 row moves a minute on a phone's Home with a busy herd
 * (`bun scripts/e2e/calm.ts`). Rows with the same time keep the order they first came in: the list
 * hands them over in an order that changes with their state.
 */
export function useHeldTime<T>(key: (item: T) => string, at: (item: T) => number): {
  at: (item: T) => number;
  /** `items` newest held time first, ties in the order they first came. */
  order: (items: readonly T[]) => T[];
  /** How many of `items` moved since the list drew them: the agents with news that `reorder` puts in order. */
  moved: (items: readonly T[]) => number;
  reorder: () => void;
} {
  const held = useRef(new Map<string, { time: number; seq: number }>());
  const [, redraw] = useReducer((n: number) => n + 1, 0);
  const reorder = useCallback(() => {
    held.current = new Map();
    redraw();
  }, []);
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === "visible") reorder();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [reorder]);
  const entry = (item: T) => {
    const id = key(item);
    let found = held.current.get(id);
    if (!found) held.current.set(id, found = { time: at(item), seq: held.current.size });
    return found;
  };
  const heldAt = (item: T) => entry(item).time;
  const order = (items: readonly T[]) => {
    // Rows new to the list take their place in the tie order as handed over, before any comparison.
    for (const item of items) entry(item);
    return [...items].sort((a, b) => heldAt(b) - heldAt(a) || entry(a).seq - entry(b).seq);
  };
  const moved = (items: readonly T[]) => items.filter((item) => at(item) !== heldAt(item)).length;
  return { at: heldAt, order, moved, reorder };
}
