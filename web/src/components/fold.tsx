import { useEffect, useRef, useState, type ReactNode } from "react";

import { MOTION_CONTROL_MS, MOTION_PANEL_MS } from "@/lib/motion";

// How long a fold takes to open and to shut: index.css's .fold.
const FOLD_OPEN_MS = MOTION_PANEL_MS;
const FOLD_SHUT_MS = MOTION_CONTROL_MS;

/**
 * What folds open and shut instead of appearing at once (a row above the box, a turn's work, a step's
 * output), so what sits around it moves with it rather than jumping. One already there on mount is
 * simply there, and so is one opened with `animate` off (a search hit, a focused entry): only what the
 * operator opened moves (ADR 0115).
 * The phase follows `value` in the render itself, so what opens is in the page in the same commit as
 * the change that opened it: a search that scrolls to its hit finds it there.
 * Folding shut, it keeps showing what it last showed, out of reach: inert and hidden from assistive
 * tech, so a control on its way out can never be pressed.
 */
export function Fold<T>({ value, animate = true, children }: { value: T | null | false; animate?: boolean; children: (value: T) => ReactNode }) {
  const [phase, setPhase] = useState<"open" | "opening" | "shutting" | "shut">(value ? "open" : "shut");
  const last = useRef<T | null>(null);
  if (value) last.current = value;
  const shown = Boolean(value);
  if (shown && (phase === "shut" || phase === "shutting")) setPhase(animate ? "opening" : "open");
  if (!shown && (phase === "open" || phase === "opening")) setPhase("shutting");
  useEffect(() => {
    if (phase !== "opening" && phase !== "shutting") return;
    const timer = setTimeout(() => setPhase(phase === "opening" ? "open" : "shut"), phase === "opening" ? FOLD_OPEN_MS : FOLD_SHUT_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  if (phase === "shut" || last.current === null) return null;
  const shutting = phase === "shutting";
  return (
    <div className="fold" data-phase={phase} inert={shutting} aria-hidden={shutting || undefined}>
      <div>{children(last.current)}</div>
    </div>
  );
}
