// What Home says about the herd, derived from the snapshot and the bridge's detected dialogs. Every
// figure is a reading of the present, never a reconstructed series.
import type { ActivityResponse, ActivityWorkflow } from "./activity";
import { byRecency, chatRecency, isOpenThread, paneIdentity, type PaneIdentity } from "./projects";
import { isUnseen } from "./triage";
import type { AgentStatus, AgentView, ProjectThreadView, ProjectView, PullRequestView, ThreadPullRequest } from "./types";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface HomeCounts {
  /** Panes with a dialog waiting, or blocked without one the bridge could read. */
  needs: number;
  /** Pull requests waiting to be looked at. */
  review: number;
  working: number;
}

/** The one sentence at the top of Home. The short form is the phone's, which has room for two facts. */
export function homeHeadline(counts: HomeCounts, total: number, short = false): string {
  const { needs, review, working } = counts;
  if (short) {
    const parts = [needs && `${needs} need${needs === 1 ? "s" : ""} you`, review && `${review} to review`, working && `${working} working`].filter(Boolean);
    return parts.length ? parts.slice(0, 2).join(" · ") : total ? "All quiet" : "What should we work on?";
  }
  if (needs && review) return `${plural(needs, "thread")} ${needs === 1 ? "needs" : "need"} you, ${review} ${review === 1 ? "is" : "are"} ready to review`;
  if (needs) return `${plural(needs, "thread")} ${needs === 1 ? "needs" : "need"} you`;
  if (review) return `${plural(review, "pull request")} ready to review`;
  if (working) return `${plural(working, "agent")} at work`;
  return total ? "All quiet" : "What should we work on?";
}

export function greeting(now: number): string {
  const hour = new Date(now).getHours();
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

/** A pane Home asks you about: its detected dialog, or none when it is blocked on something unread. */
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
  return [...asked.map((interaction) => ({ paneId: interaction.paneId, interaction })), ...blocked.map((agent) => ({ paneId: agent.paneId }))];
}

/** What a thread's dot says: Organizations' ready-for-review group reads as its own state. */
export type ThreadState = AgentStatus | "review";
export function threadState(thread: ProjectThreadView): ThreadState {
  const live = thread.paneId ? thread.liveStatus ?? "unknown" : "unknown";
  return thread.group === "ready-for-review" && live !== "blocked" ? "review" : live;
}

export interface ReviewItem {
  project: ProjectView;
  thread: ProjectThreadView;
}

/**
 * Open threads waiting on a review. Organizations' `ready-for-review` group decides; a files-only
 * project carries no group, so there an open pull request on an agent that stopped counts instead.
 */
export function reviewItems(projects: readonly ProjectView[] | undefined): ReviewItem[] {
  return (projects ?? []).flatMap((project) => project.threads
    .filter((thread) => isOpenThread(thread) && (thread.group
      ? threadState(thread) === "review"
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
  open?: { paneId: string } | { project: string };
}

const PR_URL_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)$/;
const prKey = (url: string | undefined) => {
  const match = url ? PR_URL_RE.exec(url) : null;
  return match ? { key: `${match[1]}/${match[2]}#${match[3]}`, repo: match[2]! } : undefined;
};
const checksPassed = (checks: ReviewEntry["checks"]) => !!checks && checks.passed > 0 && !checks.failed && !checks.pending;

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
      open: thread.paneId ? { paneId: thread.paneId } : { project: project.slug },
    });
  }
  const ready = (row: ReviewEntry) => Number(checksPassed(row.checks)) + Number(row.review === "approved");
  return [...rows.values()].sort((a, b) => Number(a.draft) - Number(b.draft) || ready(b) - ready(a) || b.updatedAt - a.updatedAt);
}

/** A chat in Home's "Recent": what it is, where it lives, and when it last moved. */
export interface RecentChat extends PaneIdentity {
  agent: AgentView;
  /** Last movement or visit, epoch ms; 0 when unknown. */
  at: number;
  /** Finished since you last opened it. */
  unseen: boolean;
}

/**
 * Home's "Recent": every agent chat, most recently moved or opened first, except the ones "Needs you"
 * already shows. Equal (or unknown) times keep the bridge's pane order.
 */
export function recentChats(agents: readonly AgentView[], projects: readonly ProjectView[] | undefined, shown: ReadonlySet<string>): RecentChat[] {
  return byRecency(agents.filter((agent) => !shown.has(agent.paneId)))
    .map((agent) => ({ agent, ...paneIdentity(agent, projects), at: chatRecency(agent), unseen: isUnseen(agent) }));
}

/** Workflows still running, with the pane that launched them. */
export function runningWorkflows(activity: ReadonlyMap<string, ActivityResponse>): Array<{ paneId: string; workflow: ActivityWorkflow }> {
  return [...activity].flatMap(([paneId, res]) => res.available
    ? res.workflows.filter((workflow) => workflow.status === "running").map((workflow) => ({ paneId, workflow }))
    : []);
}
