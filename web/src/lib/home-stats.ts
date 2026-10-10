// What Home says about the herd, derived from the snapshot and the bridge's detected dialogs. Every
// figure is a reading of the present, never a reconstructed series.
import type { ActivityResponse, ActivityTask, ActivityWorkflow } from "./activity";
import { chatMatches, chatRecency, isOpenThread, looseChats, projectMatches } from "./projects";
import { paneDisplayName, type AgentStatus, type AgentView, type ProjectThreadView, type ProjectView } from "./types";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export interface HomeCounts {
  /** Panes with a dialog waiting, or blocked without one the bridge could read. */
  needs: number;
  /** Pull requests and finished background work waiting to be looked at. */
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
  if (review) return `${plural(review, "result")} ready to review`;
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

export type ProjectStateCounts = Record<"blocked" | "working" | "review" | "idle", number>;

/** A project's open threads (and its coordinator) by what their dot says, for its status bar. */
export function projectStateCounts(project: ProjectView): ProjectStateCounts {
  const counts: ProjectStateCounts = { blocked: 0, working: 0, review: 0, idle: 0 };
  const states: ThreadState[] = project.threads.filter(isOpenThread).map(threadState);
  const coordinated = project.threads.some((thread) => thread.paneId && thread.paneId === project.coordinator?.paneId);
  if (project.coordinator && !coordinated) states.push(project.coordinator.liveStatus);
  for (const state of states) counts[state === "blocked" || state === "working" || state === "review" ? state : "idle"]++;
  return counts;
}

export interface JumpTarget {
  kind: "project" | "chat";
  /** Project slug or pane id. */
  id: string;
  label: string;
  detail: string;
  status?: AgentStatus;
  /** Last movement, epoch ms; 0 when unknown. */
  ts: number;
}

/** A project moves when its coordinator or any of its task panes does, or a task file is updated. */
function projectRecency(project: ProjectView, byPane: ReadonlyMap<string, AgentView>): number {
  const panes = [project.coordinator?.paneId, ...project.threads.map((thread) => thread.paneId)];
  const paneTimes = panes.map((id) => (id && byPane.get(id) ? chatRecency(byPane.get(id)!) : 0));
  const updates = project.threads.map((thread) => Date.parse(thread.updated ?? "") || 0);
  return Math.max(0, ...paneTimes, ...updates);
}

/**
 * Everything Home can jump to, most recently moved first: projects and the chats outside them (a
 * project's own panes are reached through the project). A query filters with the same matcher the
 * sidebar search uses.
 */
export function jumpTargets(agents: readonly AgentView[], projects: readonly ProjectView[] | undefined, query = ""): JumpTarget[] {
  const byPane = new Map(agents.map((agent) => [agent.paneId, agent]));
  const projectTargets = (projects ?? [])
    .filter((project) => projectMatches(project, query))
    .map((project): JumpTarget => ({
      kind: "project",
      id: project.slug,
      label: project.name,
      detail: "Project",
      ...(project.coordinator ? { status: project.coordinator.liveStatus } : {}),
      ts: projectRecency(project, byPane),
    }));
  const chatTargets = looseChats(agents, projects)
    .filter((pane) => chatMatches(pane, query))
    .map((pane): JumpTarget => ({
      kind: "chat",
      id: pane.paneId,
      label: paneDisplayName(pane),
      detail: pane.workspaceLabel,
      status: pane.status,
      ts: chatRecency(pane),
    }));
  // Stable sort: equal (or unknown) times keep projects first, then the bridge's own pane order.
  return [...projectTargets, ...chatTargets].sort((a, b) => b.ts - a.ts);
}

/** Background work that ended since you last opened its thread: a workflow, or a command that failed. */
export interface FinishedNotice {
  paneId: string;
  kind: "workflow" | "task";
  id: string;
  title: string;
  failed: boolean;
  /** Epoch ms it ended. */
  at: number;
  workflow?: ActivityWorkflow;
  task?: ActivityTask;
}

const NOTICE_WINDOW_MS = 24 * 3_600_000;

/**
 * Finished workflows and failed background commands per pane, newest first. Opening the thread
 * retires them the way it retires an unseen result: the bridge's `lastSeenAt` passes their end.
 */
export function finishedNotices(activity: ReadonlyMap<string, ActivityResponse>, agents: readonly AgentView[], now: number): FinishedNotice[] {
  const seen = new Map(agents.map((agent) => [agent.paneId, agent.lastSeenAt ?? 0]));
  const notices: FinishedNotice[] = [];
  for (const [paneId, res] of activity) {
    if (!res.available || !seen.has(paneId)) continue;
    const fresh = (at: number | undefined): at is number => at !== undefined && at > seen.get(paneId)! && now - at < NOTICE_WINDOW_MS;
    for (const workflow of res.workflows) {
      if (workflow.status !== "completed" && workflow.status !== "failed") continue;
      const at = workflow.updatedAt ?? (workflow.startedAt !== undefined && workflow.durationMs !== undefined ? workflow.startedAt + workflow.durationMs : undefined);
      if (fresh(at)) notices.push({ paneId, kind: "workflow", id: workflow.runId, title: workflow.name, failed: workflow.status === "failed", at, workflow });
    }
    // One notice per pane for failed commands, the latest. An exit above 128 is a signal: the agent or
    // the user stopped it (a gate wait cut short, a Ctrl+C), which is not a result to review.
    const failed = res.tasks
      .filter((task): task is ActivityTask & { at: number } => task.status === "failed" && (task.exitCode ?? 1) <= 128 && fresh(task.at))
      .sort((a, b) => b.at - a.at)[0];
    if (failed) notices.push({ paneId, kind: "task", id: failed.id, title: failed.title, failed: true, at: failed.at, task: failed });
  }
  return notices.sort((a, b) => b.at - a.at);
}

/** Workflows still running, with the pane that launched them. */
export function runningWorkflows(activity: ReadonlyMap<string, ActivityResponse>): Array<{ paneId: string; workflow: ActivityWorkflow }> {
  return [...activity].flatMap(([paneId, res]) => res.available
    ? res.workflows.filter((workflow) => workflow.status === "running").map((workflow) => ({ paneId, workflow }))
    : []);
}
