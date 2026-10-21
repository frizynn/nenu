// A project's organization the way Herdr Organizations' popup draws it, so every Nenu view reads
// the same tree: only the open work, nested under the coordinators that run it, coordinators before
// threads and the most urgent first; and everything resolved in one History tree at the end, each
// resolved coordinator holding the threads it ran, coordinators first and the newest first.
import type { AgentStatus, ProjectThreadView } from "./types";

/** What an open node waits on. */
export type OpenState = "needs" | "review" | "working" | "idle";
/**
 * `merging`: finished, its own pull request open and its pane gone, so only the merge is left.
 * `closing`: in the review group with its pull request merged, so Organizations resolves it shortly
 * and it is no work to review (ADR 0109).
 */
export type NodeState = OpenState | "merging" | "closing" | "resolved";
/** Most urgent first: the order open nodes are listed in. */
const URGENCY: Record<NodeState, number> = { needs: 0, review: 1, working: 2, idle: 3, merging: 4, closing: 4, resolved: 5 };

export const STATE_LABEL: Record<NodeState, string> = {
  needs: "Needs you", review: "Ready for review", working: "Working", idle: "Idle", merging: "Awaiting merge", closing: "Merged, closes on its own", resolved: "Resolved",
};


/** A live agent's state in the tree's terms; undefined while Herdr cannot tell. */
export function liveState(status: AgentStatus): OpenState | undefined {
  if (status === "blocked") return "needs";
  if (status === "done") return "review";
  return status === "working" || status === "idle" ? status : undefined;
}

/**
 * A coordinator's state from its agent's, and a conversation's. Neither has anything to review: a turn
 * that ended (Herdr's `done`) leaves it idle at its prompt. Undefined while Herdr cannot tell.
 */
export function coordinatorState(status: AgentStatus): OpenState | undefined {
  const live = liveState(status);
  return live === "review" ? "idle" : live;
}

/**
 * A conversation whose turn ended: it said `Waiting for you`, as it does before every answer, on a live
 * pane (a blocked one needs you before this is asked). Organizations groups it Waiting on you; it waits
 * on nobody (ADR 0103).
 */
function atRest(thread: ProjectThreadView, live: OpenState | undefined): boolean {
  return talks(thread) && thread.selfWaiting === true && live !== undefined;
}

/** A conversation that is not a coordinator: a coordinator kept open reads as any coordinator does. */
const talks = (thread: ProjectThreadView) => thread.conversation === true && thread.role !== "coordinator";

/**
 * Organizations' group decides, as its popup does (landing reads as review); the live pane is the
 * fresher reading of whether an agent is working, and a failed start needs you. A coordinator and a
 * conversation are the exception: neither reads as ready for review, which Organizations groups them
 * as once a report has a verdict and Herdr's `done` would say after every turn; each works, needs you
 * (a dialog, a failed start, a lost pane), or is idle. A conversation's own pull request, approved or
 * landing, still reads as review. A review whose pull request merged is `closing` (ADR 0109).
 */
export function nodeState(thread: ProjectThreadView): NodeState {
  const state = groupState(thread);
  return state === "review" && thread.pr?.state === "merged" ? "closing" : state;
}

function groupState(thread: ProjectThreadView): NodeState {
  if (thread.status === "resolved") return "resolved";
  const live = thread.paneId && thread.liveStatus ? liveState(thread.liveStatus) : undefined;
  if (thread.status === "failed" || live === "needs" || (thread.group === "waiting-on-you" && !atRest(thread, live))) return "needs";
  if (thread.group === "awaiting-merge") return "merging";
  const approved = thread.pr?.state === "open" && thread.pr.review === "approved";
  if (talks(thread) && (approved || thread.group === "landing")) return "review";
  if (thread.role === "coordinator" || talks(thread)) {
    const own = thread.paneId && thread.liveStatus ? coordinatorState(thread.liveStatus) : undefined;
    return own ?? (thread.group === "working" || thread.status === "starting" ? "working" : "idle");
  }
  if (thread.group === "ready-for-review" || thread.group === "landing" || approved || live === "review") return "review";
  if (live) return live;
  return thread.group === "working" || thread.status === "starting" ? "working" : "idle";
}

/**
 * What a node that needs you waits for, when it is something to answer: a dialog on its screen
 * (Herdr reads the pane blocked), or the agent's own report that it stopped for your reply, which
 * leaves it idle at its prompt with no dialog at all. Organizations' other reasons (a closed pane,
 * a failed or stuck start) are neither, and their note says them.
 */
export type Ask = "question" | "reply";

/** How each ask reads: the tree's word, the row's line, and the button that opens the chat. */
export const ASK: Record<Ask, { word: string; label: string; action: string }> = {
  question: { word: "needs you", label: "Asked you a question", action: "Answer" },
  reply: { word: "needs reply", label: "Waiting for your reply", action: "Reply" },
};

export function awaits(thread: ProjectThreadView): Ask | undefined {
  if (thread.status === "failed" || !thread.paneId || nodeState(thread) !== "needs") return undefined;
  if (thread.liveStatus && liveState(thread.liveStatus) === "needs") return "question";
  return thread.selfWaiting ? "reply" : undefined;
}

export interface OrgNode {
  thread: ProjectThreadView;
  state: NodeState;
  /** Open nodes under an open coordinator, or resolved ones under a resolved coordinator. */
  children: OrgNode[];
}

export interface OrgTree {
  open: OrgNode[];
  history: OrgNode[];
  /** How much History holds, by kind. */
  resolved: { coordinators: number; threads: number };
}

const coordinatorsFirst = (a: OrgNode, b: OrgNode) => Number(a.thread.role !== "coordinator") - Number(b.thread.role !== "coordinator");
const byUrgency = (a: OrgNode, b: OrgNode) => coordinatorsFirst(a, b) || URGENCY[a.state] - URGENCY[b.state];
const updatedAt = (node: OrgNode) => Date.parse(node.thread.updated ?? "") || 0;
const newestFirst = (a: OrgNode, b: OrgNode) => coordinatorsFirst(a, b) || updatedAt(b) - updatedAt(a);

/**
 * Nests each node under its parent when the parent is in the same set, so an open node under a
 * resolved coordinator, or a resolved one under an open coordinator, starts its own top level.
 * A corrupt record whose parents loop back to it is listed at the top instead.
 */
function forest(threads: readonly ProjectThreadView[], order: (a: OrgNode, b: OrgNode) => number): OrgNode[] {
  const nodes = new Map(threads.map((thread) => [thread.id, { thread, state: nodeState(thread), children: [] as OrgNode[] }]));
  const loops = (node: OrgNode) => {
    for (let seen = 0, id = node.thread.parentId; seen < nodes.size; seen++) {
      const ancestor = nodes.get(id);
      if (!ancestor) return false;
      if (ancestor === node) return true;
      id = ancestor.thread.parentId;
    }
    return false;
  };
  const top: OrgNode[] = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.thread.parentId);
    (parent && !loops(node) ? parent.children : top).push(node);
  }
  // Array sort is stable: equal keys keep Organizations' id order.
  const sort = (list: OrgNode[]): OrgNode[] => {
    list.sort(order);
    for (const node of list) sort(node.children);
    return list;
  };
  return sort(top);
}

/** The one model every view of a project's organization reads. */
export function orgTree(threads: readonly ProjectThreadView[]): OrgTree {
  const resolved = threads.filter((thread) => thread.status === "resolved");
  const coordinators = resolved.filter((thread) => thread.role === "coordinator").length;
  return {
    open: forest(threads.filter((thread) => thread.status !== "resolved"), byUrgency),
    history: forest(resolved, newestFirst),
    resolved: { coordinators, threads: resolved.length - coordinators },
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** `2 coordinators, 75 threads`, as Organizations labels its History row. */
export function historyCount({ coordinators, threads }: OrgTree["resolved"]): string {
  if (!coordinators) return plural(threads, "thread");
  if (!threads) return plural(coordinators, "coordinator");
  return `${plural(coordinators, "coordinator")}, ${plural(threads, "thread")}`;
}

/** Why an open node cannot be closed yet: a coordinator still running open work under it. */
export function closeRefusal(node: OrgNode): string | undefined {
  const open = node.children.length;
  return node.state !== "resolved" && open > 0 ? `${node.thread.title} still has ${open} open under it.` : undefined;
}

/** Every node in a tree, depth first. */
export function flatten(nodes: readonly OrgNode[]): OrgNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}

/** Whether a node or one under it passes `test`, e.g. holds the pane on screen. */
export function holds(node: OrgNode, test: (node: OrgNode) => boolean): boolean {
  return test(node) || node.children.some((child) => holds(child, test));
}

export interface Placed {
  node: OrgNode;
  /** 0 for a node at the project's top level. */
  depth: number;
}

/** Every open coordinator, in the tree's order, each with how deep it sits: the coordinators a project organizes. */
export function openCoordinators(tree: OrgTree): Placed[] {
  const walk = (nodes: readonly OrgNode[], depth: number): Placed[] =>
    nodes.flatMap((node) => node.thread.role === "coordinator" ? [{ node, depth }, ...walk(node.children, depth + 1)] : []);
  return walk(tree.open, 0);
}

/**
 * Where an open node can go: the project's top level, or an open coordinator that is neither the node,
 * one of its own, nor where it already is. Organizations judges the rest, such as a coordinator that
 * may not start nodes.
 */
export function moveTargets(tree: OrgTree, node: OrgNode): { root: boolean; coordinators: Placed[] } {
  const own = new Set(flatten([node]).map((n) => n.thread.id));
  return {
    root: node.thread.parentId !== "root",
    coordinators: openCoordinators(tree).filter(({ node: target }) => !own.has(target.thread.id) && target.thread.id !== node.thread.parentId),
  };
}

/** Whether a project organizes coordinators: one open under it at least. A project with only its own coordinator is drawn as before. */
export function organizes(tree: OrgTree): boolean {
  return tree.open.some((node) => node.thread.role === "coordinator");
}
