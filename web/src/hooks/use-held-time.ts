import { useCallback, useEffect, useReducer, useRef } from "react";

/**
 * The time a list sorts each row by, held at what it was when the row first came on screen, so rows
 * already in view never trade places under a finger or a pointer while their agents work. A row that
 * arrives takes its own time and lands where it belongs; a row that finishes stays put and says so in
 * place (New, +1). The hold lets go when the operator comes back to the page (it was hidden, or the
 * window lost focus), on `reorder` (the list's "N updates"), and with every fresh mount. Not on a
 * navigation: on a desk the bar stays up, and the row just clicked moved 120 px when its own visit
 * re-sorted it. A live order measured 250 row moves a minute on a phone's Home with a busy herd
 * (`bun scripts/e2e/calm.ts`).
 */
export function useHeldTime<T>(key: (item: T) => string, at: (item: T) => number): {
  at: (item: T) => number;
  /** How many of `items` sit somewhere else in the order their latest times give: what `reorder` would move. */
  moved: (items: readonly T[]) => number;
  reorder: () => void;
} {
  const held = useRef(new Map<string, number>());
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
  const heldAt = (item: T) => {
    const id = key(item);
    let time = held.current.get(id);
    if (time === undefined) held.current.set(id, time = at(item));
    return time;
  };
  const moved = (items: readonly T[]) => {
    const live = [...items].sort((a, b) => at(b) - at(a));
    return [...items].sort((a, b) => heldAt(b) - heldAt(a)).filter((item, index) => live[index] !== item).length;
  };
  return { at: heldAt, moved, reorder };
}
