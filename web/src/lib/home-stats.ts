// What Home says about the herd, derived only from the snapshot. There is no stored history: the
// bridge keeps one timestamp per pane (its latest status change), so every figure here is a reading
// of the present, never a reconstructed series.
import { chatMatches, chatRecency, isOpenThread, looseChats, projectMatches } from "./projects";
import { bucketOf, type TriageKey } from "./triage";
import { paneDisplayName, type AgentStatus, type AgentView, type ProjectView } from "./types";

export type HerdCounts = Record<TriageKey, number> & { total: number };

/** Agents per triage bucket, so Home's numbers and the lists below them share one classifier. */
export function herdCounts(agents: readonly AgentView[]): HerdCounts {
  const counts: HerdCounts = { needs: 0, ready: 0, working: 0, recent: 0, total: agents.length };
  for (const agent of agents) counts[bucketOf(agent)]++;
  return counts;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The one sentence at the top of Home: the most urgent fact, not a list of them. */
export function herdHeadline(counts: HerdCounts): string {
  if (counts.needs) return `${plural(counts.needs, "agent")} ${counts.needs === 1 ? "needs" : "need"} you`;
  if (counts.ready) return `${plural(counts.ready, "result")} ready to review`;
  if (counts.working) return `${plural(counts.working, "agent")} at work`;
  if (counts.total) return "All quiet";
  return "What should we work on?";
}

export function greeting(now: number): string {
  const hour = new Date(now).getHours();
  if (hour < 5) return "Working late";
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export interface ActivityBucket {
  /** Epoch ms where this hour starts. */
  start: number;
  count: number;
}

const HOUR = 3_600_000;

/**
 * Agents bucketed by the hour of their latest status change, oldest hour first, ending with the
 * current (partial) hour. Each agent counts once, so this is "when things last moved", which is
 * all the snapshot can honestly say. Agents without a timestamp (older bridge) are left out.
 */
export function activityByHour(agents: readonly AgentView[], now: number, hours = 12): ActivityBucket[] {
  const current = Math.floor(now / HOUR) * HOUR;
  const first = current - (hours - 1) * HOUR;
  const buckets = Array.from({ length: hours }, (_, index) => ({ start: first + index * HOUR, count: 0 }));
  for (const agent of agents) {
    const at = agent.lastActiveAt;
    if (!at || at < first || at > now) continue;
    buckets[Math.floor((at - first) / HOUR)]!.count++;
  }
  return buckets;
}

export interface ProjectProgress {
  resolved: number;
  total: number;
  /** 0..1; 0 for a project with no tasks yet. */
  ratio: number;
}

export function projectProgress(project: ProjectView): ProjectProgress {
  const total = project.threads.length;
  const resolved = project.threads.filter((thread) => !isOpenThread(thread)).length;
  return { resolved, total, ratio: total ? resolved / total : 0 };
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
