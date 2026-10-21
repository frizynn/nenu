import { useEffect, useRef, useState, type ReactNode } from "react";

// How long a row above the box takes to fold open and to fold shut (the direction's enter and exit).
const FOLD_OPEN_MS = 220;
const FOLD_SHUT_MS = 150;
// How long a chat takes to settle: its chips come from reads that answer after it mounts.
const FOLD_SETTLE_MS = 2000;

/**
 * A row above the box (the chips' line, a notice) folds open and shut instead of appearing at once, so the
 * thread above moves with it rather than jumping. One already there on mount, or arriving while the
 * chat is still settling (the chips its first reads bring), is simply there: opening a chat must not
 * play a fold that walks the conversation up in steps. Folding shut, it keeps showing what it last
 * showed, out of reach: inert and hidden from assistive tech, so a control on its way out can never
 * be pressed.
 */
export function Fold<T>({ value, children }: { value: T | null | false; children: (value: T) => ReactNode }) {
  const [phase, setPhase] = useState<"open" | "opening" | "shutting" | "shut">(value ? "open" : "shut");
  const [mountedAt] = useState(() => Date.now());
  const last = useRef<T | null>(null);
  if (value) last.current = value;
  const shown = Boolean(value);
  useEffect(() => setPhase((current) => (shown
    ? current === "open" ? current : Date.now() - mountedAt < FOLD_SETTLE_MS ? "open" : "opening"
    : current === "shut" ? current : "shutting")), [shown, mountedAt]);
  useEffect(() => {
    if (phase !== "opening" && phase !== "shutting") return;
    const timer = setTimeout(() => setPhase(phase === "opening" ? "open" : "shut"), phase === "opening" ? FOLD_OPEN_MS : FOLD_SHUT_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  if (phase === "shut" || last.current === null) return null;
  const shutting = phase === "shutting";
  return (
    <div className="composer-fold" data-phase={phase} inert={shutting} aria-hidden={shutting || undefined}>
      <div>{children(last.current)}</div>
    </div>
  );
}
