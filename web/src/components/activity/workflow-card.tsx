import { ChevronRight, Maximize2, Workflow } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  agentElapsed,
  allAgents,
  formatClock,
  formatDuration,
  workflowElapsed,
  type ActivityAgent,
  type ActivityWorkflow,
} from "@/lib/activity";
import { AgentBar, Meta, PhaseSteps, StateDot, StatusTag } from "./activity-parts";

/** "impl:F1  Bash · Keep waiting for gate  1h 31m". */
export function RunningAgentLine({ agent, now, className }: { agent: ActivityAgent; now: number; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-2 text-[13px]", className)}>
      <StateDot state={agent.state} />
      <span className="whitespace-nowrap font-medium text-foreground">{agent.label}</span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground">{agent.lastTool ?? ""}</span>
      <span className="whitespace-nowrap tabular-nums text-muted-foreground">{formatDuration(agentElapsed(agent, now))}</span>
    </div>
  );
}

/**
 * A workflow as a card inside the chat: progress per agent, the phase stepper, who is running now
 * and a way into the detail. Totals that only exist once the run ends are shown only then.
 */
export function WorkflowCard({ workflow, now, onOpen, className }: { workflow: ActivityWorkflow; now: number; onOpen?: () => void; className?: string }) {
  const agents = allAgents(workflow);
  const running = agents.filter((a) => a.state === "running");
  const live = workflow.status === "running";
  return (
    <section aria-label={`Workflow ${workflow.name}`} className={cn("flex w-full max-w-[600px] flex-col rounded-xl bg-card ring-1 ring-border", className)}>
      <div className="flex flex-col gap-3 px-4 pb-3 pt-3.5">
        <div className="flex items-center gap-2.5">
          <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-lg", live ? "bg-status-working/15 text-status-working" : "bg-muted text-muted-foreground")}>
            <Workflow aria-hidden="true" className="size-4" />
          </span>
          <div className="flex min-w-0 flex-1 flex-col leading-tight">
            <span className="truncate text-sm font-semibold">{workflow.name}</span>
            {workflow.summary && <span className="truncate text-xs text-muted-foreground">{workflow.summary}</span>}
          </div>
          <StatusTag status={workflow.status} />
        </div>
        <AgentBar states={agents.map((a) => a.state)} />
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <PhaseSteps phases={workflow.phases} />
          <span className="flex-1" />
          <Meta items={[
            `${workflow.doneCount} of ${workflow.agentCount} agents`,
            formatDuration(workflowElapsed(workflow, now)),
            workflow.totalToolCalls !== undefined ? `${workflow.totalToolCalls} tool calls` : "",
          ]} />
        </div>
      </div>
      {running.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border px-4 py-2.5">
          {running.map((agent) => <RunningAgentLine key={agent.id} agent={agent} now={now} />)}
        </div>
      )}
      <div className="flex items-center gap-2 border-t border-border py-2 pl-4 pr-2">
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
          {workflow.startedAt !== undefined ? `Started ${formatClock(workflow.startedAt)}` : "Started"}
          {live ? " · Claude gets the result when it finishes" : ""}
        </span>
        {onOpen && (
          <Button variant="outline" size="sm" className="min-h-11 lg:min-h-8" onClick={onOpen}>
            <Maximize2 aria-hidden="true" />View workflow
          </Button>
        )}
      </div>
    </section>
  );
}

/** The one-line form, for a workflow mentioned again further down the chat. */
export function WorkflowLine({ workflow, now, onOpen, className }: { workflow: ActivityWorkflow; now: number; onOpen?: () => void; className?: string }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open workflow ${workflow.name}`}
      className={cn("flex min-h-11 w-full max-w-[600px] items-center gap-2.5 rounded-lg bg-card px-3 text-left ring-1 ring-border hover:bg-muted/40", className)}
    >
      <Workflow aria-hidden="true" className={cn("size-4 shrink-0", workflow.status === "running" ? "text-status-working" : "text-status-done")} />
      <span className="truncate text-[13.5px] font-medium">{workflow.name}</span>
      <AgentBar states={allAgents(workflow).map((a) => a.state)} className="hidden w-[90px] shrink-0 sm:flex" />
      <PhaseSteps phases={workflow.phases} className="hidden flex-nowrap md:flex" />
      <span className="flex-1" />
      <span className="whitespace-nowrap text-xs tabular-nums text-muted-foreground">{formatDuration(workflowElapsed(workflow, now))}</span>
      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
}
