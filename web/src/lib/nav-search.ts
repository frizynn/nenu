// What the navigation's search finds: the agents and workspaces whose own name matches, each
// called what every other view calls it (lib/display-name.ts), so the row you pick reads like the
// screen it opens; below them, the agents found by where they live, their folder, their terminal's
// title or their kind. Before this a search narrowed the tree to tab rows, and the name that matched
// was nowhere on screen.
import { displayName, displayPlace, type DisplayPlace } from "./display-name";
import { chatRecency } from "./recency";
import { workspaceName } from "./spaces";
import type { AgentView, WorkspaceView } from "./types";

/** How many rows a group shows before it only counts the rest. */
const SEARCH_LIMIT = 8;

interface HitBase {
  /** Unique across every group, for React keys and the option ids. */
  key: string;
  title: string;
  /** The line under the title: where it lives. */
  place: DisplayPlace;
}

export type SearchHit =
  | HitBase & { kind: "workspace"; workspace: WorkspaceView }
  | HitBase & { kind: "pane"; pane: AgentView };

export interface SearchGroup {
  label: "Workspaces" | "Chats";
  hits: SearchHit[];
  /** Matches past the limit, counted rather than listed. */
  more: number;
}

interface Ranked {
  hit: SearchHit;
  /** 0 a word of the title starts with the query, 1 the title holds it, 2 only something else about it does. */
  rank: number;
  at: number;
}

/** Where `query` (trimmed, any case) first occurs in `text`, as [start, end); null when it doesn't. */
export function matchRange(text: string, query: string): [number, number] | null {
  const needle = query.trim().toLocaleLowerCase();
  const hay = text.toLocaleLowerCase();
  // A letter whose lower case is longer would shift every index after it; such a title just goes unmarked.
  if (!needle || hay.length !== text.length) return null;
  const start = hay.indexOf(needle);
  return start < 0 ? null : [start, start + needle.length];
}

function rank(query: string, title: string, ...elsewhere: Array<string | null | undefined>): number | null {
  const range = matchRange(title, query);
  if (range) return range[0] === 0 || /\s/.test(title[range[0] - 1]!) ? 0 : 1;
  return elsewhere.some((field) => field && matchRange(field, query)) ? 2 : null;
}

/** An agent's kind (claude, codex) matches only as a whole word: "cla" is a name, not every Claude. */
const isKind = (kind: string, query: string) => kind !== "" && kind.toLocaleLowerCase() === query.trim().toLocaleLowerCase();

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * The search's groups, Workspaces then Chats, except that the group holding the closest name leads,
 * so the row Enter opens is the best match. Each group is ordered by how well the title matches, then
 * the latest to move. Chats holds every pane, shells included. A workspace is found by its own name
 * and opens the pane the sidebar's row would.
 */
export function navSearch(source: {
  agents: readonly AgentView[];
  shellPanes?: readonly AgentView[];
  workspaces?: readonly WorkspaceView[];
}, query: string, { limit = SEARCH_LIMIT, order }: {
  limit?: number;
  /** Where each hit sat when this query was first answered: a poll that moves an agent leaves it there. */
  order?: ReadonlyMap<string, number>;
} = {}): SearchGroup[] {
  if (!query.trim()) return [];
  const panes = [...source.agents, ...(source.shellPanes ?? [])];
  const containers: Ranked[] = [];
  const loose: Ranked[] = [];

  for (const workspace of source.workspaces ?? []) {
    const title = workspaceName(workspace);
    const workspaceRank = rank(query, title);
    if (workspaceRank === null) continue;
    const inside = panes.filter((pane) => pane.workspaceId === workspace.workspaceId);
    const chats = inside.filter((pane) => pane.kind !== "shell").length;
    containers.push({ hit: { kind: "workspace", key: `workspace:${workspace.workspaceId}`, workspace, title, place: { place: chats ? plural(chats, "chat") : plural(workspace.tabCount, "tab"), tab: null } },
      rank: workspaceRank, at: Math.max(0, ...inside.map((pane) => pane.lastActiveAt ?? 0)) });
  }

  for (const pane of panes) {
    const title = displayName(pane);
    const place = displayPlace(pane);
    const paneRank = rank(query, title, place.place, place.tab, pane.cwd, pane.terminalTitle) ?? (isKind(pane.agent, query) ? 2 : null);
    if (paneRank === null) continue;
    loose.push({ hit: { kind: "pane", key: `pane:${pane.paneId}`, pane, title, place }, rank: paneRank, at: chatRecency(pane) });
  }

  const sat = (item: Ranked) => order?.get(item.hit.key) ?? Number.MAX_SAFE_INTEGER;
  const byMatch = (a: Ranked, b: Ranked) => sat(a) - sat(b) || a.rank - b.rank || b.at - a.at;
  const groups = ([["Workspaces", containers], ["Chats", loose]] as const)
    .filter(([, list]) => list.length > 0)
    .map(([label, list]) => ({ label, list: [...list].sort(byMatch), best: Math.min(...list.map((item) => item.rank)) }));
  // A stable sort: groups as close keep the sidebar's order.
  return groups.sort((a, b) => a.best - b.best).map(({ label, list }) => ({
    label, hits: list.slice(0, limit).map((item) => item.hit), more: Math.max(0, list.length - limit),
  }));
}
