import { useState, type ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";

import { NewThreadMenu, errorMessage } from "@/components/new-thread-menu";
import { StatusDot } from "@/components/status-badge";
import { ConfirmDialog } from "@/components/ui/dialog";
import { resolveOrgNode } from "@/lib/api";
import { timeAgoShort } from "@/lib/format";
import { STATUS_LABEL, type AgentStatus, type AgentView, type ProjectThreadView, type ProjectView, type ThreadPullRequest } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Where a thread sits in the project's lists, most urgent first. */
export type ThreadBucket = "needs" | "ready" | "working" | "resolved";
export const BUCKET_LABEL: Record<ThreadBucket, string> = { needs: "Needs you", ready: "Ready to review", working: "Working", resolved: "Resolved" };
export const BUCKETS: readonly ThreadBucket[] = ["needs", "ready", "working", "resolved"];

export function threadBucket(thread: ProjectThreadView): ThreadBucket {
  if (thread.status === "resolved") return "resolved";
  if (thread.status === "failed" || (thread.paneId && thread.liveStatus === "blocked")) return "needs";
  const approved = thread.pr?.state === "open" && thread.pr.review === "approved";
  if (thread.group === "ready-for-review" || approved || (thread.paneId && thread.liveStatus === "done")) return "ready";
  return "working";
}

/** The dot a thread wears: its live status, or "review" (blue) once it is ready for review. */
export type ThreadDot = AgentStatus | "review";
export function threadDot(thread: ProjectThreadView): ThreadDot {
  const bucket = threadBucket(thread);
  if (bucket === "ready") return "review";
  if (bucket === "resolved") return "done";
  if (thread.status === "failed") return "blocked";
  return thread.paneId ? thread.liveStatus ?? "unknown" : "unknown";
}

export function ThreadStateDot({ state, className = "size-2" }: { state: ThreadDot; className?: string }) {
  return state === "review"
    ? <span aria-hidden className={cn("inline-flex shrink-0 rounded-full bg-primary", className)} />
    : <StatusDot status={state} surface="bg-transparent" className={className} />;
}

/** One line about a pull request: number, review and checks, as far as Organizations reported them. */
export function prSummary(pr: ThreadPullRequest): string {
  const parts = [pr.number !== undefined ? `PR #${pr.number}` : "PR"];
  if (pr.state === "merged") return `${parts[0]} merged`;
  if (pr.state === "closed") return `${parts[0]} closed`;
  if (pr.state === "draft") parts.push("draft");
  if (pr.review === "approved") parts.push("approved");
  else if (pr.review === "changes_requested") parts.push("changes requested");
  const checks = pr.checks;
  if (checks) {
    const total = checks.passed + checks.failed + checks.pending;
    if (checks.failed) parts.push(`${checks.failed} failing`);
    else if (checks.pending) parts.push(`checks ${checks.passed}/${total}`);
    else if (total) parts.push("checks passed");
  }
  return parts.join(" · ");
}

/** Organizations merges only when it says nothing blocks the merge (`mergeBlocker === null`). */
export function canMerge(project: ProjectView, thread: ProjectThreadView): boolean {
  return Boolean(project.prActions) && thread.pr?.state === "open" && thread.pr.mergeBlocker === null;
}

/** What a thread is doing, for its row: the question, the PR, the agent's own title, or its state. */
export function threadDetail(thread: ProjectThreadView, panes: readonly AgentView[]): string {
  const bucket = threadBucket(thread);
  const title = thread.paneId ? panes.find((pane) => pane.paneId === thread.paneId)?.terminalTitle : undefined;
  if (bucket === "resolved") return ["Resolved", thread.pr && prSummary(thread.pr)].filter(Boolean).join(" · ");
  if (thread.status === "failed") return thread.note ?? "Failed to start";
  if (bucket === "needs") return title ?? thread.note ?? "Asked you a question";
  if (bucket === "ready" && thread.pr) return prSummary(thread.pr);
  if (!thread.paneId) return thread.status === "open" ? "not running" : thread.status;
  return title ?? thread.note ?? STATUS_LABEL[thread.liveStatus ?? "unknown"];
}

export function threadAge(thread: ProjectThreadView, now: number): string | undefined {
  const at = thread.updated ? Date.parse(thread.updated) : NaN;
  return Number.isFinite(at) ? timeAgoShort(at, now) : undefined;
}

/**
 * The threads one coordinator runs: the direct children of a coordinator thread, or the project's
 * top-level threads for the project coordinator.
 */
export function coordinatedThreads(project: ProjectView, coordinatorId?: string): ProjectThreadView[] {
  const parent = coordinatorId ?? "root";
  const ids = new Set(project.threads.map((thread) => thread.id));
  return project.threads.filter((thread) => thread.id !== parent &&
    (thread.parentId === parent || (parent === "root" && !ids.has(thread.parentId))));
}

/** Threads grouped by bucket, in display order, empty groups dropped. */
export function bucketed(threads: readonly ProjectThreadView[]): Array<[ThreadBucket, ProjectThreadView[]]> {
  return BUCKETS.map((bucket) => [bucket, threads.filter((thread) => threadBucket(thread) === bucket)] as [ThreadBucket, ProjectThreadView[]])
    .filter(([, list]) => list.length > 0);
}

interface ProjectTasksProps {
  project: ProjectView;
  /** The threads to list; the whole project when omitted. */
  threads?: ProjectThreadView[];
  /** Heading and its second line; the project's name and goal by default. */
  title?: string;
  subtitle?: ReactNode;
  /** Live panes, so a running thread can say what it is doing right now. */
  panes: readonly AgentView[];
  session?: string;
  currentPaneId?: string;
  readOnly: boolean;
  /** List the project coordinator as the first row. */
  showCoordinator?: boolean;
  onOpenPane: (paneId: string) => void;
  onChanged: () => void;
  /** Extra header control, e.g. the panel's collapse button. */
  action?: ReactNode;
  now?: number;
}

/** The project's threads grouped as Needs you, Ready to review, Working and Resolved. */
export function ProjectTasks({ project, threads = project.threads, title = project.name, subtitle = project.goal, panes, session, currentPaneId, readOnly,
  showCoordinator = true, onOpenPane, onChanged, action, now = Date.now() }: ProjectTasksProps) {
  const [closing, setClosing] = useState<ProjectThreadView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const groups = bucketed(threads);
  const coordinator = showCoordinator ? project.coordinator : undefined;

  async function closeThread() {
    if (!closing) return;
    setBusy(true);
    setError(null);
    try {
      await resolveOrgNode({ project: project.slug, id: closing.id }, session);
      setClosing(null);
      onChanged();
    } catch (failure) {
      // The thread stays in the snapshot; the dialog stays open with the cause.
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="project-tasks">
      <header className="mb-4">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 break-words text-lg font-semibold tracking-tight">{title}</h2>
          {project.status === "paused" && <span className="mt-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Paused</span>}
          {action}
        </div>
        {subtitle && <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{subtitle}</p>}
      </header>

      {coordinator && (
        <ul className="task-list mb-2">
          <TaskRow dot={coordinator.liveStatus} title="Coordinator" detail={`${coordinator.agent} · ${panes.find((pane) => pane.paneId === coordinator.paneId)?.terminalTitle ?? STATUS_LABEL[coordinator.liveStatus]}`}
            current={currentPaneId === coordinator.paneId} onOpen={() => onOpenPane(coordinator.paneId)} />
        </ul>
      )}

      {groups.map(([bucket, list]) => (
        <details key={bucket} className="task-history mb-2" open={bucket !== "resolved" || list.some((thread) => thread.paneId !== undefined && thread.paneId === currentPaneId)}>
          <summary className="flex min-h-9 items-center gap-2 rounded-md bg-muted/40 px-2.5 text-[13px] font-medium">
            <ChevronRight aria-hidden className="size-3.5 text-muted-foreground" />{BUCKET_LABEL[bucket]} <span className="tabular-nums font-normal text-muted-foreground">{list.length}</span>
          </summary>
          {bucket === "needs" && <p className="px-2.5 pt-1.5 text-xs text-muted-foreground">Decisions, reviews and permission requests.</p>}
          <ul className="task-list mt-1">
            {list.map((thread) => (
              <TaskRow key={thread.id} dot={threadDot(thread)} title={thread.title} detail={threadDetail(thread, panes)} age={threadAge(thread, now)}
                current={currentPaneId !== undefined && thread.paneId === currentPaneId}
                onOpen={thread.paneId ? () => onOpenPane(thread.paneId!) : undefined}
                onClose={bucket !== "resolved" && !readOnly ? () => { setError(null); setClosing(thread); } : undefined} />
            ))}
          </ul>
        </details>
      ))}
      {groups.length === 0 && <p className="py-3 text-sm text-muted-foreground">No threads yet.</p>}
      {!readOnly && <div className="mt-3"><NewThreadMenu project={project} session={session} onStarted={onChanged} /></div>}

      <ConfirmDialog open={closing !== null} title="Close this thread?" confirmLabel="Close thread" busy={busy} error={error}
        description={<><span className="font-medium text-foreground">{closing?.title}</span> stops. Its branch, worktree and report are kept.</>}
        onConfirm={() => void closeThread()} onCancel={() => { if (!busy) setClosing(null); }} />
    </div>
  );
}

function TaskRow({ dot, title, detail, age, current, onOpen, onClose }: {
  dot: ThreadDot;
  title: string;
  detail: string;
  age?: string;
  current: boolean;
  onOpen?: () => void;
  onClose?: () => void;
}) {
  const body = <>
    <ThreadStateDot state={dot} className="mt-1.5 size-2" />
    <span className="min-w-0 flex-1">
      <span className="block break-words text-sm font-medium">{title}</span>
      <span className="block truncate text-xs text-muted-foreground">{detail}</span>
    </span>
    {age && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{age}</span>}
  </>;
  return (
    <li className="task-row" aria-current={current ? "true" : undefined}>
      {onOpen ? <button type="button" className="task-main" onClick={onOpen}>{body}</button> : <div className="task-main opacity-75">{body}</div>}
      {onClose && <button type="button" className="task-close" aria-label={`Close ${title}`} title="Close thread" onClick={onClose}><Check aria-hidden className="size-4" /></button>}
    </li>
  );
}
