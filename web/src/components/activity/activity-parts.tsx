import { Check, ChevronRight } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  phaseDone,
  phaseRunning,
  type ActivityAgentState,
  type ActivityPhase,
  type ActivityWorkflowStatus,
} from "@/lib/activity";

// Small pieces every activity surface shares, so a dot or a bar means the same thing everywhere:
// amber is running, green is done, red is failed (no "needs you" halo; Claude reacts to it, not you).

type DotState = ActivityAgentState | "unknown" | "completed";

const DOT: Record<DotState, string> = {
  running: "bg-status-working",
  done: "bg-status-done",
  completed: "bg-status-done",
  failed: "bg-destructive",
  unknown: "bg-status-unknown",
};

export function StateDot({ state, className }: { state: DotState; className?: string }) {
  return <span aria-hidden="true" className={cn("size-1.5 shrink-0 rounded-full", DOT[state], className)} />;
}

/** One segment per agent: green done, amber running, red failed. */
export function AgentBar({ states, className }: { states: ActivityAgentState[]; className?: string }) {
  if (!states.length) return <div className={cn("h-1.5 rounded-full bg-muted", className)} />;
  return (
    <div className={cn("flex h-1.5 gap-0.5", className)} aria-hidden="true">
      {states.map((state, i) => (
        <span key={i} className={cn("flex-1 rounded-full", state === "done" ? "bg-status-done" : state === "running" ? "bg-status-working" : "bg-destructive/70")} />
      ))}
    </div>
  );
}

/** "✓ Research 2/2 › • Design 0/1". */
export function PhaseSteps({ phases, className }: { phases: ActivityPhase[]; className?: string }) {
  return (
    <span className={cn("flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground", className)}>
      {phases.map((phase, i) => {
        const running = phaseRunning(phase);
        return (
          <Fragment key={phase.title || i}>
            {i > 0 && <ChevronRight aria-hidden="true" className="size-3 text-muted-foreground/60" />}
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              {running ? <StateDot state="running" /> : <Check aria-hidden="true" className="size-3 text-status-done" />}
              <span className={running ? "text-foreground" : undefined}>{phase.title || "Agents"}</span>
              <span className="tabular-nums text-muted-foreground/70">{phaseDone(phase)}/{phase.agents.length}</span>
            </span>
          </Fragment>
        );
      })}
    </span>
  );
}

const TAG: Record<ActivityWorkflowStatus, [string, string]> = {
  running: ["running", "bg-status-working/15 text-status-working"],
  completed: ["done", "bg-status-done/15 text-status-done"],
  failed: ["failed", "bg-destructive/15 text-destructive"],
  unknown: ["ended", "bg-muted text-muted-foreground"],
};

export function StatusTag({ status }: { status: ActivityWorkflowStatus }) {
  const [label, tone] = TAG[status];
  return <span className={cn("inline-flex h-5 shrink-0 items-center rounded-md px-1.5 text-[11px] font-medium", tone)}>{label}</span>;
}

/** "a · b · c", skipping empties. */
export function Meta({ items, className }: { items: ReactNode[]; className?: string }) {
  const shown = items.filter((item) => item !== "" && item !== undefined && item !== null && item !== false);
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground", className)}>
      {shown.map((item, i) => (
        <Fragment key={i}>
          {i > 0 && <span aria-hidden="true" className="text-muted-foreground/50">·</span>}
          <span className="whitespace-nowrap tabular-nums">{item}</span>
        </Fragment>
      ))}
    </span>
  );
}
