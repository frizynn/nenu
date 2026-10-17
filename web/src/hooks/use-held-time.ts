import { useEffect, useReducer, useRef } from "react";

/**
 * The time a list sorts each row by, held at what it was when the row first came on screen, so rows
 * already in view never trade places under a finger or a pointer while their agents work. A row that
 * arrives takes its own time and lands where it belongs, and so does a row whose agent turns to `news`
 * (it finished or asks for you): that move is the notice, since a finished agent raises no toast
 * (ADR 0094), and below the fold or under an old period it would go unseen. The whole hold lets go when the operator comes back
 * to the page (it was hidden, or the window lost focus), and with every fresh mount: the list then
 * reads the herd as it is now. Not on a navigation: on a desk the bar stays up, and the row just
 * clicked moved 120 px when its own visit re-sorted it. A live order measured 250 row moves a minute
 * on a phone's Home with a busy herd (`bun scripts/e2e/calm.ts`).
 */
export function useHeldTime<T>(key: (item: T) => string, at: (item: T) => number, news: (item: T) => boolean): (item: T) => number {
  const held = useRef(new Map<string, { time: number; news: boolean }>());
  const [, release] = useReducer((n: number) => n + 1, 0);
  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState !== "visible") return;
      held.current = new Map();
      release();
    };
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, []);
  return (item) => {
    const id = key(item);
    const now = news(item);
    const last = held.current.get(id);
    const time = !last || (now && !last.news) ? at(item) : last.time;
    held.current.set(id, { time, news: now });
    return time;
  };
}
