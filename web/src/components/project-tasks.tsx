import { useState, type ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";

import { TaskRow, type Fold } from "@/components/node-row";
import { NewNodeActions, errorMessage } from "@/components/node-start";
import { ProjectCoordinator } from "@/components/project-coordinator";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { resolveOrgNode } from "@/lib/api";
import { timeAgoShort } from "@/lib/format";
import { closeRefusal, historyCount, nodeState, orgTree, type OrgNode, type OrgTree } from "@/lib/org-tree";
import { STATUS_LABEL, type AgentView, type ProjectThreadView, type ProjectView, type ThreadPullRequest } from "@/lib/types";

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
  const state = nodeState(thread);
  const title = thread.paneId ? panes.find((pane) => pane.paneId === thread.paneId)?.terminalTitle : undefined;
  if (state === "resolved") return thread.pr ? prSummary(thread.pr) : "Resolved";
  if (thread.status === "failed") return thread.note ?? "Failed to start";
  if (state === "needs") return title ?? thread.note ?? "Asked you a question";
  if (state === "review" && thread.pr) return prSummary(thread.pr);
  // Organizations' own note (pane closed, session unreachable, a remote agent's state) says more than Nenu can.
  if (!thread.paneId) return thread.note || (state === "working" ? "working" : thread.status === "open" ? "not running" : thread.status);
  return title ?? thread.note ?? STATUS_LABEL[thread.liveStatus ?? "unknown"];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** A tree row's second line: what an open node is doing, or what a resolved one was. */
function nodeDetail(node: OrgNode, panes: readonly AgentView[]): string {
  const { thread } = node;
  if (node.state !== "resolved") return thread.role === "coordinator" ? `Coordinator · ${threadDetail(thread, panes)}` : threadDetail(thread, panes);
  const kind = thread.role !== "coordinator" ? "Thread" : node.children.length ? `Coordinator · ${plural(node.children.length, "thread")}` : "Coordinator";
  return [kind, thread.pr && prSummary(thread.pr)].filter(Boolean).join(" · ");
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

/** Every thread under one coordinator, nested ones included: the whole project at its root. */
export function threadTree(project: ProjectView, coordinatorId?: string): ProjectThreadView[] {
  const tree: ProjectThreadView[] = [];
  const seen = new Set<string>();
  const walk = (id?: string) => {
    for (const thread of coordinatedThreads(project, id)) {
      if (seen.has(thread.id)) continue;
      seen.add(thread.id);
      tree.push(thread);
      walk(thread.id);
    }
  };
  walk(coordinatorId);
  return tree;
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
  /** Opens a node that runs in a live pane: its chat. */
  onOpenPane: (paneId: string) => void;
  /** Opens any other node: its detail. */
  onOpenNode: (id: string) => void;
  onChanged: () => Promise<void> | void;
  /** Extra header control, e.g. the panel's collapse button. */
  action?: ReactNode;
  now?: number;
}

/**
 * A project's organization: its coordinator, the open work as a tree (coordinators first, the most
 * urgent first) and one grey History of everything resolved. Every node opens its chat or its
 * detail; an open one can be closed and the coordinator replaced.
 */
export function ProjectTasks({ project, threads = project.threads, title = project.name, subtitle = project.goal, panes, session, currentPaneId, readOnly,
  onOpenPane, onOpenNode, onChanged, action, now = Date.now() }: ProjectTasksProps) {
  return (
    <div className="project-tasks">
      <TasksHeader title={title} subtitle={subtitle} paused={project.status === "paused"} action={action} />
      <ProjectCoordinator project={project} panes={panes} session={session} current={currentPaneId} readOnly={readOnly} onOpenPane={onOpenPane} onChanged={onChanged} />
      <OrgTreeList project={project} threads={threads} panes={panes} session={session} currentPaneId={currentPaneId} readOnly={readOnly}
        onOpenPane={onOpenPane} onOpenNode={onOpenNode} onChanged={onChanged} now={now} />
      {!readOnly && <div className="mt-3"><NewNodeActions project={project} session={session} onStarted={() => void onChanged()} /></div>}
    </div>
  );
}

/** The open tree and History of a set of nodes: the shared body of every organization view. */
export function OrgTreeList({ project, threads, panes, session, currentPaneId, readOnly, onOpenPane, onOpenNode, onChanged, now = Date.now() }:
  Omit<ProjectTasksProps, "title" | "subtitle" | "action" | "threads"> & { threads: readonly ProjectThreadView[] }) {
  const [closing, setClosing] = useState<OrgNode | null>(null);
  const tree = orgTree(threads);
  const open = (thread: ProjectThreadView) => thread.paneId ? onOpenPane(thread.paneId) : onOpenNode(thread.id);
  const row = (node: OrgNode, extra: { fold?: Fold; children?: ReactNode } = {}) => (
    <TaskRow key={node.thread.id} state={node.state} title={node.thread.title} detail={nodeDetail(node, panes)} age={threadAge(node.thread, now)}
      current={currentPaneId !== undefined && node.thread.paneId === currentPaneId} onOpen={() => open(node.thread)} fold={extra.fold}
      action={node.state !== "resolved" && !readOnly && <button type="button" className="task-close" aria-label={`Close ${node.thread.title}`}
        title={node.thread.role === "coordinator" ? "Close coordinator" : "Close thread"} onClick={() => setClosing(node)}><Check aria-hidden className="size-4" /></button>}>
      {extra.children}
    </TaskRow>
  );
  const branch = (node: OrgNode): ReactNode => row(node, {
    children: node.children.length > 0 && <ul aria-label={`${node.thread.title} threads`} className="task-list task-branch">{node.children.map(branch)}</ul>,
  });

  return <>
    {tree.open.length > 0 && <ul className="task-list mb-2" aria-label="Open threads">{tree.open.map(branch)}</ul>}
    {tree.open.length === 0 && tree.history.length === 0 && <p className="mb-2 px-2 py-1 text-sm text-muted-foreground">No threads yet.</p>}
    <History tree={tree} currentPaneId={currentPaneId} row={row} />
    <CloseNodeDialog project={project} node={closing} session={session} onCancel={() => setClosing(null)}
      onClosed={() => { setClosing(null); void onChanged(); }} />
  </>;
}

/**
 * Everything resolved, in grey, behind one row that starts closed: each resolved coordinator folds
 * over the threads it ran. What holds the pane on screen opens by itself.
 */
function History({ tree, currentPaneId, row }: {
  tree: OrgTree;
  currentPaneId?: string;
  row: (node: OrgNode, extra?: { fold?: Fold; children?: ReactNode }) => ReactNode;
}) {
  const holdsCurrent = (node: OrgNode): boolean => currentPaneId !== undefined && (node.thread.paneId === currentPaneId || node.children.some(holdsCurrent));
  const [shown, setShown] = useState(() => tree.history.some(holdsCurrent));
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  if (tree.history.length === 0) return null;
  const branch = (node: OrgNode): ReactNode => {
    if (node.children.length === 0) return row(node);
    const open = folds[node.thread.id] ?? node.children.some(holdsCurrent);
    return row(node, {
      fold: { open, onToggle: () => setFolds((current) => ({ ...current, [node.thread.id]: !open })) },
      children: open && <ul aria-label={`${node.thread.title} threads`} className="task-list task-branch">{node.children.map(branch)}</ul>,
    });
  };
  return <>
    <button type="button" className="task-history-toggle" aria-expanded={shown} onClick={() => setShown(!shown)}>
      <ChevronRight aria-hidden className="size-3.5" />History · {historyCount(tree.resolved)}
    </button>
    {shown && <ul className="task-list mb-2" aria-label="History">{tree.history.map(branch)}</ul>}
  </>;
}

/** A task list's heading: the project or coordinator, a Paused badge, and its second line. */
export function TasksHeader({ title, subtitle, paused, action }: { title: string; subtitle?: ReactNode; paused: boolean; action?: ReactNode }) {
  return (
    <header className="mb-4">
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 break-words text-lg font-semibold tracking-tight">{title}</h2>
        {paused && <span className="mt-1 rounded-md bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">Paused</span>}
        {action}
      </div>
      {subtitle && <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{subtitle}</p>}
    </header>
  );
}

/**
 * Confirm closing a node (Organizations' resolve); on failure it stays open with the cause. A
 * coordinator still running open work is refused here, as Organizations' popup refuses it.
 */
export function CloseNodeDialog({ project, node, session, onClosed, onCancel }: {
  project: ProjectView;
  node: OrgNode | null;
  session?: string;
  onClosed: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refusal = node ? closeRefusal(node) : undefined;
  const noun = node?.thread.role === "coordinator" ? "coordinator" : "thread";

  async function close() {
    if (!node) return;
    setBusy(true);
    setError(null);
    try {
      await resolveOrgNode({ project: project.slug, id: node.thread.id }, session);
      onClosed();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  if (refusal) {
    return (
      <Dialog open onClose={onCancel} title="Close its work first" description={`${refusal} Close those first.`}>
        <div className="mt-5 flex justify-end"><Button type="button" size="lg" onClick={onCancel}>OK</Button></div>
      </Dialog>
    );
  }
  return (
    <ConfirmDialog open={node !== null} title={`Close this ${noun}?`} confirmLabel={`Close ${noun}`} busy={busy} error={error}
      description={<><span className="font-medium text-foreground">{node?.thread.title}</span> stops. Its branch, worktree and report are kept.</>}
      onConfirm={() => void close()} onCancel={() => { if (!busy) { setError(null); onCancel(); } }} />
  );
}
