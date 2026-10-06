import { useSyncExternalStore } from "react";

import * as api from "@/lib/api";
import type { CreateResponse } from "@/lib/types";

// The "new agent" flow shared by the tab "+" and "New workspace": create the shell, start the agent
// in it, and hand an optional first message to the bridge's message queue (which verifies the
// conversation and types it once the agent is ready). Creating is awaited — the sheet needs a pane
// to navigate into — but everything after it runs here, outside React, so it survives the
// navigation and the sheet closing.

export type SpawnAgent = "claude" | "codex" | "shell";
export const SPAWN_AGENTS: ReadonlyArray<{ id: SpawnAgent; label: string }> = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "shell", label: "Shell" },
];
export const agentLabel = (agent: SpawnAgent) => SPAWN_AGENTS.find((a) => a.id === agent)!.label;

export type SpawnTarget = { kind: "tab"; workspaceId: string } | { kind: "workspace" };

/** How much a new agent may do without asking. Ids are the bridge's allowlist (bridge/agent-start.ts). */
export interface PermissionChoice {
  id: string;
  label: string;
  hint: string;
  danger?: boolean;
}
export const PERMISSIONS: Record<Exclude<SpawnAgent, "shell">, readonly PermissionChoice[]> = {
  claude: [
    { id: "ask", label: "Ask", hint: "Your default mode. Asks before edits and commands." },
    { id: "acceptEdits", label: "Accept edits", hint: "Edits files without asking. Still asks before commands." },
    { id: "plan", label: "Plan", hint: "Reads and plans. Changes nothing until you approve." },
    { id: "bypass", label: "Bypass", hint: "Never asks. Can run any command and change any file.", danger: true },
  ],
  codex: [
    { id: "ask", label: "Ask", hint: "Your default mode. Asks before leaving the sandbox." },
    { id: "auto", label: "Auto", hint: "Edits and runs commands in this folder without asking. Sandboxed." },
    { id: "full", label: "Full access", hint: "No sandbox and never asks. Anything on this machine.", danger: true },
  ],
};

export interface SpawnInput {
  target: SpawnTarget;
  agent: SpawnAgent;
  cwd: string;
  name: string;
  message: string;
  /** A {@link PERMISSIONS} id for the chosen agent; ignored for a shell. */
  permission: string;
  session?: string;
}

// ── Remembered choices ────────────────────────────────────────────────────────────────────────
const AGENT_KEY = "collie.spawn.agent";
const DIRS_KEY = "collie.spawn.dirs";
const PERMISSION_KEY = "collie.spawn.permission";
const MAX_DIRS = 6;

function readJson(key: string): unknown {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private mode or a full quota: the choice just isn't remembered. */
  }
}

export function loadAgent(): SpawnAgent {
  const value = readJson(AGENT_KEY);
  return SPAWN_AGENTS.some((a) => a.id === value) ? (value as SpawnAgent) : "claude";
}
export const saveAgent = (agent: SpawnAgent) => write(AGENT_KEY, agent);

const savedPermissions = (): Record<string, unknown> => {
  const value = readJson(PERMISSION_KEY);
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
};
/** The last permission picked for this agent, if it is still a listed choice; else "ask". */
export function loadPermission(agent: Exclude<SpawnAgent, "shell">): string {
  const value = savedPermissions()[agent];
  return PERMISSIONS[agent].some((p) => p.id === value) ? (value as string) : "ask";
}
export const savePermission = (agent: Exclude<SpawnAgent, "shell">, id: string) => write(PERMISSION_KEY, { ...savedPermissions(), [agent]: id });

export function loadDirs(): string[] {
  const value = readJson(DIRS_KEY);
  return Array.isArray(value) ? value.filter((d): d is string => typeof d === "string" && !!d).slice(0, MAX_DIRS) : [];
}
/** Most recent first, deduplicated, bounded. */
export function withDir(dirs: string[], cwd: string): string[] {
  const dir = cwd.trim();
  return dir ? [dir, ...dirs.filter((d) => d !== dir)].slice(0, MAX_DIRS) : dirs;
}
export const rememberDir = (cwd: string) => write(DIRS_KEY, withDir(loadDirs(), cwd));

/** Directory shortcuts in the order given (current, live, then recent), deduplicated, bounded. */
export function suggestDirs(...groups: string[][]): string[] {
  return [...new Set(groups.flat().map((d) => d.trim()).filter(Boolean))].slice(0, 5);
}

// ── Launch tracker ────────────────────────────────────────────────────────────────────────────
export type SpawnStage = "start" | "queue";
export interface SpawnState {
  agent: Exclude<SpawnAgent, "shell">;
  permission: string;
  stage: SpawnStage;
  phase: "working" | "done" | "error";
  error?: string;
  message: string;
  session?: string;
}

export interface SpawnDeps {
  startAgent: typeof api.startAgent;
  fetchMessageQueue: typeof api.fetchMessageQueue;
  changeMessageQueue: typeof api.changeMessageQueue;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}
export const liveDeps: SpawnDeps = {
  startAgent: api.startAgent,
  fetchMessageQueue: api.fetchMessageQueue,
  changeMessageQueue: api.changeMessageQueue,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: Date.now,
};

const START_ATTEMPTS = 4; // a pane just created may not be a settled shell for the first second or two
const FAST_FAILURE_MS = 3000; // a slower failure means the launch itself ran: never launch twice
const QUEUE_POLL_MS = 1500;
const QUEUE_WAIT_MS = 120_000;

const states = new Map<string, SpawnState>();
const running = new Set<string>();
const listeners = new Set<() => void>();
function set(paneId: string, next: SpawnState): void {
  states.set(paneId, next);
  for (const fn of listeners) fn();
}
export const spawnState = (paneId: string) => states.get(paneId);
export function useSpawnState(paneId: string): SpawnState | undefined {
  return useSyncExternalStore(
    (fn) => (listeners.add(fn), () => void listeners.delete(fn)),
    () => states.get(paneId),
  );
}

async function startStage(paneId: string, s: SpawnState, deps: SpawnDeps): Promise<string | null> {
  let error = "Could not start the agent.";
  for (let attempt = 0; attempt < START_ATTEMPTS; attempt++) {
    const began = deps.now();
    try {
      const result = await deps.startAgent(paneId, s.agent, s.session, s.permission);
      if (result.ok) return null;
      error = result.error;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : error;
    }
    if (deps.now() - began >= FAST_FAILURE_MS) break;
    await deps.sleep(1000);
  }
  return error;
}

async function queueStage(paneId: string, s: SpawnState, deps: SpawnDeps): Promise<string | null> {
  const id = crypto.randomUUID();
  const deadline = deps.now() + QUEUE_WAIT_MS;
  let last = "The agent did not become ready in time.";
  while (deps.now() < deadline) {
    try {
      const page = await deps.fetchMessageQueue(paneId, s.session);
      if (page.available) {
        const next = await deps.changeMessageQueue(paneId, { scope: page.scope, action: "add", id, text: s.message }, s.session);
        if (next.available) return null;
      }
    } catch (cause) {
      last = cause instanceof Error ? cause.message : last;
    }
    await deps.sleep(QUEUE_POLL_MS);
  }
  return last;
}

/** Run (or resume at the stage that failed) the start and first-message steps for a pane. */
export async function runSpawn(paneId: string, deps: SpawnDeps = liveDeps): Promise<void> {
  let s = states.get(paneId);
  if (!s || s.phase === "done" || running.has(paneId)) return;
  running.add(paneId);
  try {
    await advance(paneId, s, deps);
  } finally {
    running.delete(paneId);
  }
}

async function advance(paneId: string, s: SpawnState, deps: SpawnDeps): Promise<void> {
  const stages: SpawnStage[] = s.stage === "start" ? (s.message ? ["start", "queue"] : ["start"]) : ["queue"];
  for (const stage of stages) {
    s = { ...s, stage, phase: "working", error: undefined };
    set(paneId, s);
    const error = await (stage === "start" ? startStage : queueStage)(paneId, s, deps);
    if (error) return set(paneId, { ...s, phase: "error", error });
  }
  set(paneId, { ...s, phase: "done" });
}

// ── Submit ────────────────────────────────────────────────────────────────────────────────────
export type SpawnResult = Extract<CreateResponse, { ok: true }> | { ok: false; error: string };

/** Create the tab or workspace. On success the launch continues in the background for the pane. */
export async function spawn(input: SpawnInput, deps: SpawnDeps = liveDeps): Promise<SpawnResult> {
  const label = input.name.trim() || undefined;
  const cwd = input.cwd.trim() || undefined;
  const created =
    input.target.kind === "tab"
      ? await api.createTab(input.target.workspaceId, { label, cwd }, input.session)
      : await api.createWorkspace({ label, cwd }, input.session);
  if (!created.ok) return created;
  // The name labels the tab or workspace; it also names the chat itself, which is what the sidebar
  // and the chat header show. A failed rename only leaves the default name.
  if (label) void api.renamePane(created.pane.paneId, label, input.session).catch(() => undefined);
  saveAgent(input.agent);
  if (cwd) rememberDir(cwd);
  if (input.agent !== "shell") {
    savePermission(input.agent, input.permission);
    set(created.pane.paneId, { agent: input.agent, permission: input.permission, stage: "start", phase: "working", message: input.message.trim(), session: input.session });
    void runSpawn(created.pane.paneId, deps);
  }
  return created;
}

// ── Sheet request ─────────────────────────────────────────────────────────────────────────────
// Which create sheet is open (if any). A tiny store so the tab "+" in any pane or space can open
// the one sheet mounted at the app root, without threading state through every parent.
let request: SpawnTarget | null = null;
const requestListeners = new Set<() => void>();
export function openNewAgent(target: SpawnTarget | null): void {
  request = target;
  for (const fn of requestListeners) fn();
}
export function useNewAgentRequest(): SpawnTarget | null {
  return useSyncExternalStore(
    (fn) => (requestListeners.add(fn), () => void requestListeners.delete(fn)),
    () => request,
  );
}
