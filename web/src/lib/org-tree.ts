// A project's organization the way Herdr Organizations' popup draws it, so every Nenu view reads
// the same tree: only the open work, nested under the coordinators that run it, coordinators before
// threads and the most urgent first; and everything resolved in one History tree at the end, each
// resolved coordinator holding the threads it ran, coordinators first and the newest first.
import type { AgentStatus, ProjectThreadView } from "./types";

/** What an open node waits on, most urgent first: the order open nodes are listed in. */
export const OPEN_STATES = ["needs", "review", "working", "idle"] as const;
export type OpenState = typeof OPEN_STATES[number];
export type NodeState = OpenState | "resolved";

export const STATE_LABEL: Record<NodeState, string> = { needs: "Needs you", review: "Ready for review", working: "Working", idle: "Idle", resolved: "Resolved" };

/** A live agent's state in the tree's terms; undefined while Herdr cannot tell. */
export function liveState(status: AgentStatus): OpenState | undefined {
  if (status === "blocked") return "needs";
  if (status === "done") return "review";
  return status === "working" || status === "idle" ? status : undefined;
}

/**
 * Organizations' group decides, as its popup does (landing reads as review); the live pane is the
 * fresher reading of whether an agent is working, and a failed start needs you.
 */
export function nodeState(thread: ProjectThreadView): NodeState {
  if (thread.status === "resolved") return "resolved";
  const live = thread.paneId && thread.liveStatus ? liveState(thread.liveStatus) : undefined;
  if (thread.status === "failed" || live === "needs" || thread.group === "waiting-on-you") return "needs";
  const approved = thread.pr?.state === "open" && thread.pr.review === "approved";
  if (thread.group === "ready-for-review" || thread.group === "landing" || approved || live === "review") return "review";
  if (live) return live;
  return thread.group === "working" || thread.status === "starting" ? "working" : "idle";
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
const byUrgency = (a: OrgNode, b: OrgNode) => coordinatorsFirst(a, b) || OPEN_STATES.indexOf(a.state as OpenState) - OPEN_STATES.indexOf(b.state as OpenState);
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
