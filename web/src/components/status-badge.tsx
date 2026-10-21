import { useEffect, useRef } from "react";

import { Check, CircleAlert, CircleCheck, CircleDashed, GitMerge, Hourglass, type IconComponent } from "@/components/ui/icon";
import { useLiveMotion } from "@/lib/live-motion";
import type { NodeState } from "@/lib/org-tree";
import { cn } from "@/lib/utils";
import type { AgentStatus } from "@/lib/types";

/** An agent's status in the tree's terms: a finished turn waits to be looked at, as a thread to review does. */
export const AGENT_STATE: Record<AgentStatus, NodeState> = { blocked: "needs", working: "working", done: "review", idle: "idle", unknown: "idle" };

/** A node's state, or an agent held by its usage limit until a time (ADR 0120): grey, it resumes by itself. */
export type MarkState = NodeState | "limit";

/**
 * One glyph per state, told apart by its shape before its colour: what waits on you is a red alert,
 * what is ready to look at a blue check, work in progress a grey dashed circle that turns slowly, a
 * merge left its grey branch, a resolved node a grey tick. Colour is only for what asks something of
 * you, and a resting node draws nothing, so a list shows at a glance only what is alive. Only work in
 * progress moves, and only while it is on screen (ADR 0118); every other mark is still.
 */
const MARK: Record<Exclude<MarkState, "idle">, { glyph: IconComponent; tone: string }> = {
  needs: { glyph: CircleAlert, tone: "text-status-blocked" },
  review: { glyph: CircleCheck, tone: "text-primary" },
  working: { glyph: CircleDashed, tone: "text-muted-foreground" },
  merging: { glyph: GitMerge, tone: "text-muted-foreground" },
  closing: { glyph: GitMerge, tone: "text-muted-foreground" },
  resolved: { glyph: Check, tone: "text-muted-foreground" },
  limit: { glyph: Hourglass, tone: "text-muted-foreground" },
};

/** A state's mark, 14px; a resting one keeps the box empty so the names beside it stay in line. */
export function StateMark({ state, className }: { state: MarkState; className?: string }) {
  if (state === "idle") return <span aria-hidden data-node-state="idle" className={cn("inline-flex size-3.5 shrink-0", className)} />;
  if (state === "working") return <WorkingMark className={className} />;
  const { glyph: Glyph, tone } = MARK[state];
  // A 2px stroke: at 14px the icon set's 1.5 left the dashed circle at 3:1 on the light bar.
  return <Glyph aria-hidden data-node-state={state} strokeWidth={2} className={cn("size-3.5 shrink-0", tone, className)} />;
}

// The dashed circle's six dashes turn a sixth of a turn per pass, in ten steps: each pass ends with
// every dash where the next one was, so it reads as moving without ever spinning.
const TURN_STEPS = 10;

/**
 * Work in progress: the dashed circle turning slowly (ADR 0118). Still while off screen, on a hidden
 * page, under the idle lock or reduced motion: there the shape alone says it works.
 */
function WorkingMark({ className }: { className?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const moving = useLiveMotion(ref, TURN_STEPS, (n) => ref.current?.style.setProperty("transform", `rotate(${n * (60 / TURN_STEPS)}deg)`));
  useEffect(() => { if (!moving) ref.current?.style.removeProperty("transform"); }, [moving]);
  return <CircleDashed ref={ref} aria-hidden data-node-state="working" data-moving={moving || undefined} strokeWidth={2}
    className={cn("size-3.5 shrink-0", MARK.working.tone, className)} />;
}

/** Whether an agent's status draws nothing: where no column holds the names in line, leave its mark out. */
export const resting = (status: AgentStatus) => AGENT_STATE[status] === "idle";

/** An agent's mark: the same glyph its state draws in the tree. */
export function StatusDot({ status, className }: { status: AgentStatus; className?: string }) {
  return <StateMark state={AGENT_STATE[status]} className={className} />;
}
