// What the desk's sidebar lists, drawn the way Cursor's agent window draws its own: projects as one
// flat row each, and every conversation in a project or outside one as a chat, dated by when it last
// moved. Kept free of React so the rows' rules stay unit-testable.
import { displayName } from "./display-name";
import { flatten, openCoordinators, orgTree, type NodeState } from "./org-tree";
import { chatRecency, isOpenThread, looseChats, projectForPane } from "./projects";
import type { AgentStatus, AgentView, ProjectThreadView, ProjectView } from "./types";

export interface DeskChat {
  key: string;
  title: string;
  /** The live pane it opens; undefined for a thread that runs nowhere, which opens its node page. */
  paneId?: string;
  /** The project that holds it, with the thread it runs; neither for a chat outside every project. */
  project?: string;
  thread?: ProjectThreadView;
  pane?: AgentView;
  /** When it last moved, epoch ms; 0 when nothing says. */
  at: number;
  /** It finished or asked for you since it was last opened in Nenu: the row's +1, in place of a toast. */
  unread: boolean;
}

const updatedAt = (thread: ProjectThreadView) => Date.parse(thread.updated ?? "") || 0;

/** `done` already means not yet seen in Nenu (ADR 0071); an ask is new until the chat is opened after it. */
const unread = (pane: AgentView | undefined) =>
  (pane?.status === "done" || pane?.status === "blocked") && (pane.lastActiveAt ?? 0) > (pane.lastSeenAt ?? 0);

/**
 * Every open thread of every project and every agent pane outside them. A project's own coordinator
 * is the project's row, so it is no chat; resolved threads stay in the project's History.
 */
export function deskChats(data: { agents: readonly AgentView[]; projects?: readonly ProjectView[] }): DeskChat[] {
  const panes = new Map(data.agents.map((pane) => [pane.paneId, pane]));
  const threads = (data.projects ?? []).flatMap((project) => project.threads.filter(isOpenThread).map((thread): DeskChat => {
    const pane = thread.paneId ? panes.get(thread.paneId) : undefined;
    return {
      key: `${project.slug}/${thread.id}`, title: thread.title, paneId: pane?.paneId, project: project.slug, thread, pane,
      at: Math.max(updatedAt(thread), pane ? chatRecency(pane) : 0), unread: unread(pane),
    };
  }));
  const loose = looseChats(data.agents, data.projects).map((pane): DeskChat => ({
    key: pane.paneId, title: displayName(pane, data.projects), paneId: pane.paneId, pane, at: chatRecency(pane), unread: unread(pane),
  }));
  return [...threads, ...loose];
}

/** The agents a project holds: its coordinator, its threads' panes, and any pane in its workspaces. */
export function projectAgents(project: ProjectView, agents: readonly AgentView[], projects: readonly ProjectView[] | undefined): AgentView[] {
  const held = new Set(project.workspaceIds ?? []);
  return agents.filter((pane) => held.has(pane.workspaceId) || projectForPane(projects, pane.paneId)?.project.slug === project.slug);
}

/** When anything in the project last moved: a thread's update, resolved ones included, or its coordinator's pane. */
export function projectActivity(project: ProjectView, agents: readonly AgentView[]): number {
  const coordinator = agents.find((pane) => pane.paneId === project.coordinator?.paneId);
  return Math.max(0, ...project.threads.map(updatedAt), coordinator ? chatRecency(coordinator) : 0);
}

/** A project at a glance: what waits on you there, what works, what is ready to review, how much is open and when it last moved. */
export interface ProjectPulse {
  waiting: number;
  working: number;
  review: number;
  coordinators: number;
  threads: number;
  /** Open coordinators and threads together. */
  open: number;
  /** `waiting` is Organizations' asks count; false when it lists none and the tree's waiting nodes stand in. */
  asks: boolean;
  at: number;
}

/**
 * What waits on you is Organizations' own asks count when it has one, else the tree's nodes that need
 * you; what is ready to review is the tree's. Working counts the project's agents at work, the unit
 * Home's headline counts, never threads whose last group said working.
 */
export function projectPulse(project: ProjectView, agents: readonly AgentView[], projects: readonly ProjectView[] | undefined): ProjectPulse {
  const tree = orgTree(project.threads);
  const open = flatten(tree.open);
  const coordinators = openCoordinators(tree).length;
  const count = (state: NodeState) => open.filter((node) => node.state === state).length;
  return {
    waiting: project.waitingAsks ?? count("needs"), review: count("review"),
    working: projectAgents(project, agents, projects).filter((pane) => pane.status === "working").length,
    coordinators, threads: open.length - coordinators, open: open.length, asks: project.waitingAsks !== undefined, at: projectActivity(project, agents),
  };
}

/** The most pressing state among `panes`, for a project's dot. Resting agents draw none. */
export function liveliest(panes: readonly AgentView[]): AgentStatus | undefined {
  return (["blocked", "working", "done"] as const).find((status) => panes.some((pane) => pane.status === status));
}
