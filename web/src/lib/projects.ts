// Pure view-model helpers for the project hub: what a project's status reads as, which project a
// pane belongs to, and how chats are grouped by recency. Kept free of React so the sidebar, the
// home list and the project panel share one definition and the rules stay unit-testable.
import { organizes, orgTree } from "./org-tree";
import type { AgentView, ProjectThreadView, ProjectView } from "./types";

export const isOpenThread = (thread: ProjectThreadView) => thread.status !== "resolved";

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

/**
 * The project coordinator while an agent runs in its pane. Organizations records the pane before its
 * agent runs, and keeps it once the agent quits back to the shell: a pane with no agent in it is no
 * running coordinator.
 */
export function runningCoordinator(project: ProjectView): ProjectView["coordinator"] {
  return project.coordinator && project.coordinator.agent !== "shell" ? project.coordinator : undefined;
}

/** The coordinator's pane while it runs: a project then opens on that conversation instead of its organization. */
export function liveCoordinator(project: ProjectView | undefined, panes: readonly AgentView[]): string | undefined {
  const paneId = project?.coordinator?.paneId;
  return paneId && panes.some((pane) => pane.paneId === paneId) ? paneId : undefined;
}

/**
 * The live pane of one of a project's coordinators, `root` being the project's own: a tap on a
 * coordinator enters this chat, and only a coordinator without one opens its page (ADR 0113).
 */
export function coordinatorPane(project: ProjectView, id: string, panes: readonly AgentView[]): string | undefined {
  const paneId = id === "root" ? runningCoordinator(project)?.paneId : project.threads.find((thread) => thread.id === id && thread.role === "coordinator")?.paneId;
  return paneId && panes.some((pane) => pane.paneId === paneId) ? paneId : undefined;
}

/**
 * The chat a project's page opens on: its own coordinator's while it runs, unless the project organizes
 * coordinators and is their page (ADR 0092). Whatever goes up to the project lands there.
 */
export function projectChat(project: ProjectView | undefined, panes: readonly AgentView[]): string | undefined {
  return project && !organizes(orgTree(project.threads)) ? liveCoordinator(project, panes) : undefined;
}

/** Chats are the agent panes outside any project; a project's panes live in its task list. */
export function looseChats(panes: readonly AgentView[], projects: readonly ProjectView[] | undefined): AgentView[] {
  return panes.filter((pane) => !projectForPane(projects, pane.paneId));
}

export type RecencyKey = "today" | "yesterday" | "week" | "month" | "older";
/** Each period names only what it holds: Previous 7 days starts the day before yesterday. */
export const RECENCY_LABEL: Record<RecencyKey, string> = { today: "Today", yesterday: "Yesterday", week: "Previous 7 days", month: "Previous 30 days", older: "Older" };

/** Last time the chat moved or was opened; 0 when an older bridge reports neither. */
export function chatRecency(pane: AgentView): number {
  return Math.max(pane.lastActiveAt ?? 0, pane.lastSeenAt ?? 0);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function recencyOf(ts: number, now: number): RecencyKey {
  if (!ts) return "older";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (ts >= startOfToday.getTime()) return "today";
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (ts >= startOfYesterday.getTime()) return "yesterday";
  if (now - ts < 7 * DAY_MS) return "week";
  return now - ts < 30 * DAY_MS ? "month" : "older";
}

export interface RecencyGroup<T> {
  key: RecencyKey;
  label: string;
  items: T[];
}

export function byRecency(panes: readonly AgentView[]): AgentView[] {
  return [...panes].sort((a, b) => chatRecency(b) - chatRecency(a));
}

/** Newest first, under the periods that hold something, in display order: a heading never stands alone. */
export function groupByRecency<T>(items: readonly T[], at: (item: T) => number, now: number): RecencyGroup<T>[] {
  const sorted = [...items].sort((a, b) => at(b) - at(a));
  return (Object.keys(RECENCY_LABEL) as RecencyKey[])
    .map((key) => ({ key, label: RECENCY_LABEL[key], items: sorted.filter((item) => recencyOf(at(item), now) === key) }))
    .filter((group) => group.items.length > 0);
}
