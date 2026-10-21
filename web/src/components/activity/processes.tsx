import { useState, type ReactNode } from "react";
import { Sparkle, ChevronDown, ChevronRight, Radio, Terminal, Workflow, X } from "@/components/ui/icon";

import { Button } from "@/components/ui/button";
import { useWorkflowDetail, type ActivityState } from "@/hooks/use-activity";
import {
  agentElapsed,
  allAgents,
  formatClock,
  formatElapsed,
  workflowElapsed,
  type ActivityArtifact,
  type ActivityTask,
} from "@/lib/activity";
import { modelDisplayName } from "@/lib/model-display";
import { processName, type ProcessItem, type Processes, type ProcessState } from "@/lib/processes";
import { cn } from "@/lib/utils";
import { AgentBar, Meta, PhaseSteps, StateDot } from "./activity-parts";
import { ArtifactList } from "./artifact-list";
import { TaskOutput } from "./task-output";
import { WorkflowDetail } from "./workflow-detail";

// The session's background work behind the chips above the composer: what waits on you behind Needs
// you, what runs and what finished behind Working, in lists whose rows open in place. Details go to a
// side panel on a desk and replace the panel's content on a phone; nothing covers the whole screen.

/** Finished rows shown before "Show all". */
export const DONE_PREVIEW = 5;

export type ProcessDetail =
  | { kind: "workflow"; runId: string; agentId: string | null }
  | { kind: "task"; taskId: string; title: string };

const STATE_LABEL: Record<ProcessState, string> = {
  waiting: "Waiting on you",
  running: "Running",
  done: "Finished",
  failed: "Failed",
  unknown: "Status unavailable",
};

function KindIcon({ item }: { item: ProcessItem }) {
  const Icon = item.kind === "workflow" ? Workflow : item.kind === "subagent" ? Sparkle : item.task.kind === "monitor" ? Radio : Terminal;
  const tone = item.state === "waiting" ? "text-status-blocked" : item.state === "running" ? "text-status-working" : item.state === "failed" ? "text-destructive" : "text-muted-foreground";
  return <Icon aria-hidden="true" className={cn("size-4 shrink-0", tone)} />;
}

function taskSummary(task: ActivityTask, now: number): string {
  if (task.status === "running") return task.at !== undefined ? `output ${formatElapsed(now - task.at)} ago` : "running";
  if (task.status === "unknown") return task.at !== undefined ? `no news since ${formatClock(task.at)}` : "no news";
  return task.exitCode !== undefined ? `exit ${task.exitCode}` : task.event || task.status;
}

/** The one line beside a row's name: progress, what it waits on, or how it ended. */
function rowSummary(item: ProcessItem, now: number): ReactNode {
  if (item.kind === "workflow") {
    const wf = item.workflow;
    return <Meta className="text-footnote" items={[`${wf.doneCount}/${wf.agentCount}`, workflowElapsed(wf, now)]} />;
  }
  if (item.kind === "task") return <Meta className="text-footnote" items={[taskSummary(item.task, now)]} />;
  return <Meta className="text-footnote" items={[STATE_LABEL[item.state], item.at !== undefined ? formatClock(item.at) : ""]} />;
}

function ProcessRow({ item, now, onDetail, onOpenSubagent }: {
  item: ProcessItem;
  now: number;
  onDetail: (detail: ProcessDetail) => void;
  onOpenSubagent?: (item: Extract<ProcessItem, { kind: "subagent" }>) => void;
}) {
  const [open, setOpen] = useState(false);
  const name = processName(item);
  return (
    <li className="flex flex-col">
      <button type="button" aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"} ${name}`} onClick={() => setOpen(!open)}
        className="flex min-h-11 w-full items-center gap-2.5 rounded-md px-2 text-left hover:bg-hover lg:min-h-9">
        <KindIcon item={item} />
        <span className="min-w-0 flex-1 truncate text-footnote font-medium">{name}</span>
        {item.kind === "workflow" && !open && <AgentBar states={allAgents(item.workflow).map((a) => a.state)} className="h-1 w-12 shrink-0" />}
        <span className="max-w-[45%] shrink-0">{rowSummary(item, now)}</span>
        {open ? <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" /> : <ChevronRight aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
      </button>
      {open && <div className="flex flex-col gap-2 pb-2 pl-[34px] pr-2 pt-0.5">
        {item.kind === "workflow" && <>
          <AgentBar states={allAgents(item.workflow).map((a) => a.state)} className="h-1" />
          <PhaseSteps phases={item.workflow.phases} />
          {allAgents(item.workflow).filter((a) => a.state === "running").map((agent) => (
            <div key={agent.id} className="flex min-w-0 items-center gap-2 text-xs">
              <StateDot state={agent.state} />
              <span className="whitespace-nowrap font-medium">{agent.label}</span>
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{agent.lastTool ?? ""}</span>
              <span className="whitespace-nowrap tabular-nums text-muted-foreground">{agentElapsed(agent, now)}</span>
            </div>
          ))}
          <DetailButton name={name} onClick={() => onDetail({ kind: "workflow", runId: item.workflow.runId, agentId: null })} />
        </>}
        {item.kind === "task" && <>
          <Meta className="text-xs" items={[STATE_LABEL[item.state], item.task.kind === "monitor" ? "monitor" : "background command", item.at !== undefined ? `last ${formatClock(item.at)}` : ""]} />
          {item.task.hasOutput && <DetailButton name={name} onClick={() => onDetail({ kind: "task", taskId: item.task.id, title: item.task.title })} />}
        </>}
        {item.kind === "subagent" && <>
          {item.agent.task && item.agent.task !== item.agent.name && <p className="line-clamp-3 break-words text-xs text-muted-foreground">{item.agent.task}</p>}
          <Meta className="text-xs" items={[STATE_LABEL[item.state], item.agent.model ? modelDisplayName(item.agent.model) : ""]} />
          {onOpenSubagent && <DetailButton name={name} label="Open conversation" onClick={() => onOpenSubagent(item)} />}
        </>}
      </div>}
    </li>
  );
}

function DetailButton({ name, label = "Details", onClick }: { name: string; label?: string; onClick: () => void }) {
  return (
    <Button variant="outline" size="sm" className="min-h-11 self-start lg:min-h-8" aria-label={`${label === "Details" ? "Details of" : `${label}:`} ${name}`} onClick={onClick}>
      {label}<ChevronRight aria-hidden="true" />
    </Button>
  );
}

/** A folded section under the live rows: its title with a count, and `extra` beside it while open. */
function Fold({ title, count, extra, defaultOpen = false, children }: { title: string; count: number; extra?: (open: boolean) => ReactNode; defaultOpen?: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="mt-1 border-t border-border/60 pt-1">
      <div className="flex items-center">
        <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}
          className="flex min-h-11 flex-1 items-center gap-2 rounded-md px-2 text-left text-footnote text-muted-foreground hover:text-foreground lg:min-h-8">
          {open ? <ChevronDown aria-hidden="true" className="size-3.5" /> : <ChevronRight aria-hidden="true" className="size-3.5" />}
          {title} ({count})
        </button>
        {extra?.(open)}
      </div>
      {open && children}
    </section>
  );
}

/**
 * Waiting first, then running, then a folded "Done (n)" with the newest few and the claude.ai pages
 * the session published. `quiet` (finished work, opened from the ⋯ menu: nothing live in the panel)
 * opens the finished rows unfolded, and the pages too when the session finished nothing itself, with
 * nothing said about what runs: it is what the menu row named.
 * Rows expand in place. `finished` is other work that ended (a project's
 * resolved threads), folded in with the session's own.
 */
export function ProcessesList({ processes, artifacts = [], finished, quiet = false, now, stale, onRetry, onDetail, onOpenSubagent }: {
  processes: Processes;
  quiet?: boolean;
  artifacts?: ActivityArtifact[];
  finished?: { count: number; rows: ReactNode };
  now: number;
  stale?: boolean;
  onRetry?: () => void;
  onDetail: (detail: ProcessDetail) => void;
  onOpenSubagent?: (item: Extract<ProcessItem, { kind: "subagent" }>) => void;
}) {
  const [all, setAll] = useState(false);
  const live = [...processes.waiting, ...processes.running];
  const done = all ? processes.done : processes.done.slice(0, DONE_PREVIEW);
  const doneCount = processes.done.length + (finished?.count ?? 0);
  const row = (item: ProcessItem) => <ProcessRow key={`${item.kind}:${item.id}`} item={item} now={now} onDetail={onDetail} onOpenSubagent={onOpenSubagent} />;
  return (
    <div className="flex flex-col gap-1">
      {stale && <div role="status" className="flex items-center justify-between gap-2 px-2 text-xs text-muted-foreground">
        <span>Couldn’t refresh. Showing last known activity.</span>
        {onRetry && <button type="button" onClick={onRetry} className="min-h-11 rounded-md px-2 text-foreground hover:bg-hover lg:min-h-8">Retry</button>}
      </div>}
      {live.length === 0 && !quiet && <p className="px-2 py-2 text-footnote text-muted-foreground">Nothing running in the background.</p>}
      {live.length > 0 && <ul aria-label="In progress" className="flex flex-col">{live.map(row)}</ul>}
      {doneCount > 0 && <Fold title="Done" count={doneCount} defaultOpen={quiet} extra={(open) => open && processes.done.length > DONE_PREVIEW &&
        <button type="button" onClick={() => setAll(!all)} className="min-h-11 px-2 text-xs text-muted-foreground hover:text-foreground lg:min-h-8">{all ? "Show less" : "Show all"}</button>}>
        {finished && finished.count > 0 && finished.rows}
        {processes.done.length > 0 && <ul aria-label="Done" className="flex flex-col">{done.map(row)}</ul>}
      </Fold>}
      {artifacts.length > 0 && <Fold title="Published" count={artifacts.length} defaultOpen={quiet && processes.done.length === 0}><ArtifactList artifacts={artifacts} /></Fold>}
    </div>
  );
}

/** One process's details: a workflow with its agents and results, or a command's newest output. */
export function ProcessDetailView({ paneId, session, activity, detail, now, onChange }: {
  paneId: string;
  session?: string;
  activity: ActivityState;
  detail: ProcessDetail;
  now: number;
  onChange: (detail: ProcessDetail) => void;
}) {
  const runId = detail.kind === "workflow" ? detail.runId : null;
  const loaded = useWorkflowDetail(paneId, runId, session, activity.data);
  if (detail.kind === "task") return <TaskOutput paneId={paneId} session={session} taskId={detail.taskId} />;
  const listed = activity.data?.available ? activity.data.workflows.find((w) => w.runId === detail.runId) : undefined;
  // An answer still in flight for the run shown before is not this run's.
  const own = loaded.detail?.workflow.runId === detail.runId ? loaded.detail : null;
  const shown = own?.workflow ?? listed;
  if (!shown) return <p role="status" className="text-footnote text-muted-foreground">{loaded.failed ? "This workflow is no longer available." : "Loading workflow…"}</p>;
  return <WorkflowDetail workflow={shown} results={own?.results} now={now} selectedAgentId={detail.agentId}
    onSelectAgent={(agentId) => onChange({ ...detail, agentId })} />;
}

export function detailTitle(detail: ProcessDetail, activity: ActivityState): string {
  if (detail.kind === "task") return detail.title;
  const listed = activity.data?.available ? activity.data.workflows.find((w) => w.runId === detail.runId) : undefined;
  return listed?.name ?? "Workflow";
}

/**
 * The desk's details: a ~430px panel at the right of the chat, which stays usable beside it.
 */
export function ProcessPanel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <aside aria-label={`Details: ${title}`} onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } }} className="flex min-h-0 w-[430px] max-w-[45%] shrink-0 flex-col border-l border-border bg-background">
      <div className="flex min-h-12 shrink-0 items-center gap-2 border-b border-border pl-4 pr-2">
        <span className="min-w-0 flex-1 truncate text-subhead font-semibold">{title}</span>
        <Button variant="ghost" size="icon" aria-label="Close details" onClick={onClose}><X aria-hidden="true" /></Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">{children}</div>
    </aside>
  );
}
