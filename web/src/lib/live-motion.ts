import { useEffect, useState, type RefObject } from "react";

import { isLocked, useLocked } from "./idle";

// The only motion that lasts (ADR 0117): what shows that an agent works now, the glow across a running
// turn's live line and the working mark's slow turn. Every one shares this observer and moves only
// while it is on screen, the page is shown, the idle lock is down and motion is not reduced; otherwise
// its animation is not in the page at all, so a still one costs nothing.

const live = new Map<Element, { visible: boolean; set: (moving: boolean) => void }>();
let observer: IntersectionObserver | null = null;
let reduced: MediaQueryList | null = null;

function sync() {
  const still = document.hidden || isLocked() || !!reduced?.matches;
  for (const item of live.values()) item.set(item.visible && !still);
}

function watch(element: Element, set: (moving: boolean) => void): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const item = live.get(entry.target);
        if (item) item.visible = entry.isIntersecting;
      }
      sync();
    });
    reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    reduced?.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
  }
  live.set(element, { visible: false, set });
  observer.observe(element);
  return () => {
    live.delete(element);
    observer?.unobserve(element);
    if (live.size === 0 && observer) {
      observer.disconnect();
      observer = null;
      reduced?.removeEventListener("change", sync);
      reduced = null;
      document.removeEventListener("visibilitychange", sync);
    }
  };
}

/** Whether the live element behind `ref` may move now. `on` false leaves it still and unwatched. */
export function useLiveMotion(ref: RefObject<Element | null>, on = true): boolean {
  const locked = useLocked();
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    if (!on || !ref.current) return;
    const stop = watch(ref.current, setMoving);
    return () => { stop(); setMoving(false); };
  }, [ref, on]);
  useEffect(sync, [locked]);
  return on && moving;
}
