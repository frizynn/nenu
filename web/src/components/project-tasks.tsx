import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowRight, ChevronRight, CircleX } from "@/components/ui/icon";

import { TaskRow } from "@/components/node-row";
import { CoordinatorStatus } from "@/components/coordinator-status";
import { NewNodeActions, errorMessage } from "@/components/node-start";
import { ProjectCoordinator } from "@/components/project-coordinator";
import { ProjectGlyph } from "@/components/project-glyph";
import { Button } from "@/components/ui/button";
import { ConfirmDialog, Dialog } from "@/components/ui/dialog";
import { moveOrgNode, resolveOrgNode } from "@/lib/api";
import { timeAgoShort } from "@/lib/format";
import { ASK, STATE_LABEL, awaits, closeRefusal, historyCount, holds, moveTargets, nodeState, orgTree, type OrgNode, type OrgTree } from "@/lib/org-tree";
import { STATUS_LABEL, type AgentView, type ProjectThreadView, type ProjectView, type StatusFile, type ThreadPullRequest } from "@/lib/types";

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
  const ask = awaits(thread);
  if (ask) return ASK[ask].label;
  if (state === "needs") return title ?? thread.note ?? "Needs you";
  if (state === "closing") return [STATE_LABEL.closing, thread.pr?.number !== undefined && `PR #${thread.pr.number}`].filter(Boolean).join(" · ");
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
  /** Leave the heading out, where the page around already names the project. */
  bare?: boolean;
  /** The coordinator's STATUS.md, drawn under the heading. */
  status?: StatusFile;
}

/**
 * A project's organization: its coordinator, the open work as a tree (coordinators first, the most
 * urgent first) and one grey History of everything resolved. Every node opens its chat or its
 * detail; an open one can be closed and the coordinator replaced. Under a coordinator below the
 * project, that coordinator heads the list instead of the project's own.
 */
export function ProjectTasks({ threads, coordinator, title, subtitle, bare = false, status, ...tree }: ProjectTasksProps) {
  const { project, panes, session, currentPaneId, readOnly, onOpenPane, onOpenNode, onChanged } = tree;
  return (
    <div className="project-tasks">
      {!bare && <TasksHeader title={title ?? project.name} subtitle={subtitle ?? project.goal} paused={project.status === "paused"}
        mark={title === undefined ? <ProjectGlyph slug={project.slug} pick={project} size={20} className="mt-1" /> : undefined} />}
      {status && <CoordinatorStatus status={status} project={project} onOpenNode={onOpenNode} />}
      {coordinator
        ? <ul className="task-list mb-2"><CoordinatorRow thread={coordinator} panes={panes} currentPaneId={currentPaneId} onOpenPane={onOpenPane} onOpenNode={onOpenNode} /></ul>
        : <ProjectCoordinator project={project} panes={panes} session={session} current={currentPaneId} readOnly={readOnly} onOpenPane={onOpenPane} onChanged={onChanged} />}
      <OrgTreeList {...tree} threads={threads ?? project.threads} />
      {/* Under a coordinator below the project, what starts here goes under it. */}
      {!readOnly && <div className="mt-3 flex flex-wrap gap-1">
        <NewNodeActions project={project} under={coordinator && { id: coordinator.id, title: coordinator.title }} session={session} onStarted={() => void onChanged()} />
      </div>}
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

/** Organizations says which nodes have another parent; Move shows only where one has somewhere to go. */
export function canMove(project: ProjectView, whole: OrgTree, node: OrgNode): boolean {
  if (!project.nodeMoves || !node.thread.movable) return false;
  const targets = moveTargets(whole, node);
  return targets.root || targets.coordinators.length > 0;
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
  const [moving, setMoving] = useState<OrgNode | null>(null);
  // The dialog lists every coordinator of the project a node could go under, not only the ones this view lists.
  const whole = orgTree(project.threads);
  const movable = (node: OrgNode) => canMove(project, whole, node);
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
    const actions = resolved || readOnly ? undefined : [
      ...(movable(node) ? [{ label: "Move", name: `Move ${thread.title}`, icon: ArrowRight, run: () => setMoving(node), menuLabel: "Move to…", destructive: false }] : []),
      { label: "Close", name: `Close ${thread.title}`, icon: CircleX, run: () => setClosing(node), menuLabel: thread.role === "coordinator" ? "Close coordinator…" : "Close thread…" },
    ];
    return (
      <TaskRow key={thread.id} state={state} title={thread.title} detail={nodeDetail(node, panes)} age={threadAge(thread, now)} current={onScreen(node)}
        onOpen={() => thread.paneId ? onOpenPane(thread.paneId) : onOpenNode(thread.id)} opens={thread.paneId ? "chat" : "details"}
        fold={resolved && node.children.length > 0 ? { open, onToggle: toggle } : undefined} actions={actions}>
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
    {moving && <MoveNodeDialog project={project} tree={whole} node={moving} session={session} onCancel={() => setMoving(null)}
      onMoved={() => { setMoving(null); void onChanged(); }} />}
  </>;
}

/**
 * Choose where an open node goes (Organizations' `node move`): the project's top level or an open
 * coordinator that is not the node or one of its own. On failure it stays open with the cause.
 */
export function MoveNodeDialog({ project, tree, node, session, onMoved, onCancel }: {
  project: ProjectView;
  tree: OrgTree;
  node: OrgNode;
  session?: string;
  onMoved: () => void;
  onCancel: () => void;
}) {
  const targets = moveTargets(tree, node);
  const options = [
    ...(targets.root ? [{ id: "root", title: `${project.name}, at the top level`, depth: 0 }] : []),
    ...targets.coordinators.map(({ node: target, depth }) => ({ id: target.thread.id, title: target.thread.title, depth })),
  ];
  const [parent, setParent] = useState(options[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noun = node.thread.role === "coordinator" ? "coordinator" : "thread";

  async function move() {
    setBusy(true);
    setError(null);
    try {
      await moveOrgNode({ project: project.slug, id: node.thread.id, parent }, session);
      onMoved();
    } catch (failure) {
      setError(errorMessage(failure));
      setBusy(false);
    }
  }

  return (
    <Dialog open onClose={() => { if (!busy) onCancel(); }} title={`Move this ${noun}`}
      description={<><span className="font-medium text-foreground">{node.thread.title}</span>{node.children.length > 0 && ", with everything under it,"} goes under:</>}>
      <div role="radiogroup" aria-label="New parent" className="mt-3 flex max-h-72 flex-col gap-1 overflow-y-auto">
        {options.map((option) => (
          <label key={option.id} className="flex min-h-11 cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-hover" style={{ paddingLeft: `${0.5 + option.depth}rem` }}>
            <input type="radio" name="parent" value={option.id} checked={parent === option.id} onChange={() => setParent(option.id)} />
            <span className="min-w-0 flex-1 break-words text-body">{option.title}</span>
          </label>
        ))}
      </div>
      {error && <p role="alert" className="mt-3 text-subhead text-destructive">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="lg" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="button" size="lg" onClick={() => void move()} disabled={busy || !parent} aria-busy={busy || undefined}>{busy ? "Moving…" : "Move"}</Button>
      </div>
    </Dialog>
  );
}

/** A task list's heading: the project's glyph (`mark`) when it lists the whole project, the project or coordinator, a Paused badge, and its second line. */
export function TasksHeader({ title, subtitle, paused = false, mark }: { title: string; subtitle?: ReactNode; paused?: boolean; mark?: ReactNode }) {
  return (
    <header className="mb-4">
      <div className="flex items-start gap-2">
        {mark}
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
