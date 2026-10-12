import { useState, type ReactNode } from "react";
import { Activity, ArrowLeft, BookText, GitPullRequest, MessageSquare } from "lucide-react";

import { ActivityPanel } from "@/components/activity/activity-panel";
import { ProcessDetailView, type ProcessDetail } from "@/components/activity/processes";
import { NodeDot } from "@/components/node-row";
import { ProjectTasks, canMerge, prSummary, threadAge } from "@/components/project-tasks";
import { MergeDialog } from "@/components/thread-cards";
import { Button } from "@/components/ui/button";
import { useActivity, useActivityClock } from "@/hooks/use-activity";
import { nodeState } from "@/lib/org-tree";
import type { AgentView, ProjectThreadView, ProjectView } from "@/lib/types";
import { cn } from "@/lib/utils";

export type PanelTab = "threads" | "prs" | "activity" | "memory";

/** Threads with a pull request, open ones first. */
export function prThreads(threads: readonly ProjectThreadView[]): ProjectThreadView[] {
  const rank = { open: 0, draft: 1, merged: 2, closed: 3 } as const;
  return threads.filter((thread) => thread.pr).sort((a, b) => rank[a.pr!.state] - rank[b.pr!.state]);
}

/** The pull requests of a set of threads; one Organizations can merge offers Merge, which asks first. */
export function PrList({ project, threads, session, readOnly, onOpenPane, onOpenNode, onChanged, now = Date.now() }: {
  project: ProjectView;
  threads: readonly ProjectThreadView[];
  session?: string;
  readOnly: boolean;
  onOpenPane: (paneId: string) => void;
  onOpenNode: (id: string) => void;
  onChanged: () => void;
  now?: number;
}) {
  const [merging, setMerging] = useState<ProjectThreadView | null>(null);
  const list = prThreads(threads);
  if (list.length === 0) return <p className="py-3 text-subhead text-muted-foreground">No pull requests yet.</p>;
  return <>
    <ul className="task-list">
      {list.map((thread) => {
        const body = <>
          <NodeDot state={nodeState(thread)} className="mt-1.5 size-2" />
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
            <button type="button" className="task-main" onClick={() => thread.paneId ? onOpenPane(thread.paneId) : onOpenNode(thread.id)}>{body}</button>
            {/* Outline: a list of ready PRs would otherwise stack ink buttons; the dialog's Merge is the primary. */}
            {!readOnly && canMerge(project, thread) && <Button type="button" variant="outline" size="sm" className="mr-1 self-center bg-transparent" aria-label={`Merge ${thread.title}`}
              onClick={() => setMerging(thread)}>Merge</Button>}
          </li>
        );
      })}
    </ul>
    <MergeDialog project={project} thread={merging} session={session} onMerged={() => { setMerging(null); onChanged(); }} onCancel={() => setMerging(null)} />
  </>;
}

/**
 * A Claude pane's background work: the Activity list, and a workflow or a command's output opened in
 * its place with Back. Reads only while mounted, so a closed tab costs nothing.
 */
export function PaneActivity({ paneId, session, className }: { paneId: string; session?: string; className?: string }) {
  const activity = useActivity(paneId, session);
  const now = useActivityClock(activity.data);
  const [detail, setDetail] = useState<ProcessDetail | null>(null);
  if (detail) {
    return (
      <div className={cn("flex flex-col gap-3", className)}>
        <button type="button" onClick={() => setDetail(null)} className="-ml-2 inline-flex min-h-11 items-center gap-1.5 self-start rounded-md px-2 text-subhead text-muted-foreground hover:text-foreground lg:min-h-8">
          <ArrowLeft aria-hidden="true" className="size-4" />Back
        </button>
        <ProcessDetailView paneId={paneId} session={session} activity={activity} detail={detail} now={now} onChange={setDetail} />
      </div>
    );
  }
  return (
    <ActivityPanel className={className} data={activity.data} stale={activity.stale} now={now} onRetry={activity.refresh}
      onOpenWorkflow={(runId, agentId) => setDetail({ kind: "workflow", runId, agentId: agentId ?? null })}
      onOpenTask={(taskId) => setDetail({ kind: "task", taskId, title: activity.data?.available ? activity.data.tasks.find((t) => t.id === taskId)?.title ?? "Output" : "Output" })} />
  );
}

const TABS: Array<[PanelTab, string, typeof MessageSquare]> = [
  ["threads", "Threads", MessageSquare],
  ["prs", "PRs", GitPullRequest],
  ["activity", "Activity", Activity],
  ["memory", "Memory", BookText],
];

/**
 * The project's side panel beside a coordinator or thread: its organization, their pull requests,
 * the coordinator session's background activity, and what every thread shares.
 */
export function ThreadsPanel({ project, threads, coordinator, title, subtitle, activityPaneId, panes, session, currentPaneId, readOnly, onOpenPane, onOpenNode, onChanged, action }: {
  project: ProjectView;
  threads: ProjectThreadView[];
  /** The coordinator under the project that runs them; the project's own when omitted. */
  coordinator?: ProjectThreadView;
  title: string;
  subtitle?: ReactNode;
  /** The Claude pane whose activity the Activity tab shows. */
  activityPaneId?: string;
  panes: readonly AgentView[];
  session?: string;
  currentPaneId?: string;
  readOnly: boolean;
  onOpenPane: (paneId: string) => void;
  onOpenNode: (id: string) => void;
  onChanged: () => void;
  action?: ReactNode;
}) {
  const [tab, setTab] = useState<PanelTab>("threads");
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div role="tablist" aria-label="Project panel" className="flex min-h-13 shrink-0 items-center gap-1 border-b border-border/60 px-3">
        {TABS.map(([key, label, Icon]) => (
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)} className="panel-tab">
            <Icon aria-hidden className="size-3.5" />{label}
          </button>
        ))}
        <span className="flex-1" />
        {action}
      </div>
      <div role="tabpanel" aria-label={TABS.find(([key]) => key === tab)![1]} className="min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-4">
        {tab === "threads" && <ProjectTasks project={project} threads={threads} coordinator={coordinator} title={title} subtitle={subtitle} panes={panes} session={session}
          currentPaneId={currentPaneId} readOnly={readOnly} onOpenPane={onOpenPane} onOpenNode={onOpenNode} onChanged={onChanged} />}
        {tab === "prs" && <PrList project={project} threads={threads} session={session} readOnly={readOnly} onOpenPane={onOpenPane} onOpenNode={onOpenNode} onChanged={onChanged} />}
        {tab === "activity" && (activityPaneId
          ? <PaneActivity paneId={activityPaneId} session={session} />
          : <p className="text-subhead text-muted-foreground">The coordinator is not running, so there is no activity to show.</p>)}
        {tab === "memory" && <ProjectMemory project={project} threads={threads} />}
      </div>
    </div>
  );
}

/** What Organizations hands every thread: the project's goal, and where the threads work. */
function ProjectMemory({ project, threads }: { project: ProjectView; threads: readonly ProjectThreadView[] }) {
  const branches = threads.filter((thread) => thread.branch && thread.status !== "resolved");
  return (
    <div className="flex flex-col gap-4 text-subhead">
      <section className="rounded-xl border border-border p-3.5">
        <h3 className="text-footnote font-medium">Shared with every thread</h3>
        <p className="mt-1.5 leading-relaxed text-muted-foreground">{project.goal || "This project has no goal written down yet."}</p>
      </section>
      {branches.length > 0 && <section>
        <h3 className="mb-1.5 text-footnote font-medium">Branches</h3>
        <ul className="flex flex-col gap-1">
          {branches.map((thread) => <li key={thread.id} className="flex items-baseline gap-2">
            <span className="shrink-0">{thread.title}</span>
            <span className="truncate font-mono text-code text-muted-foreground">{thread.branch}</span>
          </li>)}
        </ul>
      </section>}
    </div>
  );
}
