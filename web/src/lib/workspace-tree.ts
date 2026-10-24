import { groupPanesByTab, tabName, workspaceName, type Herd } from "@/lib/spaces";
import type { AgentView, WorkspaceView } from "@/lib/types";

/** How many agents a workspace or a tab holds, and how many of them need you, work or finished; shells are not agents. */
export interface AgentCounts {
  agents: number;
  blocked: number;
  working: number;
  done: number;
}

/** A tab in the navigation tree; `panes` is never empty. */
export interface TabBranch {
  tabId: string;
  label: string;
  panes: AgentView[];
  counts: AgentCounts;
}

/** A Herdr workspace with the tabs that hold a pane, as the navigation shows it. */
export interface WorkspaceBranch {
  workspace: WorkspaceView;
  name: string;
  tabs: TabBranch[];
  counts: AgentCounts;
  /** Holds the pane on screen. */
  current: boolean;
}

function agentCounts(panes: readonly AgentView[]): AgentCounts {
  const agents = panes.filter((pane) => pane.kind !== "shell");
  return {
    agents: agents.length,
    blocked: agents.filter((pane) => pane.status === "blocked").length,
    working: agents.filter((pane) => pane.status === "working").length,
    done: agents.filter((pane) => pane.status === "done").length,
  };
}

/**
 * Workspace → tab → pane, in Herdr's order (`number` is the position: workspace.move renumbers). A
 * workspace never moves for what its agents do or for being opened: the row you reach for stays put,
 * and the workspace on screen is marked, not pinned. The operator's own order is applied over this
 * (lib/workspace-order.ts, ADR 0124).
 */
export function workspaceTree(source: Herd, currentPaneId?: string): WorkspaceBranch[] {
  const shells = source.shellPanes ?? [];
  const currentWorkspace = [...source.agents, ...shells].find((pane) => pane.paneId === currentPaneId)?.workspaceId;

  return source.workspaces
    .map((workspace): WorkspaceBranch => {
      const name = workspaceName(workspace);
      const tabs = groupPanesByTab(workspace.workspaceId, source.tabs, source.agents, shells)
        .map((group, index): TabBranch => ({ tabId: group.tabId, label: tabName(group.label, index + 1), panes: group.panes, counts: agentCounts(group.panes) }))
        .filter((tab) => tab.panes.length > 0);
      return {
        workspace, name, tabs,
        counts: agentCounts(source.agents.filter((pane) => pane.workspaceId === workspace.workspaceId)),
        current: workspace.workspaceId === currentWorkspace,
      };
    })
    .filter((branch) => branch.tabs.length > 0 || branch.counts.agents === 0)
    .sort((a, b) => a.workspace.number - b.workspace.number);
}

/**
 * A workspace of one tab, split or not, or of one session, has nothing to unfold: its row opens it,
 * and the tabs and panes are the strips above its chat (ADR 0065). Tabs of shells alone don't count.
 */
export function opensDirectly(branch: Pick<WorkspaceBranch, "tabs" | "counts">): boolean {
  return branch.tabs.length === 1 || branch.counts.agents === 1;
}

/** An untouched workspace opens when it holds the pane on screen, something that needs you, or is the only one. */
export function defaultOpen(branch: WorkspaceBranch, workspaces: number): boolean {
  return branch.current || branch.counts.blocked > 0 || workspaces === 1;
}

/**
 * How an unfolded workspace lists a tab of `panes` among its `tabs`: two or more panes beside another
 * tab make the tab a row of its own that folds them, one level in; otherwise each pane is its own row.
 * Listed flat, a split tab's panes read as siblings of the other tabs, which the operator asked to
 * stop. Home's Workspaces, the drawer and Search all list tabs by this.
 */
export function tabFolds(panes: number, tabs: number): boolean {
  return panes > 1 && tabs > 1;
}

/** An untouched tab that folds starts open when it holds the pane on screen or an agent that needs you. */
export function tabStartsOpen(panes: readonly Pick<AgentView, "paneId" | "status">[], currentPaneId?: string): boolean {
  return panes.some((pane) => pane.paneId === currentPaneId || pane.status === "blocked");
}
