// What a desk's Home draws besides the lists it shares with a phone: where a new chat starts, the
// chats to pick up under its composer, and the herd as a board by state. Kept free of React so the
// rules stay unit-testable; every figure is a reading of the snapshot, as home-stats' are.
import { deviceStore } from "./device-store";
import { projectName } from "./desk-projects";
import type { RecentChat } from "./home-stats";
import { byRecency } from "./recency";
import type { SpawnTarget } from "./spawn";
import type { AgentView } from "./types";

/** Home's lists: tabs on a phone, views of the header on a desk. */
export const SESSION_LISTS = [["recents", "Recents"], ["workspaces", "Workspaces"], ["prs", "PRs"]] as const;
export type SessionList = typeof SESSION_LISTS[number][0];

/** A desk's Home views: Start (the composer), the Board by state, then the lists. */
export const HOME_VIEWS = [["start", "Start"], ["board", "Board"], ...SESSION_LISTS] as const;
export type HomeView = typeof HOME_VIEWS[number][0];

const isView = (value: unknown): value is HomeView => HOME_VIEWS.some(([key]) => key === value);

/** The view this device last chose on a desk's Home; Start until one is chosen. */
export const useHomeView = deviceStore<HomeView>("nenu:home-view:v1", (raw) => {
  try {
    const value: unknown = JSON.parse(raw ?? "null");
    return isView(value) ? value : "start";
  } catch {
    return "start";
  }
}, (value) => value === "start", "start");

/** The view a link asked Home to open on (`state: { list }`, the desk's Pull requests), if it named one. */
export function viewAsked(state: unknown): HomeView | undefined {
  const asked = typeof state === "object" && state !== null ? (state as { list?: unknown }).list : undefined;
  return isView(asked) ? asked : undefined;
}

/** The list a link asked a phone's Home to open on, if it named one. */
export function listAsked(state: unknown): SessionList | undefined {
  const asked = viewAsked(state);
  return SESSION_LISTS.find(([key]) => key === asked)?.[0];
}

/** The ask taken out of a history entry's state, once kept, so a Back or a reload opens on the view last chosen. */
export const withoutAsk = (state: unknown): Record<string, unknown> =>
  Object.fromEntries(Object.entries(typeof state === "object" && state !== null ? state : {}).filter(([key]) => key !== "list"));

/** The Board's columns: what works, what finished a turn to look at, and what rests. Needs you is its own. */
export interface BoardColumns {
  working: RecentChat[];
  review: RecentChat[];
  resting: RecentChat[];
}

/** `chats` (Needs you's already left out) by state, each in the order given. */
export function boardColumns(chats: readonly RecentChat[]): BoardColumns {
  const columns: BoardColumns = { working: [], review: [], resting: [] };
  for (const chat of chats) {
    const status = chat.agent.kind === "shell" ? "idle" : chat.agent.status;
    (status === "working" ? columns.working : status === "done" ? columns.review : columns.resting).push(chat);
  }
  return columns;
}

/** How many chats Start offers to pick up under its composer. */
export const PICK_UP_ROWS = 3;

/** The chats to pick up: finished turns first, unseen ones before the rest, then whatever moved last. */
export function pickUp(chats: readonly RecentChat[], rows = PICK_UP_ROWS): RecentChat[] {
  const rank = (chat: RecentChat) => chat.agent.status === "done" ? (chat.unseen ? 0 : 1) : 2;
  // A stable sort keeps the recency order within each rank.
  return [...chats].filter((chat) => chat.agent.kind !== "shell").sort((a, b) => rank(a) - rank(b)).slice(0, rows);
}

/** Where Start's composer starts a chat: a folder and the project it reads as. */
export interface StartFolder {
  cwd: string;
  project: string;
}

/** `cwd` as a project: the name its panes go by, else the folder's own. */
export function folderOf(cwd: string, panes: readonly AgentView[]): StartFolder {
  const pane = panes.find((p) => p.cwd === cwd);
  return { cwd, project: pane ? projectName(pane) : cwd.split("/").filter(Boolean).pop() ?? "" };
}

/**
 * Where Start's composer starts until another folder is picked: the folder this device last started a
 * chat in (lib/spawn's remembered folders), else the folder the herd last moved in (agents before
 * shells); none for an empty herd. A start from this device comes first because the herd's last folder
 * is often another agent's worktree.
 */
export function defaultFolder(picked: readonly string[], agents: readonly AgentView[], shells: readonly AgentView[]): StartFolder | null {
  const panes = [...agents, ...shells];
  if (picked[0]) return folderOf(picked[0], panes);
  const pane = byRecency(agents).find((p) => p.cwd) ?? byRecency(shells).find((p) => p.cwd);
  return pane ? folderOf(pane.cwd, panes) : null;
}

/**
 * Where a chat started in `cwd` opens: a new tab of the workspace whose pane moved last in that folder,
 * so a project's chats stay together, else a workspace of its own on that folder.
 */
export function startTarget(cwd: string, panes: readonly AgentView[]): SpawnTarget {
  const here = byRecency(panes.filter((p) => p.cwd === cwd))[0];
  return here ? { kind: "tab", workspaceId: here.workspaceId } : { kind: "workspace" };
}
