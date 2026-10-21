import { useEffect, useState, type RefObject } from "react";

import { isLocked, useLocked } from "./idle";

// The only motion that lasts (ADR 0117): what shows that an agent works now, the glow across a running
// turn's live line and the working mark's slow turn. Every one shares this observer and moves only
// while it is on screen, the page is shown, the idle lock is down and motion is not reduced; otherwise
// it is still and costs nothing.
//
// They move in steps, from one shared timer, by writing a transform: a CSS animation, even one in
// `steps()`, keeps the compositor drawing every frame for as long as it runs, which cost ~1.5 s of CPU
// every 30 s whatever the step count (scripts/e2e/live-motion.ts). A step written by hand draws a frame
// only when something moved, and every motion steps on the same tick.

/** One pass of every live motion. */
export const LIVE_PASS_MS = 2200;

interface Live {
  visible: boolean;
  moving: boolean;
  set: (moving: boolean) => void;
  /** Steps per pass, and what draws step `n` of them. */
  steps: number;
  draw: (n: number) => void;
}

const live = new Map<Element, Live>();
let observer: IntersectionObserver | null = null;
let reduced: MediaQueryList | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Draw every moving one at the step the page's clock is on, then wait for the next step boundary. */
function tick() {
  timer = undefined;
  const now = performance.now();
  let next = Infinity;
  for (const item of live.values()) {
    if (!item.moving) continue;
    const step = LIVE_PASS_MS / item.steps;
    item.draw(Math.floor(now / step) % item.steps);
    next = Math.min(next, step - (now % step));
  }
  if (next !== Infinity) timer = setTimeout(tick, Math.ceil(next));
}

function sync() {
  const still = document.hidden || isLocked() || !!reduced?.matches;
  for (const item of live.values()) {
    item.moving = item.visible && !still;
    item.set(item.moving);
  }
  if (timer !== undefined) clearTimeout(timer);
  tick();
}

function watch(element: Element, item: Pick<Live, "set" | "steps" | "draw">): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const watched = live.get(entry.target);
        if (watched) watched.visible = entry.isIntersecting;
      }
      sync();
    });
    reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    reduced?.addEventListener("change", sync);
    document.addEventListener("visibilitychange", sync);
  }
  live.set(element, { ...item, visible: false, moving: false });
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
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    }
  };
}

/**
 * Whether the live element behind `ref` may move now; while it does, `draw(n)` runs on each step `n`
 * of `steps` per pass. `draw` writes through refs, so the first one serves the element's whole life.
 * `on` false leaves it still and unwatched.
 */
export function useLiveMotion(ref: RefObject<Element | null>, steps: number, draw: (n: number) => void, on = true): boolean {
  const locked = useLocked();
  const [moving, setMoving] = useState(false);
  useEffect(() => {
    if (!on || !ref.current) return;
    const stop = watch(ref.current, { set: setMoving, steps, draw });
    return () => { stop(); setMoving(false); };
  }, [ref, on, steps]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(sync, [locked]);
  return on && moving;
}
