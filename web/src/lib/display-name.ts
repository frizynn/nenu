// What an agent is CALLED, and where it lives, in every view that names one: sidebar rows, headers,
// Recent, Needs you, chips, pills and the switcher. Before this each view picked its own field (the
// tab label in the sidebar, the pane label in the header, the thread title on a chip), so the row you
// tapped and the screen that opened disagreed about who you were talking to.
import { workspaceName } from "./spaces";
import { paneDisplayName, type AgentView } from "./types";

/** Where an agent lives, unjoined. Render `place`, then TITLE_SEP (lib/pane-name.ts) and `tab` as
 *  separate spans, so a narrow row gives up the place first and keeps the tab that tells rows apart. */
export interface DisplayPlace {
  place: string;
  /** The tab, only when its label says something. */
  tab: string | null;
}

/**
 * The agent's one name: the pane's own name (label, then Claude's /rename, then the terminal title,
 * then the agent). Render as text only, never markup: every field here comes from the herd.
 */
export function displayName(pane: AgentView): string {
  return paneDisplayName(pane);
}

/** The line under the name: its workspace and tab (the tab only when its label says something). */
export function displayPlace(pane: AgentView): DisplayPlace {
  return { place: workspaceName({ label: pane.workspaceLabel, number: pane.workspaceNumber }), tab: pane.tabLabel || null };
}
