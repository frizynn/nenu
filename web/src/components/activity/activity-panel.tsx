import { useState, type ReactNode } from "react";
import { Activity, Check, ChevronDown, ChevronRight, Radio, Terminal, Workflow } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  agentElapsed,
  allAgents,
  formatClock,
  formatCount,
  formatDuration,
  phaseDone,
  phaseRunning,
  workflowElapsed,
  type ActivityPhase,
  type ActivityResponse,
  type ActivityTask,
  type ActivityWorkflow,
} from "@/lib/activity";
import { AgentBar, Meta, StateDot } from "./activity-parts";
import { ArtifactList } from "./artifact-list";

type Filter = "all" | "workflows" | "tasks" | "artifacts";
const FINISHED_PREVIEW = 5;

function Group({ title, count, extra, children }: { title: string; count: number; extra?: ReactNode; children: ReactNode }) {
  const [open, setOpen] = useState(true);
  return (
    <section className="flex flex-col gap-0.5">
      <div className="flex min-h-11 items-center gap-2 rounded-md bg-muted/40 px-2.5 text-[12.5px] font-medium lg:min-h-8">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex flex-1 items-center gap-2 self-stretch text-left">
          {open ? <ChevronDown aria-hidden="true" className="size-3 text-muted-foreground" /> : <ChevronRight aria-hidden="true" className="size-3 text-muted-foreground" />}
          <span>{title}</span>
          <span className="tabular-nums text-muted-foreground">{count}</span>
        </button>
        {extra}
      </div>
      {open && children}
    </section>
  );
}

function PhaseBlock({ phase, workflow, now, onOpenWorkflow }: { phase: ActivityPhase; workflow: ActivityWorkflow; now: number; onOpenWorkflow: (runId: string, agentId?: string) => void }) {
  const running = phaseRunning(phase);
  const [open, setOpen] = useState(running);
  return (
    <div className="flex flex-col">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex min-h-11 items-center gap-2 pl-[18px] pr-2.5 text-left text-[12.5px] lg:min-h-7">
        {open ? <ChevronDown aria-hidden="true" className="size-3 text-muted-foreground" /> : <ChevronRight aria-hidden="true" className="size-3 text-muted-foreground" />}
        {running ? <StateDot state="running" /> : <Check aria-hidden="true" className="size-3 text-status-done" />}
        <span className="font-medium">{phase.title || "Agents"}</span>
        <span className="tabular-nums text-muted-foreground">{phaseDone(phase)}/{phase.agents.length}</span>
        <span className="flex-1" />
        {!open && <span className="flex gap-0.5">{phase.agents.map((a) => <StateDot key={a.id} state={a.state} />)}</span>}
      </button>
      {open && phase.agents.map((agent) => (
        <button
          key={agent.id}
          type="button"
          onClick={() => onOpenWorkflow(workflow.runId, agent.id)}
          className="flex min-h-11 items-center gap-2 rounded-md pl-8 pr-2.5 text-left hover:bg-muted/40 lg:min-h-8"
        >
          <StateDot state={agent.state} />
          <span className="whitespace-nowrap text-[12.5px]">{agent.label}</span>
          <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{agent.state === "running" ? agent.lastTool : agent.resultPreview}</span>
          <span className="whitespace-nowrap text-[11.5px] tabular-nums text-muted-foreground">{formatDuration(agentElapsed(agent, now))}</span>
        </button>
      ))}
    </div>
  );
}

function RunningWorkflow({ workflow, now, initiallyOpen, onOpenWorkflow }: { workflow: ActivityWorkflow; now: number; initiallyOpen: boolean; onOpenWorkflow: (runId: string, agentId?: string) => void }) {
  const [open, setOpen] = useState(initiallyOpen);
  const states = allAgents(workflow).map((a) => a.state);
  return (
    <div className="flex flex-col">
      <div className="flex min-h-11 items-center gap-2 px-2.5 lg:min-h-9">
        <button type="button" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${workflow.name}`} onClick={() => setOpen(!open)} className="flex size-6 items-center justify-center">
          {open ? <ChevronDown aria-hidden="true" className="size-3 text-muted-foreground" /> : <ChevronRight aria-hidden="true" className="size-3 text-muted-foreground" />}
        </button>
        <button type="button" onClick={() => onOpenWorkflow(workflow.runId)} className="flex min-w-0 flex-1 items-center gap-2 self-stretch text-left">
          <Workflow aria-hidden="true" className="size-4 shrink-0 text-status-working" />
          <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{workflow.name}</span>
          {!open && <AgentBar states={states} className="h-1 w-14 shrink-0" />}
          <span className="whitespace-nowrap text-[11.5px] tabular-nums text-muted-foreground">{formatDuration(workflowElapsed(workflow, now))}</span>
        </button>
      </div>
      {open && (
        <>
          <AgentBar states={states} className="mb-1 ml-[46px] mr-2.5 h-1" />
          {workflow.phases.map((phase) => <PhaseBlock key={phase.title} phase={phase} workflow={workflow} now={now} onOpenWorkflow={onOpenWorkflow} />)}
        </>
      )}
    </div>
  );
}

function FinishedWorkflowRow({ workflow, onOpen }: { workflow: ActivityWorkflow; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="flex min-h-11 items-start gap-2.5 rounded-md py-1.5 pl-3 pr-2.5 text-left hover:bg-muted/40">
      <Workflow aria-hidden="true" className={cn("mt-0.5 size-3.5 shrink-0", workflow.status === "failed" ? "text-destructive" : "text-status-done")} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
        <span className="truncate text-[12.5px]">{workflow.name}</span>
        <Meta className="text-[11.5px]" items={[
          workflow.status === "failed" ? <span className="text-destructive">failed</span> : workflow.status === "unknown" ? "ended" : "",
          `${workflow.agentCount} agents`,
          formatDuration(workflow.durationMs),
          workflow.totalTokens !== undefined ? `${formatCount(workflow.totalTokens)} tokens` : "",
        ]} />
      </span>
      <span className="whitespace-nowrap text-[11.5px] tabular-nums text-muted-foreground">{formatClock(workflow.startedAt !== undefined && workflow.durationMs !== undefined ? workflow.startedAt + workflow.durationMs : workflow.updatedAt)}</span>
    </button>
  );
}

function taskResult(task: ActivityTask, now: number): ReactNode {
  if (task.status === "running") return task.at !== undefined ? `running · output ${formatDuration(now - task.at)} ago` : "running";
  if (task.status === "unknown") return task.at !== undefined ? `no news since ${formatClock(task.at)}` : "no news";
  const exit = task.exitCode !== undefined ? `exit ${task.exitCode}` : task.event ? task.event.slice(0, 60) : task.status;
  return task.status === "failed" ? <span className="text-destructive">failed · {exit}</span> : exit;
}

export function TaskRow({ task, now, onOpenTask }: { task: ActivityTask; now: number; onOpenTask?: (taskId: string) => void }) {
  const Icon = task.kind === "monitor" ? Radio : Terminal;
  const body = (
    <>
      <Icon aria-hidden="true" className={cn("mt-0.5 size-3.5 shrink-0", task.status === "failed" ? "text-destructive" : task.status === "running" ? "text-status-working" : "text-muted-foreground")} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-snug">
        <span className="truncate text-[12.5px]">{task.title}</span>
        <Meta className="text-[11.5px]" items={[taskResult(task, now)]} />
      </span>
      <span className="whitespace-nowrap text-[11.5px] tabular-nums text-muted-foreground">{formatClock(task.at)}</span>
    </>
  );
  const row = "flex min-h-11 w-full items-start gap-2.5 rounded-md py-1.5 pl-3 pr-2.5 text-left";
  return task.hasOutput && onOpenTask
    ? <button type="button" aria-label={`Output of ${task.title}`} onClick={() => onOpenTask(task.id)} className={cn(row, "hover:bg-muted/40")}>{body}</button>
    : <div className={row}>{body}</div>;
}

/**
 * The Activity tab: what the session runs in the background, what finished and what it published.
 * Pure over the response; the caller owns fetching (useActivity) and where a selection opens.
 */
export function ActivityPanel({ data, stale = false, now, onOpenWorkflow, onOpenTask, onRetry, className }: {
  data: ActivityResponse | null;
  stale?: boolean;
  now: number;
  onOpenWorkflow: (runId: string, agentId?: string) => void;
  onOpenTask?: (taskId: string) => void;
  onRetry?: () => void;
  className?: string;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [showAll, setShowAll] = useState(false);
  if (!data) return <p role="status" className={cn("p-4 text-sm text-muted-foreground", className)}>{stale ? "Couldn’t load activity." : "Loading activity…"}</p>;
  if (!data.available) {
    const why = data.reason === "unsupported" ? "Activity is shown for Claude Code sessions." : data.reason === "disabled" ? "Conversation history is turned off on this bridge." : "This pane has no Claude session yet.";
    return <p role="status" className={cn("p-4 text-sm text-muted-foreground", className)}>{why}</p>;
  }
  const runningWf = data.workflows.filter((w) => w.status === "running");
  const finishedWf = data.workflows.filter((w) => w.status !== "running");
  const runningTasks = data.tasks.filter((t) => t.status === "running");
  const finishedTasks = data.tasks.filter((t) => t.status !== "running");
  const show = (kind: Filter) => filter === "all" || filter === kind;
  type Finished = { at: number; node: ReactNode };
  const finished: Finished[] = [
    ...(show("workflows") ? finishedWf.map((w) => ({ at: (w.startedAt ?? 0) + (w.durationMs ?? 0), node: <FinishedWorkflowRow key={w.runId} workflow={w} onOpen={() => onOpenWorkflow(w.runId)} /> })) : []),
    ...(show("tasks") ? finishedTasks.map((t) => ({ at: t.at ?? 0, node: <TaskRow key={t.id} task={t} now={now} onOpenTask={onOpenTask} /> })) : []),
  ].sort((a, b) => b.at - a.at);
  const runningCount = (show("workflows") ? runningWf.length : 0) + (show("tasks") ? runningTasks.length : 0);
  const filters: [Filter, string, number | null][] = [
    ["all", "All", null],
    ["workflows", "Workflows", data.workflows.length],
    ["tasks", "Tasks", data.tasks.length],
    ["artifacts", "Artifacts", data.artifacts.length],
  ];
  const empty = !data.workflows.length && !data.tasks.length && !data.artifacts.length;
  return (
    <div className={cn("flex flex-col gap-2.5", className)}>
      <div role="group" aria-label="Show" className="flex flex-wrap gap-1.5">
        {filters.map(([key, label, count]) => (
          <button
            key={key}
            type="button"
            aria-pressed={filter === key}
            onClick={() => setFilter(key)}
            className={cn("inline-flex min-h-9 items-center gap-1.5 rounded-full px-2.5 text-xs lg:min-h-[26px]", filter === key ? "bg-foreground font-medium text-background" : "text-muted-foreground ring-1 ring-border hover:text-foreground")}
          >
            {label}
            {count !== null && <span className={cn("tabular-nums", filter === key ? "text-background/70" : "text-muted-foreground/70")}>{count}</span>}
          </button>
        ))}
      </div>
      {stale && (
        <div role="status" className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>Couldn’t refresh. Showing last known activity.</span>
          {onRetry && <button type="button" onClick={onRetry} className="min-h-9 rounded-md px-2 text-foreground hover:bg-muted/50">Retry</button>}
        </div>
      )}
      {empty && (
        <p className="flex items-center gap-2 px-1 py-2 text-sm text-muted-foreground">
          <Activity aria-hidden="true" className="size-4" />Nothing running in the background.
        </p>
      )}
      {runningCount > 0 && (
        <Group title="Running" count={runningCount}>
          {show("workflows") && runningWf.map((w, i) => <RunningWorkflow key={w.runId} workflow={w} now={now} initiallyOpen={i === 0} onOpenWorkflow={onOpenWorkflow} />)}
          {show("tasks") && runningTasks.map((t) => <TaskRow key={t.id} task={t} now={now} onOpenTask={onOpenTask} />)}
        </Group>
      )}
      {finished.length > 0 && (
        <Group
          title="Finished"
          count={finished.length}
          extra={finished.length > FINISHED_PREVIEW && (
            <button type="button" onClick={() => setShowAll(!showAll)} className="min-h-9 px-1 text-xs font-normal text-muted-foreground hover:text-foreground lg:min-h-0">
              {showAll ? "Show less" : "Show all"}
            </button>
          )}
        >
          {(showAll ? finished : finished.slice(0, FINISHED_PREVIEW)).map((f) => f.node)}
        </Group>
      )}
      {show("artifacts") && data.artifacts.length > 0 && (
        <Group title="Artifacts" count={data.artifacts.length}>
          <ArtifactList artifacts={data.artifacts} />
        </Group>
      )}
      {data.truncated && (
        <p className="px-1 text-[11.5px] text-muted-foreground">Older activity in this session is not shown.</p>
      )}
    </div>
  );
}
