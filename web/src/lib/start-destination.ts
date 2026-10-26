// Where a new chat opens: the choices Start's composer and the New flow share, and how each turns
// into a create (lib/spawn). Kept free of React so the rules stay unit-testable.
import { startTarget } from "./home-board";
import { byRecency } from "./recency";
import { tabName, workspaceName } from "./spaces";
import type { SpawnTarget } from "./spawn";
import type { AgentView, TabView, WorkspaceView } from "./types";

/** The workspace a quick chat opens in, created on the first one. */
export const SCRATCH = "scratch";

/**
 * - `folder`: by the chosen folder: a tab of the workspace already working there, else a workspace of
 *   its own (ADR 0131).
 * - `quick`: a tab of the `scratch` workspace on the home folder, made on the first one; closing the
 *   tab is all the cleanup it needs.
 * - `workspace`: a new workspace on the chosen folder.
 * - `tab`: a new tab of an existing workspace, in the chosen folder.
 * - `pane`: a new pane beside the panes of an existing tab, in the chosen folder.
 */
export type StartDestination =
  | { kind: "folder" }
  | { kind: "quick" }
  | { kind: "workspace" }
  | { kind: "tab"; workspaceId: string }
  | { kind: "pane"; tabId: string };

export const BY_FOLDER: StartDestination = { kind: "folder" };

/** What the destination menu lists: the live workspaces and tabs, Herdr's order. */
export interface Places {
  workspaces: readonly WorkspaceView[];
  tabs: readonly TabView[];
  agents: readonly AgentView[];
  shellPanes: readonly AgentView[];
}

/** Whether a destination's folder is the person's to choose: a quick chat always opens on the home folder. */
export const takesFolder = (destination: StartDestination) => destination.kind !== "quick";

/** The destination while it still exists; a workspace or tab closed since it was chosen falls back to the folder. */
export function liveDestination(destination: StartDestination, places: Places): StartDestination {
  if (destination.kind === "tab" && !places.workspaces.some((w) => w.workspaceId === destination.workspaceId)) return BY_FOLDER;
  if (destination.kind === "pane" && !places.tabs.some((t) => t.tabId === destination.tabId)) return BY_FOLDER;
  return destination;
}

/** The folder a destination suggests once chosen: where its last-moved pane works. None for the rest. */
export function destinationFolder(destination: StartDestination, places: Places): string | null {
  const panes = [...places.agents, ...places.shellPanes];
  const inside = destination.kind === "tab" ? panes.filter((p) => p.workspaceId === destination.workspaceId)
    : destination.kind === "pane" ? panes.filter((p) => p.tabId === destination.tabId)
    : [];
  return byRecency(inside).find((p) => p.cwd)?.cwd ?? null;
}

/** The create a destination makes for a chat in `cwd`: its target, the folder it sends and the name it gives. */
export function destinationTarget(destination: StartDestination, cwd: string, places: Places): { target: SpawnTarget; cwd: string; name: string } {
  switch (destination.kind) {
    case "folder": return { target: startTarget(cwd, [...places.agents, ...places.shellPanes]), cwd, name: "" };
    case "quick": {
      // No cwd: the bridge makes a workspace on the home folder and a tab inherits its workspace's,
      // and a quick chat must not become the folder this device last picked.
      const scratch = places.workspaces.find((w) => w.label.toLowerCase() === SCRATCH);
      return scratch ? { target: { kind: "tab", workspaceId: scratch.workspaceId }, cwd: "", name: "" } : { target: { kind: "workspace" }, cwd: "", name: SCRATCH };
    }
    case "workspace": return { target: { kind: "workspace" }, cwd, name: "" };
    case "tab": return { target: { kind: "tab", workspaceId: destination.workspaceId }, cwd, name: "" };
    case "pane": return { target: { kind: "pane", tabId: destination.tabId }, cwd, name: "" };
  }
}

/** A tab's name with its workspace's, as the destination menu and its chip show it. */
export function tabPlace(tab: TabView, places: Pick<Places, "workspaces" | "tabs">): string {
  const workspace = places.workspaces.find((w) => w.workspaceId === tab.workspaceId);
  const position = places.tabs.filter((t) => t.workspaceId === tab.workspaceId).indexOf(tab) + 1;
  const name = tabName(tab.label, position || tab.number);
  return workspace ? `${workspaceName(workspace)} › ${name}` : name;
}

/** How the chip names a destination. */
export function destinationLabel(destination: StartDestination, places: Pick<Places, "workspaces" | "tabs">): string {
  switch (destination.kind) {
    case "folder": return "By folder";
    case "quick": return "Quick chat";
    case "workspace": return "New workspace";
    case "tab": {
      const workspace = places.workspaces.find((w) => w.workspaceId === destination.workspaceId);
      return workspace ? `New tab in ${workspaceName(workspace)}` : "New tab";
    }
    case "pane": {
      const tab = places.tabs.find((t) => t.tabId === destination.tabId);
      return tab ? `Beside ${tabPlace(tab, places)}` : "New pane";
    }
  }
}

export const sameDestination = (a: StartDestination, b: StartDestination) => JSON.stringify(a) === JSON.stringify(b);
