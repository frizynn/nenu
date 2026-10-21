import { useEffect, useRef } from "react";
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

/** The live mark: a still dot in the working colour. The words say the state; nothing here moves. */
export function LiveGlyph({ className }: { className?: string }) {
  return <span data-live-glyph aria-hidden="true" className={cn("inline-flex size-4 shrink-0 items-center justify-center text-status-working", className)}>
    <span className="size-1.5 rounded-full bg-current" />
  </span>;
}

/** "Working for 3m" with its live mark, where no turn line says it yet. */
export function WorkActivityLabel({ startedAt }: { startedAt?: string }) {
  return <span className="inline-flex items-center gap-1.5 text-footnote text-muted-foreground">
    <LiveGlyph className="size-3.5" />
    <Elapsed since={startedAt} prefix="Working for " fallback="Working…" />
  </span>;
}
