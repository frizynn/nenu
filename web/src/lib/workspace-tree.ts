import { matches } from "@/lib/projects";
import { groupPanesByTab, spaceLastSeenMap } from "@/lib/spaces";
import { paneDisplayName, type AgentView, type TabView, type WorkspaceView } from "@/lib/types";

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

export interface TreeSource {
  workspaces: readonly WorkspaceView[];
  tabs: readonly TabView[];
  agents: readonly AgentView[];
  shellPanes?: readonly AgentView[];
}

/**
 * Workspace → tab → pane, narrowed to a search. The workspace on screen leads, then the rest by
 * last activity. A query matching a workspace or tab name keeps all of it; otherwise only the panes
 * that match survive, and a workspace left with nothing is dropped.
 */
export function workspaceTree(source: TreeSource, query = "", currentPaneId?: string): WorkspaceBranch[] {
  const shells = source.shellPanes ?? [];
  const all = [...source.agents, ...shells];
  const lastSeen = spaceLastSeenMap(all);
  const currentWorkspace = all.find((pane) => pane.paneId === currentPaneId)?.workspaceId;

  return source.workspaces
    .map((workspace): WorkspaceBranch => {
      const name = workspace.label || `Workspace ${workspace.number}`;
      const wholeWorkspace = matches(query, name);
      const tabs = groupPanesByTab(workspace.workspaceId, [...source.tabs], [...source.agents], [...shells])
        .map((group, index): TabBranch => {
          const label = group.label === "…" ? "Other panes" : group.label || `Tab ${index + 1}`;
          const wholeTab = wholeWorkspace || matches(query, label);
          return { tabId: group.tabId, label, panes: wholeTab ? group.panes : group.panes.filter((pane) => paneMatches(pane, query)) };
        })
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
    .filter((branch) => branch.tabs.length > 0 || (!query.trim() && branch.counts.agents === 0))
    .sort((a, b) => Number(b.current) - Number(a.current)
      || (lastSeen.get(b.workspace.workspaceId) ?? 0) - (lastSeen.get(a.workspace.workspaceId) ?? 0)
      || a.workspace.number - b.workspace.number);
}

/** What a pane is about: its own name, else the session title, else the agent; never the tab label again. */
export function paneSubject(pane: AgentView): string {
  return pane.paneLabel || pane.sessionName || pane.terminalTitle || paneDisplayName(pane);
}

function paneMatches(pane: AgentView, query: string): boolean {
  return matches(query, paneSubject(pane), pane.agent, pane.cwd);
}

/** An untouched workspace opens when it holds the pane on screen, something that needs you, or is the only one. */
export function defaultOpen(branch: WorkspaceBranch, workspaces: number): boolean {
  return branch.current || branch.counts.blocked > 0 || workspaces === 1;
}
