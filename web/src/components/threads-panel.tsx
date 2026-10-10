import { useEffect, useState, type ReactNode } from "react";
import { Activity, ArrowLeft, BookText, GitPullRequest, MessageSquare } from "lucide-react";

import { ActivityPanel } from "@/components/activity/activity-panel";
import { TaskOutput } from "@/components/activity/task-output";
import { WorkflowDetail } from "@/components/activity/workflow-detail";
import { ProjectTasks, ThreadStateDot, prSummary, threadAge, threadDot } from "@/components/project-tasks";
import { BottomSheet } from "@/components/ui/sheet";
import { useActivity, useWorkflowDetail } from "@/hooks/use-activity";
import { runningCount } from "@/lib/activity";
import type { AgentView, ProjectThreadView, ProjectView } from "@/lib/types";
import { cn } from "@/lib/utils";

export type PanelTab = "threads" | "prs" | "activity" | "memory";

/** Threads with a pull request, open ones first. */
export function prThreads(threads: readonly ProjectThreadView[]): ProjectThreadView[] {
  const rank = { open: 0, draft: 1, merged: 2, closed: 3 } as const;
  return threads.filter((thread) => thread.pr).sort((a, b) => rank[a.pr!.state] - rank[b.pr!.state]);
}

export function PrList({ threads, onOpenPane, now = Date.now() }: {
  threads: readonly ProjectThreadView[];
  onOpenPane: (paneId: string) => void;
  now?: number;
}) {
  const list = prThreads(threads);
  if (list.length === 0) return <p className="py-3 text-sm text-muted-foreground">No pull requests yet.</p>;
  return (
    <ul className="task-list">
      {list.map((thread) => {
        const body = <>
          <ThreadStateDot state={threadDot(thread)} className="mt-1.5 size-2" />
          <span className="min-w-0 flex-1">
            <span className="block break-words text-sm font-medium">{thread.title}</span>
            <span className="block truncate text-xs text-muted-foreground">{prSummary(thread.pr!)}</span>
          </span>
          {thread.pr!.diff && <span className="shrink-0 font-mono text-xs tabular-nums">
            <span className="text-status-done">+{thread.pr!.diff.additions}</span> <span className="text-status-blocked">−{thread.pr!.diff.deletions}</span>
          </span>}
          {!thread.pr!.diff && threadAge(thread, now) && <span className="shrink-0 text-xs text-muted-foreground">{threadAge(thread, now)}</span>}
        </>;
        return (
          <li key={thread.id} className="task-row">
            {thread.paneId ? <button type="button" className="task-main" onClick={() => onOpenPane(thread.paneId!)}>{body}</button> : <div className="task-main">{body}</div>}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * A Claude pane's background work: the Activity list, a workflow opened full screen, and a task's
 * output in a sheet. Reads only while mounted, so a closed tab costs nothing.
 */
export function PaneActivity({ paneId, session, className }: { paneId: string; session?: string; className?: string }) {
  const activity = useActivity(paneId, session);
  const [now, setNow] = useState(() => Date.now());
  const [workflow, setWorkflow] = useState<{ runId: string; agentId: string | null } | null>(null);
  const [task, setTask] = useState<string | null>(null);
  const running = runningCount(activity.data) > 0;
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(id);
  }, [running]);
  const detail = useWorkflowDetail(paneId, workflow?.runId ?? null, session, activity.data);
  const listed = activity.data?.available ? activity.data.workflows.find((w) => w.runId === workflow?.runId) : undefined;
  const shown = detail.detail?.workflow ?? listed;
  return (
    <>
      <ActivityPanel className={className} data={activity.data} stale={activity.stale} now={now} onRetry={activity.refresh}
        onOpenWorkflow={(runId, agentId) => setWorkflow({ runId, agentId: agentId ?? null })} onOpenTask={setTask} />
      {workflow && (
        <div role="dialog" aria-label={shown?.name ?? "Workflow"} className="fixed inset-0 z-40 flex flex-col bg-background pt-[env(safe-area-inset-top)]">
          <div className="flex min-h-12 items-center gap-2 border-b border-border px-2">
            <button type="button" aria-label="Back" onClick={() => setWorkflow(null)} className="flex size-11 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent">
              <ArrowLeft aria-hidden className="size-4" />
            </button>
            <span className="truncate text-sm font-medium">{shown?.name ?? "Workflow"}</span>
          </div>
          {shown
            ? <WorkflowDetail workflow={shown} results={detail.detail?.results} now={now} selectedAgentId={workflow.agentId}
              onSelectAgent={(agentId) => setWorkflow({ runId: workflow.runId, agentId })} />
            : <p role="status" className="p-4 text-sm text-muted-foreground">{detail.failed ? "This workflow is no longer available." : "Loading workflow…"}</p>}
        </div>
      )}
      <BottomSheet open={task !== null} onClose={() => setTask(null)} title="Task output">
        {task && <TaskOutput paneId={paneId} session={session} taskId={task} />}
      </BottomSheet>
    </>
  );
}

const TABS: Array<[PanelTab, string, typeof MessageSquare]> = [
  ["threads", "Threads", MessageSquare],
  ["prs", "PRs", GitPullRequest],
  ["activity", "Activity", Activity],
  ["memory", "Memory", BookText],
];

/**
 * The project's side panel beside a coordinator or thread: its threads grouped by what they need,
 * their pull requests, the coordinator session's background activity, and what every thread shares.
 */
export function ThreadsPanel({ project, threads, title, subtitle, activityPaneId, panes, session, currentPaneId, readOnly, showCoordinator, onOpenPane, onChanged, action }: {
  project: ProjectView;
  threads: ProjectThreadView[];
  title: string;
  subtitle?: ReactNode;
  /** The Claude pane whose activity the Activity tab shows. */
  activityPaneId?: string;
  panes: readonly AgentView[];
  session?: string;
  currentPaneId?: string;
  readOnly: boolean;
  /** List the project coordinator first, the way back up from a thread or a nested coordinator. */
  showCoordinator: boolean;
  onOpenPane: (paneId: string) => void;
  onChanged: () => void;
  action?: ReactNode;
}) {
  const [tab, setTab] = useState<PanelTab>("threads");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="Project panel" className="flex min-h-12 shrink-0 items-center gap-1 border-b border-border px-3">
        {TABS.map(([key, label, Icon]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} aria-label={label} title={label} onClick={() => setTab(key)}
            className={cn("inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-[13px]", tab === key ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground")}>
            <Icon aria-hidden className="size-3.5" />{tab === key && label}
          </button>
        ))}
        <span className="flex-1" />
        {action}
      </div>
      <div role="tabpanel" aria-label={TABS.find(([key]) => key === tab)![1]} className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-4">
        {tab === "threads" && <ProjectTasks project={project} threads={threads} title={title} subtitle={subtitle} panes={panes} session={session}
          currentPaneId={currentPaneId} readOnly={readOnly} showCoordinator={showCoordinator} onOpenPane={onOpenPane} onChanged={onChanged} />}
        {tab === "prs" && <PrList threads={threads} onOpenPane={onOpenPane} />}
        {tab === "activity" && (activityPaneId
          ? <PaneActivity paneId={activityPaneId} session={session} />
          : <p className="text-sm text-muted-foreground">The coordinator is not running, so there is no activity to show.</p>)}
        {tab === "memory" && <ProjectMemory project={project} threads={threads} />}
      </div>
    </div>
  );
}

/** What Organizations hands every thread: the project's goal, and where the threads work. */
function ProjectMemory({ project, threads }: { project: ProjectView; threads: readonly ProjectThreadView[] }) {
  const branches = threads.filter((thread) => thread.branch && thread.status !== "resolved");
  return (
    <div className="flex flex-col gap-4 text-sm">
      <section className="rounded-xl border border-border p-3.5">
        <h3 className="text-[13px] font-medium">Shared with every thread</h3>
        <p className="mt-1.5 leading-relaxed text-muted-foreground">{project.goal || "This project has no goal written down yet."}</p>
      </section>
      {branches.length > 0 && <section>
        <h3 className="mb-1.5 text-[13px] font-medium">Branches</h3>
        <ul className="flex flex-col gap-1">
          {branches.map((thread) => <li key={thread.id} className="flex items-baseline gap-2">
            <span className="shrink-0">{thread.title}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">{thread.branch}</span>
          </li>)}
        </ul>
      </section>}
    </div>
  );
}
