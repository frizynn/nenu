// Helpers for workspaces and their tabs: shape the flat snapshot (agents + shell panes + tabs) into
// the per-workspace, per-tab tree the sidebar draws, name what it shows, and pick the pane a
// workspace opens on.
import { TITLE_SEP } from "./pane-name";
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
  tabs: readonly TabView[],
  agents: readonly AgentView[],
  shellPanes: readonly AgentView[],
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

/** A workspace's name, or its number when Herdr has none for it; then its machine, on a list that names one. */
export function workspaceName(workspace: Pick<WorkspaceView, "label" | "number" | "machine">): string {
  const name = workspace.label || `Workspace ${workspace.number}`;
  return workspace.machine ? `${name}${TITLE_SEP}${workspace.machine}` : name;
}

/** What {@link workspaceEntry} reads from the snapshot. */
export interface Herd {
  workspaces: readonly WorkspaceView[];
  tabs: readonly TabView[];
  agents: readonly AgentView[];
  shellPanes?: readonly AgentView[];
}

/**
 * The pane a workspace opens on, the same from every place that opens one: the agent asking for you
 * (the latest to ask), else the pane you had open last, else the pane the tab Herdr shows opens on
 * (paneInTab), else its first pane. Undefined for a workspace with no pane.
 */
export function workspaceEntry(workspaceId: string, herd: Herd): AgentView | undefined {
  const shellPanes = herd.shellPanes ?? [];
  // The pane with the highest stamp; the first in snapshot order on a tie.
  const latest = (panes: AgentView[], at: (pane: AgentView) => number) =>
    panes.reduce<AgentView | undefined>((best, pane) => (!best || at(pane) > at(best) ? pane : best), undefined);
  const asking = herd.agents.filter((pane) => pane.workspaceId === workspaceId && pane.status === "blocked");
  const seen = [...herd.agents, ...shellPanes].filter((pane) => pane.workspaceId === workspaceId && (pane.lastSeenAt ?? 0) > 0);
  const active = herd.workspaces.find((workspace) => workspace.workspaceId === workspaceId)?.activeTabId;
  return latest(asking, (pane) => pane.lastActiveAt ?? 0)
    ?? latest(seen, (pane) => pane.lastSeenAt ?? 0)
    ?? (active ? paneInTab(active, herd.agents, shellPanes) : undefined)
    ?? groupPanesByTab(workspaceId, herd.tabs, herd.agents, shellPanes).find((group) => group.panes.length > 0)?.panes[0];
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
