// What Home says about the herd, derived from the snapshot and the bridge's detected dialogs. Every
// figure is a reading of the present, never a reconstructed series.
import type { ActivityResponse, ActivityWorkflow } from "./activity";
import { displayName, displayPlace, type DisplayPlace } from "./display-name";
import { byRecency, chatRecency } from "./recency";
import { isUnseen } from "./triage";
import type { AgentView, PullRequestView } from "./types";
import { opensDirectly, workspaceTree } from "./workspace-tree";
import { workspaceEntry, type Herd } from "./spaces";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface HomeCounts {
  /** Panes with a dialog waiting, or blocked without one the bridge could read. */
  needs: number;
  /** Pull requests waiting to be looked at. */
  review: number;
  working: number;
}

/** Home's headline: what needs you, said with its noun, and the rest on a line under it. */
export interface HomeHeadline {
  title: string;
  /** The other facts, " · "-joined; null when there are none. */
  detail: string | null;
}

/** "1 needs you", "2 need you": the headline's words, and what Home's icon says it counts. */
export const needYou = (n: number) => `${n} ${n === 1 ? "needs" : "need"} you`;

/**
 * The headline never names the pull requests; they are a line under it. "Nothing needs you" only
 * once `calm` vouches for it (a live herd whose dialogs were read); until then it says what the herd
 * is doing.
 */
export function homeHeadline(counts: HomeCounts, total: number, calm: boolean): HomeHeadline {
  const { needs, review, working } = counts;
  const rest = (...parts: Array<string | false>) => parts.filter(Boolean).join(" · ") || null;
  // Only live work: an idle agent waits on nobody, so the line leaves it out.
  const reviewing = review > 0 && `${review} open ${review === 1 ? "PR" : "PRs"}`;
  if (needs) return { title: needYou(needs), detail: rest(reviewing, working > 0 && `${working} working`) };
  if (!total) return { title: "What should we work on?", detail: null };
  if (calm) return { title: "Nothing needs you", detail: rest(reviewing, working > 0 && `${working} working`) };
  if (working) return { title: `${plural(working, "agent")} at work`, detail: rest(reviewing) };
  return { title: "All quiet", detail: rest(reviewing) };
}

export function greeting(now: number): string {
  const hour = new Date(now).getHours();
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** A pane Home asks you about: its detected dialog, none when it is blocked on something unread. */
export interface NeedsYouItem<I> {
  paneId: string;
  interaction?: I;
}

/**
 * What needs you, oldest first: every detected dialog, then blocked panes the bridge read no dialog
 * on (still yours to look at, in the thread).
 */
export function needsYouItems<I extends { paneId: string; detectedAt: number }>(agents: readonly AgentView[], interactions: readonly I[]): NeedsYouItem<I>[] {
  const asked = [...interactions].sort((a, b) => a.detectedAt - b.detectedAt);
  const covered = new Set(asked.map((i) => i.paneId));
  const blocked = agents.filter((agent) => agent.status === "blocked" && !covered.has(agent.paneId))
    .sort((a, b) => (a.lastActiveAt ?? 0) - (b.lastActiveAt ?? 0));
  return [
    ...asked.map((interaction) => ({ paneId: interaction.paneId, interaction })),
    ...blocked.map((agent) => ({ paneId: agent.paneId })),
  ];
}

/**
 * How many need you by the snapshot alone: blocked panes. Home's icon shows it; Home's headline
 * counts the same set and adds the dialogs it reads itself.
 */
export function needsYouCount(herd: { agents: readonly AgentView[] }): number {
  return needsYouItems(herd.agents, []).length;
}

/** One open pull request on Home's PRs tab, from GitHub. */
export interface ReviewEntry {
  /** `owner/name#number` when the URL is known, else `repo#number`. */
  key: string;
  title: string;
  /** The repo's short name. */
  repo: string;
  /** The repo's owner, when the URL names one. */
  owner?: string;
  number?: number;
  branch?: string;
  url?: string;
  draft: boolean;
  review?: PullRequestView["review"];
  checks?: { passed: number; failed: number; pending: number };
  diff?: { additions: number; deletions: number };
  /** Epoch ms; 0 when unknown. */
  updatedAt: number;
  /** The pane on its branch, where Review goes inside Nenu; absent means the PR's page on GitHub. */
  open?: { paneId: string };
  /** Its repo is one a pane's folder names: what the PRs tab lists unless asked for all. */
  inUse: boolean;
}

const PR_URL_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)$/;
const prKey = (url: string | undefined) => {
  const match = url ? PR_URL_RE.exec(url) : null;
  return match ? { key: `${match[1]}/${match[2]}#${match[3]}`, repo: match[2]!, owner: match[1]! } : undefined;
};

/** Approved, not a draft, no check failing or running: one merge away. */
export function readyToMerge(entry: ReviewEntry): boolean {
  return !entry.draft && entry.review === "approved" && !entry.checks?.failed && !entry.checks?.pending;
}

/** Where a pull request can stand, in the order a repo lists them. */
export const PR_STATES = ["ready", "attention", "review", "draft"] as const;
export type PrState = typeof PR_STATES[number];

/** Where a pull request stands: one merge away, else a draft, else blocked (a check failing or changes asked for), else in review. */
export function prState(entry: ReviewEntry): PrState {
  if (readyToMerge(entry)) return "ready";
  if (entry.draft) return "draft";
  return entry.checks?.failed || entry.review === "changes_requested" ? "attention" : "review";
}

/** The run a pull request sits in, ready to merge first and drafts last. */
const standing = (entry: ReviewEntry) => PR_STATES.indexOf(prState(entry));

/** Home's review list: the person's open pull requests from GitHub, by where each stands, then newest first. */
export function reviewQueue(pullRequests: readonly PullRequestView[] | undefined): ReviewEntry[] {
  const rows = new Map<string, ReviewEntry>();
  for (const pr of pullRequests ?? []) {
    const id = prKey(pr.url);
    const key = id?.key ?? `${pr.repo}#${pr.number}`;
    rows.set(key, {
      key, title: pr.title, repo: id?.repo ?? pr.repo, ...(id ? { owner: id.owner } : {}), number: pr.number, branch: pr.branch, url: pr.url, draft: pr.draft,
      ...(pr.review ? { review: pr.review } : {}),
      ...(pr.checks ? { checks: pr.checks } : {}),
      ...(pr.diff ? { diff: pr.diff } : {}),
      updatedAt: pr.updatedAt ?? 0,
      ...(pr.paneIds[0] ? { open: { paneId: pr.paneIds[0] } } : {}),
      inUse: pr.inUse,
    });
  }
  return [...rows.values()].sort((a, b) => standing(a) - standing(b) || b.updatedAt - a.updatedAt);
}

/** One repo's pull requests on Home's PRs tab. */
export interface RepoReviews {
  /** `owner/name`, or the short name when no URL names the owner. */
  key: string;
  name: string;
  owner?: string;
  entries: ReviewEntry[];
}

/**
 * The PRs tab's runs, one per repo, each in `reviewQueue`'s order; the repos by their latest move, so
 * the one being worked on leads.
 */
export function reviewsByRepo(entries: readonly ReviewEntry[]): RepoReviews[] {
  const repos = new Map<string, RepoReviews>();
  for (const entry of entries) {
    const key = entry.owner ? `${entry.owner}/${entry.repo}` : entry.repo;
    const repo = repos.get(key) ?? { key, name: entry.repo, ...(entry.owner ? { owner: entry.owner } : {}), entries: [] };
    repo.entries.push(entry);
    repos.set(key, repo);
  }
  const latest = (repo: RepoReviews) => Math.max(...repo.entries.map((entry) => entry.updatedAt));
  return [...repos.values()].sort((a, b) => latest(b) - latest(a) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** A session in Home's list (any pane, agent or shell): what every view calls it, where it lives, and when it last moved. */
export interface RecentChat extends DisplayPlace {
  agent: AgentView;
  title: string;
  /** Last movement or visit, epoch ms; 0 when unknown. */
  at: number;
  /** Finished since you last opened it. */
  unseen: boolean;
  /** What tells it apart after its place: its pull request, else its tab. */
  detail: string | null;
  /** Its pull request's size, when one is known. */
  diff?: { additions: number; deletions: number };
}

/**
 * Home's rows for `panes`, in the order given. A session's pull request is the one Home's review
 * queue opens in it: GitHub's on its branch.
 */
export function sessionChats(panes: readonly AgentView[], reviews: readonly ReviewEntry[] = []): RecentChat[] {
  const byPane = new Map<string, ReviewEntry>();
  for (const entry of reviews) if (entry.open && !byPane.has(entry.open.paneId)) byPane.set(entry.open.paneId, entry);
  return panes.map((agent) => {
    const entry = byPane.get(agent.paneId);
    const place = displayPlace(agent);
    return {
      agent, title: displayName(agent), ...place, at: chatRecency(agent), unseen: isUnseen(agent),
      detail: entry?.number !== undefined ? `PR #${entry.number}` : place.tab,
      ...(entry?.diff ? { diff: entry.diff } : {}),
    };
  });
}

/**
 * Home's "Recents": every session, agents and shells, most recently moved or opened first, except the
 * ones "Needs you" already shows. Equal (or unknown) times keep the bridge's pane order.
 */
export function recentChats(panes: readonly AgentView[], shown: ReadonlySet<string>, reviews: readonly ReviewEntry[] = []): RecentChat[] {
  return sessionChats(byRecency(panes.filter((pane) => !shown.has(pane.paneId))), reviews);
}

/** A tab in Home's "Workspaces" list, with its sessions in pane order. */
export interface TabChats {
  tabId: string;
  label: string;
  chats: RecentChat[];
}

/** A Herdr workspace in Home's "Workspaces" list, with its tabs that hold a session, in tab order. */
export interface WorkspaceChats {
  workspaceId: string;
  name: string;
  tabs: TabChats[];
  /** The pane its row opens when it holds one tab or one session (opensDirectly); otherwise the row unfolds its tabs. */
  entry?: string;
}

/** Every session a workspace in Home's list holds, in tab order. */
export const workspaceSessions = (group: Pick<WorkspaceChats, "tabs">): RecentChat[] => group.tabs.flatMap((tab) => tab.chats);

/** Home's "Workspaces": every session under its workspace and tab, in the order the workspace tree keeps them. */
export function workspaceChats(herd: Herd, reviews: readonly ReviewEntry[] = []): WorkspaceChats[] {
  return workspaceTree(herd).map((branch) => {
    const entry = opensDirectly(branch) ? workspaceEntry(branch.workspace.workspaceId, herd)?.paneId : undefined;
    return {
      workspaceId: branch.workspace.workspaceId,
      name: branch.name,
      tabs: branch.tabs.map((tab) => ({ tabId: tab.tabId, label: tab.label, chats: sessionChats(tab.panes, reviews) })),
      ...(entry ? { entry } : {}),
    };
  });
}

/** Workflows still running, with the pane that launched them. */
export function runningWorkflows(activity: ReadonlyMap<string, ActivityResponse>): Array<{ paneId: string; workflow: ActivityWorkflow }> {
  return [...activity].flatMap(([paneId, res]) => res.available
    ? res.workflows.filter((workflow) => workflow.status === "running").map((workflow) => ({ paneId, workflow }))
    : []);
}
