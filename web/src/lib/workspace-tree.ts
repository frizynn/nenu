import { groupPanesByTab, tabName, workspaceName, type Herd } from "@/lib/spaces";
import type { AgentView, WorkspaceView } from "@/lib/types";

/** A tab in the navigation tree; `panes` is never empty. */
export interface TabBranch {
  tabId: string;
  label: string;
  panes: AgentView[];
}

/** A Herdr workspace with the tabs that hold a pane, as the navigation shows it. */
export interface WorkspaceBranch {
  workspace: WorkspaceView;
  name: string;
  tabs: TabBranch[];
  counts: { agents: number; blocked: number; working: number; done: number };
  /** Holds the pane on screen. */
  current: boolean;
}

/**
 * Workspace → tab → pane, the one whose agent moved last first and Herdr's order between the rest.
 * Opening a pane never moves its workspace: the row you reach for stays put, and the workspace on
 * screen is marked, not pinned.
 */
export function workspaceTree(source: Herd, currentPaneId?: string): WorkspaceBranch[] {
  const shells = source.shellPanes ?? [];
  const all = [...source.agents, ...shells];
  const moved = new Map<string, number>();
  for (const pane of all) moved.set(pane.workspaceId, Math.max(moved.get(pane.workspaceId) ?? 0, pane.lastActiveAt ?? 0));
  const currentWorkspace = all.find((pane) => pane.paneId === currentPaneId)?.workspaceId;

  return source.workspaces
    .map((workspace): WorkspaceBranch => {
      const name = workspaceName(workspace);
      const tabs = groupPanesByTab(workspace.workspaceId, source.tabs, source.agents, shells)
        .map((group, index): TabBranch => ({ tabId: group.tabId, label: tabName(group.label, index + 1), panes: group.panes }))
        .filter((tab) => tab.panes.length > 0);
      const agents = source.agents.filter((pane) => pane.workspaceId === workspace.workspaceId);
      return {
        workspace, name, tabs,
        counts: {
          agents: agents.length,
          blocked: agents.filter((pane) => pane.status === "blocked").length,
          working: agents.filter((pane) => pane.status === "working").length,
          done: agents.filter((pane) => pane.status === "done").length,
        },
        current: workspace.workspaceId === currentWorkspace,
      };
    })
    .filter((branch) => branch.tabs.length > 0 || branch.counts.agents === 0)
    .sort((a, b) => (moved.get(b.workspace.workspaceId) ?? 0) - (moved.get(a.workspace.workspaceId) ?? 0)
      || a.workspace.number - b.workspace.number);
}

/**
 * A workspace of one tab, split or not, has nothing to unfold: its row opens that tab, whose panes are
 * the strip above its chat (ADR 0065).
 */
export function opensDirectly(branch: Pick<WorkspaceBranch, "tabs">): boolean {
  return branch.tabs.length === 1;
}

/** An untouched workspace opens when it holds the pane on screen, something that needs you, or is the only one. */
export function defaultOpen(branch: WorkspaceBranch, workspaces: number): boolean {
  return branch.current || branch.counts.blocked > 0 || workspaces === 1;
}
