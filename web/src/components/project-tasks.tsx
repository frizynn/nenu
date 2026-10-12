import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRight, XCircle } from "lucide-react";

import { TaskRow } from "@/components/node-row";
import { NewNodeActions, errorMessage } from "@/components/node-start";
import { ProjectCoordinator } from "@/components/project-coordinator";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { resolveOrgNode } from "@/lib/api";
import { timeAgoShort } from "@/lib/format";
import { closeRefusal, historyCount, holds, nodeState, orgTree, type OrgNode } from "@/lib/org-tree";
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
  if (thread.status === "failed") return thread.note ?? "Failed to start";
  if (state === "needs") return title ?? thread.note ?? "Asked you a question";
  if (state === "review" && thread.pr) return prSummary(thread.pr);
  // Organizations' own note (pane closed, session unreachable, a remote agent's state) says more than Nenu can.
  if (!thread.paneId) return thread.note || (thread.status !== "open" ? thread.status : state === "working" ? "working" : "not running");
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

interface OrgTreeProps {
  project: ProjectView;
  /** The nodes to draw: the whole project, or the work under one coordinator. */
  threads: readonly ProjectThreadView[];
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
  now?: number;
}

interface ProjectTasksProps extends Omit<OrgTreeProps, "threads"> {
  /** The nodes to list; the whole project when omitted. */
  threads?: readonly ProjectThreadView[];
  /** The coordinator under the project that runs them; the project's own coordinator when omitted. */
  coordinator?: ProjectThreadView;
  /** Heading and its second line; the project's name and goal by default. */
  title?: string;
  subtitle?: ReactNode;
}

/**
 * A project's organization: its coordinator, the open work as a tree (coordinators first, the most
 * urgent first) and one grey History of everything resolved. Every node opens its chat or its
 * detail; an open one can be closed and the coordinator replaced. Under a coordinator below the
 * project, that coordinator heads the list instead of the project's own.
 */
export function ProjectTasks({ threads, coordinator, title, subtitle, ...tree }: ProjectTasksProps) {
  const { project, panes, session, currentPaneId, readOnly, onOpenPane, onOpenNode, onChanged } = tree;
  return (
    <div className="project-tasks">
      <TasksHeader title={title ?? project.name} subtitle={subtitle ?? project.goal} paused={project.status === "paused"} />
      {coordinator
        ? <ul className="task-list mb-2"><CoordinatorRow thread={coordinator} panes={panes} currentPaneId={currentPaneId} onOpenPane={onOpenPane} onOpenNode={onOpenNode} /></ul>
        : <ProjectCoordinator project={project} panes={panes} session={session} current={currentPaneId} readOnly={readOnly} onOpenPane={onOpenPane} onChanged={onChanged} />}
      <OrgTreeList {...tree} threads={threads ?? project.threads} />
      {!readOnly && <div className="mt-3"><NewNodeActions project={project} session={session} onStarted={() => void onChanged()} /></div>}
    </div>
  );
}

/** A coordinator under the project, heading the work it runs; "You're here" when its chat is the one on screen. */
function CoordinatorRow({ thread, panes, currentPaneId, onOpenPane, onOpenNode }: Pick<OrgTreeProps, "panes" | "currentPaneId" | "onOpenPane" | "onOpenNode"> & { thread: ProjectThreadView }) {
  const here = thread.paneId !== undefined && thread.paneId === currentPaneId;
  const detail = [here && "You're here", thread.agent, threadDetail(thread, panes)].filter(Boolean).join(" · ");
  return <TaskRow state={nodeState(thread)} title="Coordinator" detail={detail} current={here} opens={thread.paneId ? "chat" : "details"}
    onOpen={() => thread.paneId ? onOpenPane(thread.paneId) : onOpenNode(thread.id)} />;
}

/** History rows drawn at a time: a long-running project resolves a hundred nodes. */
const HISTORY_PAGE = 20;

/**
 * The open tree and History of a set of nodes, the body of every organization view. History is
 * grey behind one row that starts closed, each resolved coordinator folded over the threads it ran,
 * and draws twenty rows at a time; what holds the pane on screen opens by itself.
 */
export function OrgTreeList({ project, threads, panes, session, currentPaneId, readOnly, onOpenPane, onOpenNode, onChanged, now = Date.now() }: OrgTreeProps) {
  const tree = orgTree(threads);
  const onScreen = (node: OrgNode) => currentPaneId !== undefined && node.thread.paneId === currentPaneId;
  const [closing, setClosing] = useState<OrgNode | null>(null);
  const [historyShown, setHistoryShown] = useState(() => tree.history.some((node) => holds(node, onScreen)));
  const [historyLimit, setHistoryLimit] = useState(() => {
    const held = tree.history.findIndex((node) => holds(node, onScreen));
    return Math.max(HISTORY_PAGE, Math.ceil((held + 1) / HISTORY_PAGE) * HISTORY_PAGE);
  });
  const hidden = tree.history.length - historyLimit;
  const [folds, setFolds] = useState<Record<string, boolean>>({});
  // Show more hands focus to the first row it brought: the last page takes the button with it.
  const historyList = useRef<HTMLUListElement>(null);
  const firstShown = useRef<number | null>(null);
  useEffect(() => {
    if (firstShown.current === null) return;
    historyList.current?.children[firstShown.current]?.querySelector<HTMLElement>(".task-main")?.focus();
    firstShown.current = null;
  }, [historyLimit]);
  const showMore = () => { firstShown.current = historyLimit; setHistoryLimit(historyLimit + HISTORY_PAGE); };

  const branch = (node: OrgNode): ReactNode => {
    const { thread, state } = node;
    const resolved = state === "resolved";
    // Open coordinators always show their work; a resolved one folds until opened.
    const open = !resolved || (folds[thread.id] ?? node.children.some((child) => holds(child, onScreen)));
    const toggle = () => setFolds((current) => ({ ...current, [thread.id]: !open }));
    return (
      <TaskRow key={thread.id} state={state} title={thread.title} detail={nodeDetail(node, panes)} age={threadAge(thread, now)} current={onScreen(node)}
        onOpen={() => thread.paneId ? onOpenPane(thread.paneId) : onOpenNode(thread.id)} opens={thread.paneId ? "chat" : "details"}
        fold={resolved && node.children.length > 0 ? { open, onToggle: toggle } : undefined}
        actions={resolved || readOnly ? undefined : [{ label: "Close", name: `Close ${thread.title}`, icon: XCircle, run: () => setClosing(node),
          menuLabel: thread.role === "coordinator" ? "Close coordinator…" : "Close thread…" }]}>
        {open && node.children.length > 0 && <ul aria-label={`${thread.title} threads`} className="task-list task-branch">{node.children.map(branch)}</ul>}
      </TaskRow>
    );
  };

  return <>
    {tree.open.length > 0 && <ul className="task-list mb-2" aria-label="Open threads">{tree.open.map(branch)}</ul>}
    {tree.history.length > 0 && <>
      <button type="button" className="task-history-toggle" aria-expanded={historyShown} onClick={() => setHistoryShown(!historyShown)}>
        <ChevronRight aria-hidden className="size-3.5" />History · {historyCount(tree.resolved)}
      </button>
      {historyShown && <>
        <ul ref={historyList} className="task-list task-history mb-2" aria-label="History">{tree.history.slice(0, historyLimit).map(branch)}</ul>
        {hidden > 0 && <button type="button" className="task-history-toggle task-history-more" onClick={showMore}>
          Show {Math.min(HISTORY_PAGE, hidden)} more
        </button>}
      </>}
    </>}
    {tree.open.length === 0 && tree.history.length === 0 && <p className="mb-2 px-2 py-1 text-subhead text-muted-foreground">No threads yet.</p>}
    <CloseNodeDialog project={project} node={closing} session={session} onCancel={() => setClosing(null)}
      onClosed={() => { setClosing(null); void onChanged(); }} />
  </>;
}

/** A task list's heading: the project or coordinator, a Paused badge, and its second line. */
export function TasksHeader({ title, subtitle, paused = false }: { title: string; subtitle?: ReactNode; paused?: boolean }) {
  return (
    <header className="mb-4">
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 break-words text-title">{title}</h2>
        {paused && <span className="mt-1 rounded-md bg-muted px-1.5 py-0.5 text-caption text-muted-foreground">Paused</span>}
      </div>
      {subtitle && <p className="mt-1 text-subhead text-muted-foreground">{subtitle}</p>}
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
