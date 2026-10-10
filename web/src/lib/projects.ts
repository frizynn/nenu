// Pure view-model helpers for the project hub: what a project's status reads as, which project a
// pane belongs to, and how chats are grouped by recency. Kept free of React so the sidebar, the
// home list and the project panel share one definition and the rules stay unit-testable.
import type { AgentView, ProjectThreadView, ProjectView } from "./types";
import { paneDisplayName } from "./types";

export const isOpenThread = (thread: ProjectThreadView) => thread.status !== "resolved";

/** A thread with the threads it coordinates, as Organizations nests them. */
export interface ThreadNode {
  thread: ProjectThreadView;
  children: ThreadNode[];
}

/** Nests threads under their parent; one whose parent is missing (resolved, filtered out) is a root. */
export function nestThreads(threads: readonly ProjectThreadView[]): ThreadNode[] {
  const nodes = new Map(threads.map((thread) => [thread.id, { thread, children: [] as ThreadNode[] }]));
  const parentOf = (node: ThreadNode) => {
    // A corrupt record could loop its parents; such a thread is listed at the root instead.
    for (let seen = 0, id = node.thread.parentId; seen <= nodes.size; seen++) {
      const ancestor = nodes.get(id);
      if (!ancestor) return nodes.get(node.thread.parentId);
      if (ancestor === node) return undefined;
      id = ancestor.thread.parentId;
    }
    return undefined;
  };
  const roots: ThreadNode[] = [];
  for (const node of nodes.values()) (parentOf(node)?.children ?? roots).push(node);
  return roots;
}

/** One line under a project's name: live activity (coordinator and open threads), then how much is open. */
export function projectSummary(project: ProjectView): string {
  const threads = project.threads.filter(isOpenThread);
  const live = [project.coordinator?.liveStatus, ...threads.map((thread) => thread.liveStatus)];
  const working = live.filter((status) => status === "working").length;
  const blocked = live.filter((status) => status === "blocked").length;
  const open = threads.length;
  const parts = [working && `${working} working`, blocked && `${blocked} blocked`].filter(Boolean);
  if (parts.length) return parts.join(" · ");
  if (project.status === "paused") return "Paused";
  return open ? `${open} open ${open === 1 ? "task" : "tasks"}` : "No open tasks";
}

export interface PaneProject {
  project: ProjectView;
  /** The thread this pane runs; undefined when the pane is the project's coordinator. */
  thread?: ProjectThreadView;
}

export function projectForPane(projects: readonly ProjectView[] | undefined, paneId: string | undefined): PaneProject | undefined {
  if (!paneId) return undefined;
  for (const project of projects ?? []) {
    if (project.coordinator?.paneId === paneId) return { project };
    const thread = project.threads.find((candidate) => candidate.paneId === paneId);
    if (thread) return { project, thread };
  }
  return undefined;
}

/** Chats are the agent panes outside any project; a project's panes live in its task list. */
export function looseChats(panes: readonly AgentView[], projects: readonly ProjectView[] | undefined): AgentView[] {
  return panes.filter((pane) => !projectForPane(projects, pane.paneId));
}

export type RecencyKey = "today" | "week" | "older";
export const RECENCY_LABEL: Record<RecencyKey, string> = { today: "Today", week: "Last 7 days", older: "Older" };

/** Last time the chat moved or was opened; 0 when an older bridge reports neither. */
export function chatRecency(pane: AgentView): number {
  return Math.max(pane.lastActiveAt ?? 0, pane.lastSeenAt ?? 0);
}

export function recencyOf(ts: number, now: number): RecencyKey {
  if (!ts) return "older";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (ts >= startOfToday.getTime()) return "today";
  return now - ts < 7 * 24 * 60 * 60 * 1000 ? "week" : "older";
}

export interface ChatGroup {
  key: RecencyKey;
  label: string;
  chats: AgentView[];
}

export function byRecency(panes: readonly AgentView[]): AgentView[] {
  return [...panes].sort((a, b) => chatRecency(b) - chatRecency(a));
}

/** Newest first, bucketed into the non-empty recency groups in display order. */
export function groupChats(panes: readonly AgentView[], now: number): ChatGroup[] {
  const sorted = byRecency(panes);
  return (Object.keys(RECENCY_LABEL) as RecencyKey[])
    .map((key) => ({ key, label: RECENCY_LABEL[key], chats: sorted.filter((pane) => recencyOf(chatRecency(pane), now) === key) }))
    .filter((group) => group.chats.length > 0);
}

/** Case-insensitive match of a trimmed query against any of the given fields. */
export function matches(query: string, ...fields: Array<string | undefined>): boolean {
  const needle = query.trim().toLocaleLowerCase();
  return !needle || fields.some((field) => field?.toLocaleLowerCase().includes(needle));
}

export function projectMatches(project: ProjectView, query: string): boolean {
  return matches(query, project.name, project.slug, project.goal, ...project.threads.flatMap((thread) => [thread.id, thread.title]));
}

export function chatMatches(pane: AgentView, query: string): boolean {
  return matches(query, paneDisplayName(pane), pane.agent, pane.cwd, pane.workspaceLabel, pane.terminalTitle);
}

/** A project pane goes by its task (or "Coordinator"); any other pane by its own name. */
export function paneTitle(pane: AgentView, owner: PaneProject | undefined): string {
  if (!owner) return paneDisplayName(pane);
  return owner.thread?.title ?? "Coordinator";
}

/** A project's rows in the sidebar's Projects view, narrowed to a search. */
export interface ProjectGroup {
  project: ProjectView;
  coordinator: boolean;
  open: ProjectThreadView[];
  resolved: ProjectThreadView[];
}

/**
 * Each project with the rows a search keeps: a match on the project itself keeps all of them,
 * otherwise only the matching tasks. Projects with nothing left drop out.
 */
export function projectGroups(projects: readonly ProjectView[] | undefined, query: string): ProjectGroup[] {
  return (projects ?? []).flatMap((project) => {
    const whole = matches(query, project.name, project.slug, project.goal);
    const threads = project.threads.filter((thread) => whole || matches(query, thread.id, thread.title));
    const coordinator = project.coordinator !== undefined && (whole || matches(query, "Coordinator"));
    if (!whole && !coordinator && threads.length === 0) return [];
    return [{ project, coordinator, open: threads.filter(isOpenThread), resolved: threads.filter((thread) => !isOpenThread(thread)) }];
  });
}
