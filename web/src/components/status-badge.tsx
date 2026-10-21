import { Check, CircleAlert, CircleCheck, CircleDashed, GitMerge, type IconComponent } from "@/components/ui/icon";
import type { NodeState } from "@/lib/org-tree";
import { cn } from "@/lib/utils";
import type { AgentStatus } from "@/lib/types";

/** An agent's status in the tree's terms: a finished turn waits to be looked at, as a thread to review does. */
export const AGENT_STATE: Record<AgentStatus, NodeState> = { blocked: "needs", working: "working", done: "review", idle: "idle", unknown: "idle" };

/**
 * One still glyph per state, told apart by its shape before its colour: what waits on you is a red
 * alert, what is ready to look at a blue check, work in progress a grey dashed circle, a merge left
 * its grey branch, a resolved node a grey tick. Colour is only for what asks something of you, and a
 * resting node draws nothing, so a list shows at a glance only what is alive. Nothing spins: a state
 * that lasts a whole turn is a still glyph (calm-motion.test).
 */
const MARK: Record<Exclude<NodeState, "idle">, { glyph: IconComponent; tone: string; stroke?: number }> = {
  needs: { glyph: CircleAlert, tone: "text-status-blocked", stroke: 2 },
  review: { glyph: CircleCheck, tone: "text-primary" },
  working: { glyph: CircleDashed, tone: "text-muted-foreground" },
  merging: { glyph: GitMerge, tone: "text-muted-foreground" },
  closing: { glyph: GitMerge, tone: "text-muted-foreground" },
  resolved: { glyph: Check, tone: "text-muted-foreground" },
};

/** A state's mark, 14px; a resting one keeps the box empty so the names beside it stay in line. */
export function StateMark({ state, className }: { state: NodeState; className?: string }) {
  if (state === "idle") return <span aria-hidden data-node-state="idle" className={cn("inline-flex size-3.5 shrink-0", className)} />;
  const { glyph: Glyph, tone, stroke } = MARK[state];
  return <Glyph aria-hidden data-node-state={state} strokeWidth={stroke} className={cn("size-3.5 shrink-0", tone, className)} />;
}

/** An agent's mark: the same glyph its state draws in the tree. */
export function StatusDot({ status, className }: { status: AgentStatus; className?: string }) {
  return <StateMark state={AGENT_STATE[status]} className={className} />;
}
