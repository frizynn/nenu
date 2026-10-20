// What a desk's project and coordinator pages list (ADR 0102): every coordinator as a card holding the
// threads it runs, the project coordinator's card last with the threads started from the project, and
// the routines by whom they reach. It reads the one tree (org-tree.ts) and never re-judges a node's state.
import { askSections, type AskEntry } from "./asks";
import { flatten, openCoordinators, orgTree, type NodeState, type OrgNode } from "./org-tree";
import type { AskCoordinator, AsksList, ProjectThreadView, ProjectView, RoutineView } from "./types";

export type WorkFilter = "open" | "finished";

export interface WorkCard {
  /** The coordinator; undefined for the project coordinator's card. */
  coordinator?: OrgNode;
  /** The threads it runs directly, in the tree's order (the most urgent first, or the newest first once finished). */
  rows: OrgNode[];
}

const isCoordinator = (node: OrgNode) => node.thread.role === "coordinator";
const updatedAt = (thread: ProjectThreadView) => Date.parse(thread.updated ?? "") || 0;

/**
 * Open: each open coordinator, at any depth and in the tree's order, with its open threads, then the
 * project coordinator with the open threads at the top level. Finished: the same cards over resolved
 * threads, every coordinator that ran one, newest first. A coordinator under another is its own card.
 */
export function workCards(project: ProjectView, filter: WorkFilter): WorkCard[] {
  const tree = orgTree(project.threads);
  if (filter === "open") {
    return [
      ...openCoordinators(tree).map(({ node }) => ({ coordinator: node, rows: node.children.filter((child) => !isCoordinator(child)) })),
      { rows: tree.open.filter((node) => !isCoordinator(node)) },
    ];
  }
  const ids = new Set(project.threads.map((thread) => thread.id));
  const nodes = new Map(flatten([...tree.open, ...tree.history]).map((node) => [node.thread.id, node]));
  const finished = [...nodes.values()].filter((node) => node.state === "resolved" && !isCoordinator(node))
    .sort((a, b) => updatedAt(b.thread) - updatedAt(a.thread));
  const byParent = new Map<string, OrgNode[]>();
  for (const node of finished) {
    const parent = ids.has(node.thread.parentId) ? node.thread.parentId : "root";
    const rows = byParent.get(parent);
    if (rows) rows.push(node);
    else byParent.set(parent, [node]);
  }
  const coordinators = [...nodes.values()].filter((node) => isCoordinator(node) && (node.state === "resolved" || byParent.has(node.thread.id)))
    .sort((a, b) => Number(a.state === "resolved") - Number(b.state === "resolved") || updatedAt(b.thread) - updatedAt(a.thread));
  return [
    ...coordinators.map((node) => ({ coordinator: node, rows: byParent.get(node.thread.id) ?? [] })),
    ...(byParent.has("root") ? [{ rows: byParent.get("root")! }] : []),
  ];
}

/** How many nodes the Finished filter holds: every resolved one, coordinators included. */
export function finishedCount(project: ProjectView): number {
  return project.threads.filter((thread) => thread.status === "resolved").length;
}

/** A card's second line: what waits on you there, then what its threads are doing. */
export function cardSummary(rows: readonly OrgNode[], waiting: number): Array<{ text: string; state: NodeState }> {
  const count = (state: NodeState) => rows.filter((row) => row.state === state).length;
  const needs = count("needs");
  return [
    waiting > 0 && { text: `${waiting} waiting on you`, state: "needs" as const },
    needs > 0 && { text: `${needs} ${needs === 1 ? "needs" : "need"} you`, state: "needs" as const },
    count("review") > 0 && { text: `${count("review")} to review`, state: "review" as const },
    count("working") > 0 && { text: `${count("working")} working`, state: "working" as const },
  ].filter((part) => part !== false);
}

/** What waits on you in a project, by coordinator in the list's order; `count` takes in each question's parts. */
export function waitingGroups(list: AsksList, project: ProjectView): Array<{ coordinator: AskCoordinator; entries: AskEntry[]; count: number }> {
  const waiting = askSections(list, [project], { project: project.slug }).find((section) => section.group === "waiting")?.entries ?? [];
  const groups = new Map<string, { coordinator: AskCoordinator; entries: AskEntry[]; count: number }>();
  for (const entry of waiting) {
    const group = groups.get(entry.coordinator.id) ?? { coordinator: entry.coordinator, entries: [], count: 0 };
    group.entries.push(entry);
    group.count += 1 + entry.parts.length;
    groups.set(entry.coordinator.id, group);
  }
  return [...groups.values()];
}

// ── Routines ────────────────────────────────────────────────────────────────────────────────────

/** Whom a routine reaches: `root`, the thread owning the pull request, one node, or a new thread under a node. */
export type RoutineTarget = { kind: "root" } | { kind: "owner" } | { kind: "node"; id?: string; name: string } | { kind: "new"; parent: string };

/** Organizations' `to`; a file without one reads as `root` for a schedule and `owner` for a pull request. */
export function routineTarget(routine: RoutineView, threads: readonly ProjectThreadView[]): RoutineTarget {
  const to = routine.to || (routine.trigger === "pr" ? "owner" : "root");
  if (to === "owner") return { kind: "owner" };
  if (to === "new") return { kind: "new", parent: routine.parent || "root" };
  if (to.startsWith("node:")) {
    const name = to.slice("node:".length);
    const thread = threads.find((candidate) => candidate.id === name) ?? threads.find((candidate) => candidate.title === name);
    return { kind: "node", id: thread?.id, name: thread?.title ?? name };
  }
  return { kind: "root" };
}

const nodeName = (id: string, threads: readonly ProjectThreadView[]) =>
  id === "root" ? "the project coordinator" : threads.find((thread) => thread.id === id)?.title ?? id;

/** Whom a routine reaches, as its detail says it. */
export function routineRecipient(routine: RoutineView, threads: readonly ProjectThreadView[]): string {
  const target = routineTarget(routine, threads);
  if (target.kind === "root") return "The project coordinator";
  if (target.kind === "owner") return "The thread that owns the pull request";
  if (target.kind === "new") return `A new thread under ${nodeName(target.parent, threads)}`;
  return target.name;
}

/** The same, short, after a row's "when". */
export function routineRecipientShort(routine: RoutineView, threads: readonly ProjectThreadView[]): string {
  const target = routineTarget(routine, threads);
  if (target.kind === "root") return "to the project coordinator";
  if (target.kind === "owner") return "to the PR's thread";
  if (target.kind === "new") return "to a new thread";
  return `to ${target.name}`;
}

const EVENT: Record<string, string> = { opened: "a pull request opens", "checks-failed": "checks fail", review: "a review lands", merged: "it merges" };

/** When a routine runs: its schedule as written, or the pull request events it fires on. */
export function routineWhen(routine: RoutineView): string {
  if (routine.trigger === "schedule") return routine.schedule;
  const events = (routine.events.length ? routine.events : Object.keys(EVENT)).map((event) => EVENT[event] ?? event);
  return `When ${events.length > 1 ? `${events.slice(0, -1).join(", ")} or ${events.at(-1)}` : events[0]}`;
}

/** The routines that reach one coordinator by name (`root` for the project's own). */
export function routinesFor(routines: readonly RoutineView[], coordinatorId: string, threads: readonly ProjectThreadView[]): RoutineView[] {
  return routines.filter((routine) => {
    const target = routineTarget(routine, threads);
    return coordinatorId === "root" ? target.kind === "root" : target.kind === "node" && target.id === coordinatorId;
  });
}
