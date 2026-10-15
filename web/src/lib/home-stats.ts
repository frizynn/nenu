// What Home says about the herd, derived from the snapshot and the bridge's detected dialogs. Every
// figure is a reading of the present, never a reconstructed series.
import type { ActivityResponse, ActivityWorkflow } from "./activity";
import { awaits, nodeState, type Ask } from "./org-tree";
import { displayName, displayPlace, type DisplayPlace } from "./display-name";
import { byRecency, chatRecency, isOpenThread, projectForPane } from "./projects";
import { isUnseen } from "./triage";
import type { AgentView, ProjectThreadView, ProjectView, PullRequestView, ThreadPullRequest } from "./types";
import { opensDirectly, workspaceTree } from "./workspace-tree";
import { workspaceEntry, type Herd } from "./spaces";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface HomeCounts {
  /** Panes with a dialog waiting, or blocked without one the bridge could read. */
  needs: number;
  /** Pull requests waiting to be looked at. */
  review: number;
  working: number;
  /** Agents waiting at their prompt with nothing for you. */
  idle: number;
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
  const { needs, review, working, idle } = counts;
  const rest = (...parts: Array<string | false>) => parts.filter(Boolean).join(" · ") || null;
  const reviewing = review > 0 && `${review} to review`;
  const idling = idle > 0 && `${idle} idle`;
  if (needs) return { title: needYou(needs), detail: rest(reviewing, working > 0 && `${working} working`, idling) };
  if (!total) return { title: "What should we work on?", detail: null };
  if (calm) return { title: "Nothing needs you", detail: rest(reviewing, working > 0 && `${working} working`, idling) };
  if (working) return { title: `${plural(working, "agent")} at work`, detail: rest(reviewing, idling) };
  return { title: "All quiet", detail: rest(reviewing) };
}

export function greeting(now: number): string {
  const hour = new Date(now).getHours();
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/**
 * A pane Home asks you about: its detected dialog, none when it is blocked on something unread, or
 * `reply` when its agent stopped and said it waits for your reply, with no dialog at all.
 */
export interface NeedsYouItem<I> {
  paneId: string;
  interaction?: I;
  reply?: true;
}

/**
 * What needs you, oldest first: every detected dialog, then blocked panes the bridge read no dialog
 * on (still yours to look at, in the thread), then the live threads waiting for your reply (`awaits`).
 */
export function needsYouItems<I extends { paneId: string; detectedAt: number }>(agents: readonly AgentView[], interactions: readonly I[], projects?: readonly ProjectView[]): NeedsYouItem<I>[] {
  const asked = [...interactions].sort((a, b) => a.detectedAt - b.detectedAt);
  const covered = new Set(asked.map((i) => i.paneId));
  const blocked = agents.filter((agent) => agent.status === "blocked" && !covered.has(agent.paneId))
    .sort((a, b) => (a.lastActiveAt ?? 0) - (b.lastActiveAt ?? 0));
  for (const agent of blocked) covered.add(agent.paneId);
  const live = new Set(agents.map((agent) => agent.paneId));
  const replies = (projects ?? []).flatMap((project) => project.threads)
    .filter((thread) => thread.paneId && live.has(thread.paneId) && !covered.has(thread.paneId) && awaits(thread) === "reply");
  return [
    ...asked.map((interaction) => ({ paneId: interaction.paneId, interaction })),
    ...blocked.map((agent) => ({ paneId: agent.paneId })),
    ...replies.map((thread) => ({ paneId: thread.paneId!, reply: true as const })),
  ];
}

/**
 * How many need you by the snapshot alone: blocked panes and threads waiting for your reply. Home's
 * icon shows it; Home's headline counts the same set and adds the dialogs it reads itself.
 */
export function needsYouCount(herd: { agents: readonly AgentView[]; projects?: readonly ProjectView[] }): number {
  return needsYouItems(herd.agents, [], herd.projects).length;
}

/** Agents at their prompt with nothing for you: not asking, and not a session a pull request to review rides on. */
export function idleAgents(agents: readonly AgentView[], needs: readonly NeedsYouItem<unknown>[], reviews: readonly ReviewEntry[]): number {
  const held = new Set([...needs.map((item) => item.paneId), ...reviews.flatMap((entry) => entry.open && "paneId" in entry.open ? [entry.open.paneId] : [])]);
  return agents.filter((agent) => (agent.status === "idle" || agent.status === "done") && !held.has(agent.paneId)).length;
}

export interface ReviewItem {
  project: ProjectView;
  thread: ProjectThreadView;
}

/**
 * Open threads waiting on a review, as the organization tree reads them (`nodeState`); a files-only
 * project carries no group, so there an open pull request on an agent that stopped counts instead.
 */
export function reviewItems(projects: readonly ProjectView[] | undefined): ReviewItem[] {
  return (projects ?? []).flatMap((project) => project.threads
    .filter((thread) => isOpenThread(thread) && (thread.group
      ? nodeState(thread) === "review"
      : thread.pr?.state === "open" && thread.liveStatus !== "working" && thread.liveStatus !== "blocked"))
    .map((thread) => ({ project, thread })));
}

/** One pull request in Home's "Ready to review", from GitHub, from Organizations, or both. */
export interface ReviewEntry {
  /** `owner/name#number` when the URL is known, else the thread's own key. */
  key: string;
  title: string;
  /** The repo's short name, or the project's name for a PR Organizations reported without a URL. */
  repo: string;
  number?: number;
  branch?: string;
  url?: string;
  draft: boolean;
  review?: ThreadPullRequest["review"];
  checks?: { passed: number; failed: number; pending: number };
  diff?: { additions: number; deletions: number };
  mergeBlocker?: string | null;
  /** Epoch ms; 0 when unknown. */
  updatedAt: number;
  /** Where Review goes inside Nenu; absent means the PR's page on GitHub. */
  open?: { paneId: string } | { project: string; node: string };
}

const PR_URL_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)$/;
const prKey = (url: string | undefined) => {
  const match = url ? PR_URL_RE.exec(url) : null;
  return match ? { key: `${match[1]}/${match[2]}#${match[3]}`, repo: match[2]! } : undefined;
};
const checksPassed = (checks: ReviewEntry["checks"]) => !!checks && checks.passed > 0 && !checks.failed && !checks.pending;

/** Approved, not a draft, no check failing or running and nothing else blocking: one merge away. */
export function readyToMerge(entry: ReviewEntry): boolean {
  return !entry.draft && entry.review === "approved" && !entry.checks?.failed && !entry.checks?.pending && !entry.mergeBlocker;
}

/**
 * Home's review list: the person's open pull requests from GitHub, joined with the PRs Organizations
 * threads are waiting on. The same PR from both is one row that opens Organizations' thread. Drafts
 * go last; among the rest a PR with green checks and an approval comes first, then the most recent.
 */
export function reviewQueue(projects: readonly ProjectView[] | undefined, pullRequests: readonly PullRequestView[] | undefined): ReviewEntry[] {
  const rows = new Map<string, ReviewEntry>();
  for (const pr of pullRequests ?? []) {
    const id = prKey(pr.url);
    const key = id?.key ?? `${pr.repo}#${pr.number}`;
    rows.set(key, {
      key, title: pr.title, repo: id?.repo ?? pr.repo, number: pr.number, branch: pr.branch, url: pr.url, draft: pr.draft,
      ...(pr.review ? { review: pr.review } : {}),
      ...(pr.checks ? { checks: pr.checks } : {}),
      ...(pr.diff ? { diff: pr.diff } : {}),
      updatedAt: pr.updatedAt ?? 0,
      ...(pr.paneIds[0] ? { open: { paneId: pr.paneIds[0] } } : {}),
    });
  }
  for (const { project, thread } of reviewItems(projects)) {
    const pr = thread.pr;
    const id = prKey(pr?.url);
    const key = id?.key ?? `${project.slug}:${thread.id}`;
    const { open: _ownPane, ...github } = rows.get(key) ?? {};
    // Organizations' thread is the one to open; GitHub's read is the fresher one for everything else.
    rows.set(key, {
      key,
      title: thread.title,
      repo: id?.repo ?? project.name,
      ...(pr?.number !== undefined ? { number: pr.number } : {}),
      ...(thread.branch ? { branch: thread.branch } : {}),
      ...(pr?.url ? { url: pr.url } : {}),
      draft: pr?.state === "draft",
      ...(pr?.review ? { review: pr.review } : {}),
      ...(pr?.checks ? { checks: pr.checks } : {}),
      ...(pr?.diff ? { diff: pr.diff } : {}),
      ...(pr?.mergeBlocker !== undefined ? { mergeBlocker: pr.mergeBlocker } : {}),
      updatedAt: Date.parse(thread.updated ?? "") || 0,
      ...github,
      open: thread.paneId ? { paneId: thread.paneId } : { project: project.slug, node: thread.id },
    });
  }
  const ready = (row: ReviewEntry) => Number(checksPassed(row.checks)) + Number(row.review === "approved");
  return [...rows.values()].sort((a, b) => Number(a.draft) - Number(b.draft) || ready(b) - ready(a) || b.updatedAt - a.updatedAt);
}

/** A session in Home's list (any pane, agent or shell): what every view calls it, where it lives, and when it last moved. */
export interface RecentChat extends DisplayPlace {
  agent: AgentView;
  title: string;
  /** Last movement or visit, epoch ms; 0 when unknown. */
  at: number;
  /** Finished since you last opened it. */
  unseen: boolean;
  /** Its thread waits on a review, as the organization tree reads it. */
  review: boolean;
  /** What its thread waits on you for, as every view of the organization says it. */
  ask?: Ask;
  /** What tells it apart after its place: its pull request, "coordinator" for a coordinator thread, else its tab. */
  detail: string | null;
  /** Its pull request's size, when one is known. */
  diff?: { additions: number; deletions: number };
}

/**
 * Home's rows for `panes`, in the order given. A session's pull request is the one Home's review
 * queue opens in it (GitHub's on its branch, joined with its thread's), else the one its thread records.
 */
export function sessionChats(panes: readonly AgentView[], projects: readonly ProjectView[] | undefined, reviews: readonly ReviewEntry[] = []): RecentChat[] {
  const inReview = new Set(reviewItems(projects).map(({ thread }) => thread.paneId));
  const byPane = new Map<string, ReviewEntry>();
  for (const entry of reviews) if (entry.open && "paneId" in entry.open && !byPane.has(entry.open.paneId)) byPane.set(entry.open.paneId, entry);
  return panes.map((agent) => {
    const thread = projectForPane(projects, agent.paneId)?.thread;
    const entry = byPane.get(agent.paneId);
    const number = entry?.number ?? thread?.pr?.number;
    const diff = entry?.diff ?? thread?.pr?.diff;
    const place = displayPlace(agent, projects);
    const ask = thread && awaits(thread);
    return {
      agent, title: displayName(agent, projects), ...place, at: chatRecency(agent), unseen: isUnseen(agent),
      review: inReview.has(agent.paneId),
      detail: number !== undefined ? `PR #${number}` : thread?.role === "coordinator" ? "coordinator" : place.tab,
      ...(diff ? { diff } : {}),
      ...(ask ? { ask } : {}),
    };
  });
}

/**
 * Home's "Recents": every session, agents and shells, most recently moved or opened first, except the
 * ones "Needs you" already shows. Equal (or unknown) times keep the bridge's pane order.
 */
export function recentChats(panes: readonly AgentView[], projects: readonly ProjectView[] | undefined, shown: ReadonlySet<string>, reviews: readonly ReviewEntry[] = []): RecentChat[] {
  return sessionChats(byRecency(panes.filter((pane) => !shown.has(pane.paneId))), projects, reviews);
}

/** A Herdr workspace in Home's "Workspaces" list, with its sessions in tab order. */
export interface WorkspaceChats {
  workspaceId: string;
  name: string;
  chats: RecentChat[];
  /** The pane its row opens when it holds one tab (opensDirectly); otherwise the row unfolds its sessions. */
  entry?: string;
}

/** Home's "Workspaces": every session under its workspace, in the order the workspace tree keeps them. */
export function workspaceChats(herd: Herd, projects: readonly ProjectView[] | undefined, reviews: readonly ReviewEntry[] = []): WorkspaceChats[] {
  return workspaceTree(herd).map((branch) => {
    const entry = opensDirectly(branch) ? workspaceEntry(branch.workspace.workspaceId, herd)?.paneId : undefined;
    return {
      workspaceId: branch.workspace.workspaceId,
      name: branch.name,
      chats: sessionChats(branch.tabs.flatMap((tab) => tab.panes), projects, reviews),
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
