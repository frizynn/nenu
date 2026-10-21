import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { MOTION_PANEL_MS, reducedMotion } from "@/lib/motion";
import { cn } from "@/lib/utils";

/**
 * What a fold holds, unfolding as a panel does (ADR 0111): its height grows from nothing in 180 ms as
 * it fades in, and shrinks the same way before it leaves the page. Open from the start (a running
 * turn, a search hit) it is simply there; under reduced motion it comes and goes at once. Nothing is
 * mounted while folded, so a long chat keeps one row per fold.
 */
export function Reveal({ open, id, className, children }: { open: boolean; id?: string; className?: string; children: ReactNode }) {
  // closed → entering (drawn at no height) → growing (to its height, clipped) → open (unclipped);
  // and open → shrinking → closed.
  const [phase, setPhase] = useState<"closed" | "entering" | "growing" | "open" | "shrinking">(open ? "open" : "closed");
  if (open && (phase === "closed" || phase === "shrinking")) setPhase(reducedMotion() ? "open" : "entering");
  if (!open && phase !== "closed" && phase !== "shrinking") setPhase(reducedMotion() ? "closed" : "shrinking");
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (phase !== "entering") return;
    // The browser must hold the folded height as a style before the open one, or nothing animates.
    void box.current?.offsetHeight;
    setPhase("growing");
  }, [phase]);
  useEffect(() => {
    if (phase !== "growing" && phase !== "shrinking") return;
    const timer = setTimeout(() => setPhase(phase === "growing" ? "open" : "closed"), MOTION_PANEL_MS);
    return () => clearTimeout(timer);
  }, [phase]);
  if (phase === "closed") return null;
  const shown = phase === "growing" || phase === "open";
  return <div ref={box} id={id} data-reveal={phase}
    className={cn("grid transition-[grid-template-rows,opacity] duration-180 ease-out motion-reduce:transition-none",
      shown ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0")}>
    <div className={cn("min-h-0 min-w-0", phase !== "open" && "overflow-hidden", className)}>{children}</div>
  </div>;
}
