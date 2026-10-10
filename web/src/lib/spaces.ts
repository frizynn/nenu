// Helpers for workspaces and their tabs: shape the flat snapshot (agents + shell panes + tabs) into
// the per-workspace, per-tab tree the workspace page and the sidebar draw, and name what they show.
import type { AgentView, TabView, WorkspaceView } from "./types";

export interface TabGroup {
  tabId: string;
  label: string;
  panes: AgentView[];
}

/**
 * Group a workspace's panes (agents + shells) by tab, in tab order. Panes whose tab isn't in the
 * tab list yet (a brief poll race after a create) fall into a trailing "Other panes" group so
 * they're never lost.
 */
export function groupPanesByTab(
  workspaceId: string,
  tabs: TabView[],
  agents: AgentView[],
  shellPanes: AgentView[],
): TabGroup[] {
  const panes = [...agents, ...shellPanes].filter((p) => p.workspaceId === workspaceId);
  const wsTabs = tabs.filter((t) => t.workspaceId === workspaceId);

  const groups: TabGroup[] = wsTabs.map((t) => ({
    tabId: t.tabId,
    label: t.label,
    panes: panes.filter((p) => p.tabId === t.tabId),
  }));

  const known = new Set(wsTabs.map((t) => t.tabId));
  const orphans = panes.filter((p) => !known.has(p.tabId));
  if (orphans.length) groups.push({ tabId: `${workspaceId}:other`, label: "Other panes", panes: orphans });

  return groups;
}

/** A workspace's name, or its number when Herdr has none for it. */
export function workspaceName(workspace: Pick<WorkspaceView, "label" | "number">): string {
  return workspace.label || `Workspace ${workspace.number}`;
}

/** The pane a workspace is when it holds exactly one, which its page opens straight onto. */
export function soloPane(
  workspaceId: string,
  agents: readonly AgentView[],
  shellPanes: readonly AgentView[],
): AgentView | undefined {
  const panes = [...agents, ...shellPanes].filter((p) => p.workspaceId === workspaceId);
  return panes.length === 1 ? panes[0] : undefined;
}

/**
 * A tab's name as Nenu shows it, `position` counting from 1. Herdr names an unlabelled tab by its
 * position, and a bare "1" reads as a count.
 */
export function tabName(label: string, position: number): string {
  const trimmed = label.trim();
  if (!trimmed) return `Tab ${position}`;
  return /^\d+$/.test(trimmed) ? `Tab ${trimmed}` : trimmed;
}

/** The tab a workspace page shows: the one asked for, else the one Herdr has active, else the first. */
export function shownTab(groups: readonly TabGroup[], asked: string | null, active: string): TabGroup | undefined {
  return groups.find((g) => g.tabId === asked) ?? groups.find((g) => g.tabId === active) ?? groups[0];
}

/** The folder a workspace works in: the directory most of its panes sit in, the first such on a tie. */
export function workspaceFolder(panes: readonly AgentView[]): string | undefined {
  const counts = new Map<string, number>();
  for (const p of panes) if (p.cwd) counts.set(p.cwd, (counts.get(p.cwd) ?? 0) + 1);
  let folder: string | undefined;
  let most = 0;
  for (const [cwd, n] of counts) {
    if (n > most) [folder, most] = [cwd, n];
  }
  return folder;
}

/** The pane Nenu opens for a tab: its first agent, else its first shell. */
export function paneInTab(
  tabId: string,
  agents: readonly AgentView[],
  shellPanes: readonly AgentView[],
): AgentView | undefined {
  return agents.find((p) => p.tabId === tabId) ?? shellPanes.find((p) => p.tabId === tabId);
}

/**
 * The tab that takes a closed tab's place, as in Herdr or a browser: the one to its left, else the
 * one to its right, within its workspace and in snapshot order. `alive` skips tabs that closed with
 * it. Undefined when its workspace has no other tab.
 */
export function neighborTab(
  tabs: readonly TabView[],
  tabId: string,
  alive: (tabId: string) => boolean = () => true,
): string | undefined {
  const closed = tabs.find((t) => t.tabId === tabId);
  if (!closed) return undefined;
  const order = tabs.filter((t) => t.workspaceId === closed.workspaceId && (t === closed || alive(t.tabId)));
  const i = order.indexOf(closed);
  return (order[i - 1] ?? order[i + 1])?.tabId;
}

/**
 * Where to go when the open pane closes: another pane in its tab, else one in the tab that takes
 * its tab's place. `before` is the tab list of the last snapshot that listed the pane, `now` the
 * snapshot without it. Undefined when its workspace has nothing left.
 */
export function paneAfterClose(
  closed: Pick<AgentView, "tabId">,
  before: readonly TabView[],
  now: { tabs: readonly TabView[]; agents: readonly AgentView[]; shellPanes: readonly AgentView[] },
): string | undefined {
  const alive = new Set(now.tabs.map((t) => t.tabId));
  const tabId = alive.has(closed.tabId) ? closed.tabId : neighborTab(before, closed.tabId, (id) => alive.has(id));
  return tabId === undefined ? undefined : paneInTab(tabId, now.agents, now.shellPanes)?.paneId;
}

/**
 * Last-used time for EVERY space in one pass over the panes. The dashboard needs this per space and
 * again per rendered row, and it re-renders on every poll; deriving it per space would be
 * spaces × panes each time (45 × 59 on a real herd, three times over). One pass, then map lookups.
 */
export function spaceLastSeenMap(panes: readonly AgentView[]): Map<string, number> {
  const seen = new Map<string, number>();
  for (const p of panes) {
    const at = p.lastSeenAt ?? 0;
    if (at > (seen.get(p.workspaceId) ?? 0)) seen.set(p.workspaceId, at);
  }
  return seen;
}
