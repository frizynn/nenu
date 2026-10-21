import { useEffect, useRef, useState, type ReactNode } from "react";
import { formatElapsed } from "@/lib/activity";
import { isLocked, useLocked } from "@/lib/idle";
import { cn } from "@/lib/utils";

const SECOND = 1000;
const MINUTE = 60_000;

/**
 * The time since `since` in whole minutes ("3m", after `prefix`), or `fallback` without a usable
 * start; `fine` counts the first minute in seconds ("9s"), as a turn's own line does. Only this text
 * node changes, once a minute on the minute since `since` (each second of a fine first minute), so the
 * transcript around it never re-renders for it; it stops while the page is hidden or the idle lock is
 * up and catches up when either ends. The exact duration shows once the turn ends.
 */
export function Elapsed({ since, prefix = "", fallback = "", fine = false, className }: { since?: string; prefix?: string; fallback?: string; fine?: boolean; className?: string }) {
  const text = useRef<HTMLSpanElement>(null);
  const locked = useLocked();
  const start = since ? Date.parse(since) : NaN;
  const seconds = () => fine && Date.now() - start < MINUTE;
  const label = () => !Number.isFinite(start) || start > Date.now() ? fallback
    : `${prefix}${seconds() ? `${Math.floor((Date.now() - start) / SECOND)}s` : formatElapsed(Date.now() - start)}`;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      if (text.current) text.current.textContent = label();
      const step = seconds() ? SECOND : MINUTE;
      timer = setTimeout(tick, step - (((Date.now() - start) % step) + step) % step);
    };
    const sync = () => {
      if (timer) clearTimeout(timer);
      timer = undefined;
      if (document.hidden || isLocked()) return;
      if (Number.isFinite(start)) tick();
      else if (text.current) text.current.textContent = label();
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => { if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", sync); };
  }, [since, prefix, fallback, fine, locked]);
  return <span ref={text} className={cn("tabular-nums", className)}>{label()}</span>;
}

// Every glow on the page shares one observer: a glow moves only while it is on screen, the page is
// shown, the idle lock is down and motion is not reduced (ADR 0117). Otherwise its moving copy is not
// even in the page, so a still glow costs nothing and its words are on the page once.
const glows = new Map<Element, { visible: boolean; set: (running: boolean) => void }>();
let observer: IntersectionObserver | null = null;
let reduced: MediaQueryList | null = null;

function syncGlows() {
  const still = document.hidden || isLocked() || !!reduced?.matches;
  for (const glow of glows.values()) glow.set(glow.visible && !still);
}

function watchGlow(element: Element, set: (running: boolean) => void): () => void {
  if (typeof IntersectionObserver === "undefined") return () => {};
  if (!observer) {
    observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const glow = glows.get(entry.target);
        if (glow) glow.visible = entry.isIntersecting;
      }
      syncGlows();
    });
    reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
    reduced?.addEventListener("change", syncGlows);
    document.addEventListener("visibilitychange", syncGlows);
  }
  glows.set(element, { visible: false, set });
  observer.observe(element);
  return () => {
    glows.delete(element);
    observer?.unobserve(element);
    if (glows.size === 0 && observer) {
      observer.disconnect();
      observer = null;
      reduced?.removeEventListener("change", syncGlows);
      reduced = null;
      document.removeEventListener("visibilitychange", syncGlows);
    }
  };
}

/**
 * A live line, glowing: a light passes across its words while the agent works (ADR 0117). While it
 * runs, the words are drawn a second time in the full ink behind a window that slides over them (the
 * copy hidden from assistive tech); `layout` lays out both copies alike (a row's flex classes).
 */
export function Glow({ children, className, layout }: { children: ReactNode; className?: string; layout?: string }) {
  const locked = useLocked();
  const [running, setRunning] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => (ref.current ? watchGlow(ref.current, setRunning) : undefined), []);
  useEffect(syncGlows, [locked]);
  return <span ref={ref} data-glow={running ? "running" : "still"} className={cn("relative min-w-0 overflow-hidden", layout, className)}>
    {children}
    {running && <span aria-hidden="true" className="glow-window">
      <span className="glow-copy"><span className={cn("block text-foreground", layout)}>{children}</span></span>
    </span>}
  </span>;
}

/** "Working for 3m", glowing, where no turn line says it yet. */
export function WorkActivityLabel({ startedAt }: { startedAt?: string }) {
  return <Glow className="inline-flex text-footnote text-muted-foreground">
    <Elapsed since={startedAt} prefix="Working for " fallback="Working…" />
  </Glow>;
}
