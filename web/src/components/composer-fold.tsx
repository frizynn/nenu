import { useEffect, useRef, useState, type ReactNode } from "react";

import { MOTION_CONTROL_MS, MOTION_PANEL_MS } from "@/lib/motion";

// How long a row above the box takes to fold open and to fold shut: composer.css's .composer-fold.
const FOLD_OPEN_MS = MOTION_PANEL_MS;
const FOLD_SHUT_MS = MOTION_CONTROL_MS;

/**
 * A row above the box (a notice, the busy choice) folds open and shut instead of appearing at once, so
 * the thread above moves with it rather than jumping. One already there on mount is simply there.
 * Folding shut, it keeps showing what it last showed, out of reach: inert and hidden from assistive
 * tech, so a control on its way out can never be pressed.
 */
export function Fold<T>({ value, children }: { value: T | null | false; children: (value: T) => ReactNode }) {
  const [phase, setPhase] = useState<"open" | "opening" | "shutting" | "shut">(value ? "open" : "shut");
  const last = useRef<T | null>(null);
  if (value) last.current = value;
  const shown = Boolean(value);
  useEffect(() => setPhase((current) => (shown
    ? current === "open" ? current : "opening"
    : current === "shut" ? current : "shutting")), [shown]);
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
