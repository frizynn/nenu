// What a desk's project and coordinator pages list (ADR 0102): every open coordinator as a card holding
// the threads it runs, the project coordinator's card last with the threads started from the project;
// finished work as one History by day (ADR 0106); the routines by whom they reach. It reads the one
// tree (org-tree.ts) and never re-judges a node's state.
import { askSections, type AskEntry } from "./asks";
import { flatten, mergedToClose, openCoordinators, orgTree, type NodeState, type OrgNode } from "./org-tree";
import type { AskCoordinator, AsksList, ProjectThreadView, ProjectView, RoutineEdit, RoutineView } from "./types";

export interface WorkCard {
  /** The coordinator; undefined for the project coordinator's card. */
  coordinator?: OrgNode;
  /** The threads it runs directly, in the tree's order (the most urgent first). */
  rows: OrgNode[];
}

const isCoordinator = (node: OrgNode) => node.thread.role === "coordinator";
const updatedAt = (thread: ProjectThreadView) => Date.parse(thread.updated ?? "") || 0;

/**
 * Each open coordinator, at any depth and in the tree's order, with its open threads, then the project
 * coordinator with the open threads at the top level. A coordinator under another is its own card.
 */
export function workCards(project: ProjectView): WorkCard[] {
  const tree = orgTree(project.threads);
  return [
    ...openCoordinators(tree).map(({ node }) => ({ coordinator: node, rows: node.children.filter((child) => !isCoordinator(child)) })),
    { rows: tree.open.filter((node) => !isCoordinator(node)) },
  ];
}

/** A finished thread with whoever ran it, or a finished coordinator with how many threads it ran. */
export interface HistoryRow {
  node: OrgNode;
  /** The coordinator that ran a thread; `Project` for one started from the project. */
  by?: string;
  /** A coordinator's: the threads it ran. */
  threads?: number;
}

export interface HistoryDay { key: string; label: string; rows: HistoryRow[] }

/**
 * Everything finished in History: each resolved thread and each resolved coordinator that ran at least
 * one thread. A coordinator that never ran one is a start that failed or was started again under the
 * same name, and is left out, so the same name does not read twice.
 */
function historyRows(project: ProjectView): HistoryRow[] {
  const tree = orgTree(project.threads);
  const titles = new Map(project.threads.map((thread) => [thread.id, thread.title]));
  return flatten([...tree.open, ...tree.history])
    .filter((node) => node.state === "resolved" && (!isCoordinator(node) || node.children.length > 0))
    .sort((a, b) => updatedAt(b.thread) - updatedAt(a.thread))
    .map((node) => isCoordinator(node)
      ? { node, threads: node.children.length }
      : { node, by: titles.get(node.thread.parentId) ?? "Project" });
}

/** How many rows History holds. */
export function finishedCount(project: ProjectView): number {
  return historyRows(project).length;
}

/** Case and accents aside: `calidad` finds `Calidad y orden del código`, `codigo` finds `código`. */
const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

const dayKey = (at: Date) => `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;

/** A day as History heads it: Today, Yesterday, a weekday with its date within the week, then the date. */
export function dayLabel(at: Date, now: Date): string {
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
    - new Date(at.getFullYear(), at.getMonth(), at.getDate()).getTime()) / 86_400_000);
  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days > 1 && days < 7) return at.toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  return at.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }) });
}

/** History, newest first, by the day each row last changed; `query` keeps rows whose name, id or coordinator holds it. */
export function historyDays(project: ProjectView, query = "", now = new Date()): HistoryDay[] {
  const wanted = fold(query.trim());
  const days: HistoryDay[] = [];
  for (const row of historyRows(project)) {
    if (wanted && ![row.node.thread.title, row.node.thread.id, row.by ?? ""].some((text) => fold(text).includes(wanted))) continue;
    const at = updatedAt(row.node.thread);
    const key = at ? dayKey(new Date(at)) : "undated";
    const last = days.at(-1);
    if (last?.key === key) last.rows.push(row);
    else days.push({ key, label: at ? dayLabel(new Date(at), now) : "Earlier", rows: [row] });
  }
  return days;
}

/** A card's second line: what waits on you there, then what its threads are doing; a merged one closes on its own and is not counted. */
export function cardSummary(rows: readonly OrgNode[], waiting: number): Array<{ text: string; state: NodeState }> {
  const count = (state: NodeState) => rows.filter((row) => row.state === state && !mergedToClose(row.thread, row.state)).length;
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

/** The pull request events a routine can fire on, in Organizations' order, as the editor names them. */
export const ROUTINE_EVENTS: ReadonlyArray<{ id: string; label: string }> = [
  { id: "opened", label: "A pull request opens" }, { id: "checks-failed", label: "Checks fail" },
  { id: "review", label: "A review lands" }, { id: "merged", label: "It merges" },
];

/** A routine in the editor: its trigger and what each trigger holds, whom it reaches as `routine set --to` takes it, and its prompt. */
export interface RoutineDraft {
  trigger: "schedule" | "pr";
  schedule: string;
  events: string[];
  /** `root`, `owner`, `new`, or `node:<id>`; a node only named by a title nothing matches keeps Organizations' `to`. */
  to: string;
  /** For `new`: `root` or a node id. */
  parent: string;
  prompt: string;
}

export function routineDraft(routine: RoutineView, threads: readonly ProjectThreadView[]): RoutineDraft {
  const target = routineTarget(routine, threads);
  const to = target.kind === "node" ? (target.id ? `node:${target.id}` : routine.to) : target.kind;
  return {
    trigger: routine.trigger, schedule: routine.schedule, events: routine.trigger === "pr" && !routine.events.length ? ROUTINE_EVENTS.map((event) => event.id) : routine.events,
    to, parent: target.kind === "new" ? target.parent : "root", prompt: routine.prompt,
  };
}

/** What the editor changed, and only that: `routine set` keeps every field it is not given. */
export function routineChanges(routine: RoutineView, threads: readonly ProjectThreadView[], draft: RoutineDraft): RoutineEdit {
  const was = routineDraft(routine, threads);
  const sorted = (events: readonly string[]) => [...events].sort().join(",");
  const edit: RoutineEdit = {};
  if (draft.trigger === "schedule" && (was.trigger !== "schedule" || draft.schedule.trim() !== was.schedule)) edit.schedule = draft.schedule.trim();
  if (draft.trigger === "pr" && (was.trigger !== "pr" || sorted(draft.events) !== sorted(was.events))) edit.events = [...draft.events];
  if (draft.to !== was.to) edit.to = draft.to;
  if (draft.to === "new" && (edit.to !== undefined || draft.parent !== was.parent)) edit.parent = draft.parent;
  if (draft.prompt.trim() !== was.prompt.trim()) edit.prompt = draft.prompt.trim();
  return edit;
}
