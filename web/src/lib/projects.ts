// Pure view-model helpers for the project hub: what a project's status reads as, which project a
// pane belongs to, and how chats are grouped by recency. Kept free of React so the sidebar, the
// home list and the project panel share one definition and the rules stay unit-testable.
import { paneParts } from "./pane-name";
import type { AgentView, ProjectThreadView, ProjectView } from "./types";
import { paneDisplayName } from "./types";

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

/** What a pane is called and where it lives: its project, else its workspace and tab. */
export interface PaneIdentity {
  title: string;
  place: string;
  /** The tab, outside a project and only when its label says something. */
  tab: string | null;
}

export function paneIdentity(pane: AgentView, projects: readonly ProjectView[] | undefined): PaneIdentity {
  const owner = projectForPane(projects, pane.paneId);
  const parts = paneParts(pane);
  return { title: paneTitle(pane, owner), place: owner?.project.name ?? parts.project, tab: owner ? null : parts.tab };
}

export interface JumpTarget {
  kind: "project" | "chat";
  /** Project slug or pane id. */
  id: string;
  /** Last movement, epoch ms; 0 when unknown. */
  ts: number;
}

/** A project moves when its coordinator or any of its task panes does, or a task file is updated. */
function projectRecency(project: ProjectView, byPane: ReadonlyMap<string, AgentView>): number {
  const panes = [project.coordinator?.paneId, ...project.threads.map((thread) => thread.paneId)];
  const paneTimes = panes.map((id) => (id && byPane.get(id) ? chatRecency(byPane.get(id)!) : 0));
  const updates = project.threads.map((thread) => Date.parse(thread.updated ?? "") || 0);
  return Math.max(0, ...paneTimes, ...updates);
}

/**
 * Where a search jumps, most recently moved first: projects and the chats outside them (a project's
 * own panes are reached through the project), filtered with the sidebar's matchers.
 */
export function jumpTargets(agents: readonly AgentView[], projects: readonly ProjectView[] | undefined, query = ""): JumpTarget[] {
  const byPane = new Map(agents.map((agent) => [agent.paneId, agent]));
  const projectTargets = (projects ?? [])
    .filter((project) => projectMatches(project, query))
    .map((project): JumpTarget => ({ kind: "project", id: project.slug, ts: projectRecency(project, byPane) }));
  const chatTargets = looseChats(agents, projects)
    .filter((pane) => chatMatches(pane, query))
    .map((pane): JumpTarget => ({ kind: "chat", id: pane.paneId, ts: chatRecency(pane) }));
  // Stable sort: equal (or unknown) times keep projects first, then the bridge's own pane order.
  return [...projectTargets, ...chatTargets].sort((a, b) => b.ts - a.ts);
}

/** A project's rows in the sidebar's Projects view, narrowed to a search. */
export interface ProjectGroup {
  project: ProjectView;
  coordinator: boolean;
  /** The threads the search keeps, open and resolved; the sidebar draws them as one org tree. */
  threads: ProjectThreadView[];
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
    return [{ project, coordinator, threads }];
  });
}
