import { withTimeout, XHR_HEADER, XHR_HEADER_VALUE } from "@/lib/api";

// Background work of the Claude session bound to a pane (bridge/claude-activity.ts): workflows,
// background commands and claude.ai artifacts. Mirrors the bridge types; kept apart from lib/types.ts
// so the activity view can land without touching the shared contracts.

export type ActivityAgentState = "running" | "done" | "failed";
export interface ActivityAgent {
  id: string;
  label: string;
  phase: string;
  state: ActivityAgentState;
  model?: string;
  startedAt?: number;
  durationMs?: number;
  tokens?: number;
  toolCalls?: number;
  lastTool?: string;
  resultPreview?: string;
  updatedAt?: number;
}
export interface ActivityPhase { title: string; agents: ActivityAgent[] }
export type ActivityWorkflowStatus = "running" | "completed" | "failed" | "unknown";
export interface ActivityWorkflow {
  runId: string;
  taskId?: string;
  name: string;
  summary?: string;
  status: ActivityWorkflowStatus;
  startedAt?: number;
  durationMs?: number;
  updatedAt?: number;
  phases: ActivityPhase[];
  agentCount: number;
  doneCount: number;
  totalTokens?: number;
  totalToolCalls?: number;
}
export type ActivityTaskKind = "bash" | "monitor" | "agent" | "other";
export interface ActivityTask {
  id: string;
  kind: ActivityTaskKind;
  title: string;
  status: "running" | "completed" | "failed" | "unknown";
  exitCode?: number;
  event?: string;
  at?: number;
  hasOutput: boolean;
}
export interface ActivityArtifact { id: string; url: string; title: string; icon?: string; version?: string; at?: number }
export type ActivityResponse =
  | { available: false; reason: "disabled" | "no-session" | "unsupported" }
  | { available: true; sessionKey: string; workflows: ActivityWorkflow[]; tasks: ActivityTask[]; artifacts: ActivityArtifact[]; truncated: boolean };
export interface WorkflowDetailResponse { sessionKey: string; workflow: ActivityWorkflow; results: Record<string, unknown> }
export interface TaskOutputResponse { sessionKey: string; id: string; text: string; truncated: boolean; updatedAt: number }

const TIMEOUT_MS = 10_000;

function activityUrl(paneId: string, session: string | undefined, query: Record<string, string> = {}): string {
  const params = new URLSearchParams(query);
  const s = session?.trim();
  if (s) params.set("session", s);
  const q = params.toString();
  return `/api/pane/${encodeURIComponent(paneId)}/activity${q ? `?${q}` : ""}`;
}

export class ActivityRequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`activity request failed: ${status}`);
    this.status = status;
  }
}

async function get<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { signal: withTimeout(signal, TIMEOUT_MS), redirect: "manual", headers: { [XHR_HEADER]: XHR_HEADER_VALUE } });
  if (!res.ok) throw new ActivityRequestError(res.status);
  return (await res.json()) as T;
}

export function fetchActivity(paneId: string, session?: string, signal?: AbortSignal): Promise<ActivityResponse> {
  return get(activityUrl(paneId, session), signal);
}

export function fetchWorkflowDetail(paneId: string, runId: string, session?: string, signal?: AbortSignal): Promise<WorkflowDetailResponse> {
  return get(activityUrl(paneId, session, { run: runId }), signal);
}

export function fetchTaskOutput(paneId: string, taskId: string, session?: string, signal?: AbortSignal): Promise<TaskOutputResponse> {
  return get(activityUrl(paneId, session, { task: taskId }), signal);
}

// ── Display helpers shared by the activity components ──────────────────────────────────────────

/** "1h 31m", "57m 17s", "44s". */
export function formatDuration(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "574k", "1.49M". */
export function formatCount(n: number | undefined): string {
  if (n === undefined) return "";
  if (n >= 1_000_000) return `${Number((n / 1_000_000).toFixed(2))}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

export function formatClock(at: number | undefined): string {
  if (at === undefined) return "";
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });
}

export const allAgents = (wf: ActivityWorkflow): ActivityAgent[] => wf.phases.flatMap((p) => p.agents);
export const phaseRunning = (p: ActivityPhase): boolean => p.agents.some((a) => a.state === "running");
export const phaseDone = (p: ActivityPhase): number => p.agents.filter((a) => a.state !== "running").length;

/** Elapsed for a running workflow, total for a finished one. */
export function workflowElapsed(wf: ActivityWorkflow, now: number): number | undefined {
  if (wf.durationMs !== undefined) return wf.durationMs;
  return wf.startedAt !== undefined && wf.status === "running" ? now - wf.startedAt : undefined;
}

export function agentElapsed(agent: ActivityAgent, now: number): number | undefined {
  if (agent.durationMs !== undefined) return agent.durationMs;
  return agent.startedAt !== undefined && agent.state === "running" ? now - agent.startedAt : undefined;
}

/** How many running things the Activity tab badge counts. */
export function runningCount(res: ActivityResponse | null): number {
  if (!res?.available) return 0;
  return res.workflows.filter((w) => w.status === "running").length + res.tasks.filter((t) => t.status === "running").length;
}
