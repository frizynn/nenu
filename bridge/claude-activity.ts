import { constants, watch as fsWatch, type FSWatcher } from "node:fs";
import { lstat, open, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { containedRealpath } from "./journal/files.ts";
import { readAppended, type TailState } from "./journal/lines.ts";
import { isSessionId } from "./journal/claude.ts";
import { computeEtag } from "./http-cache.ts";
import { isAgentId, object, shortText } from "./subagent-files.ts";

// Background work of one Claude Code session: workflows, background commands and published
// artifacts. Claude Code keeps no single index of these, so this rebuilds one from internal,
// undocumented files (measured on 2.1.296; every field is optional and unknown ones are ignored):
//   <project>/<session>.jsonl                          launches, task notifications, Artifact results
//   <project>/<session>/subagents/workflows/<run>/     journal.jsonl + agent-<id>.{jsonl,meta.json}
//   <project>/<session>/workflows/<run>.json           run summary, written once the run ends
//   <claude tmp>/<project>/<session>/tasks/<id>.output background command output
// Append-only files are tailed by byte offset; every path is built from a validated id and
// re-checked against its root after symlinks resolve. The client only ever names a pane.

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
  /** What a running agent is doing now: "Bash · Run the tests". */
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
  /** Newest write seen for the run; a running run that stays quiet may have been killed. */
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
  /** `unknown`: no completion notice and no output for a while; nothing on disk records a kill. */
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

const MAX_LOG_BYTES = 16 * 1024 * 1024;
const MAX_JOURNAL_BYTES = 8 * 1024 * 1024;
const MAX_SUMMARY_BYTES = 4 * 1024 * 1024;
const AGENT_TAIL_BYTES = 64 * 1024;
const TASK_OUTPUT_BYTES = 16 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
const MAX_RUNS = 30;
const MAX_AGENTS = 200;
const MAX_TASKS = 100;
const MAX_ARTIFACTS = 50;
const QUIET_TASK_MS = 10 * 60_000;
/** Notice statuses for work that did not finish; `stopped` is a command cut off by a session end. */
const ENDED_BADLY = new Set(["failed", "killed", "stopped", "error", "cancelled"]);
const RUN_ID = /^wf_[A-Za-z0-9-]{1,64}$/;
const TASK_ID = /^[a-z0-9]{6,32}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown, cap = 200): string | undefined => typeof v === "string" && v ? v.slice(0, cap) : undefined;
const num = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) ? v : undefined;
const time = (v: unknown): number | undefined => {
  const at = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(at) ? at : undefined;
};
const parse = (line: string): Record<string, unknown> | null => {
  try { const v: unknown = JSON.parse(line); return isRecord(v) ? v : null; } catch { return null; }
};
const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'" };
const unescapeXml = (s: string) => s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e: string) => ENTITIES[e]!);

/** Inner text of `<tag>` in a task notification, never looking inside its (possibly huge) result. */
function tag(xml: string, name: string): string | undefined {
  const open = xml.indexOf(`<${name}>`);
  if (open < 0) return undefined;
  const close = xml.indexOf(`</${name}>`, open);
  return close < 0 ? undefined : unescapeXml(xml.slice(open + name.length + 2, close).trim());
}

export interface TaskNotification { taskId: string; toolUseId?: string; status?: string; summary: string; event?: string; at?: number }

/** The fields of one `<task-notification>`, with `<result>` cut off before any tag is searched. */
export function parseTaskNotification(content: string, at?: number): TaskNotification | null {
  const cut = content.indexOf("<result>");
  const xml = cut < 0 ? content : content.slice(0, cut) + content.slice(content.indexOf("</result>", cut) + 9);
  const taskId = tag(xml, "task-id");
  if (!taskId || !TASK_ID.test(taskId)) return null;
  return { taskId, toolUseId: tag(xml, "tool-use-id"), status: tag(xml, "status"), summary: tag(xml, "summary") ?? "", event: tag(xml, "event")?.slice(0, 200), at };
}

/** Kind, title and exit code from a notification summary such as `Background command "x" failed with exit code 2`. */
export function describeTask(summary: string): { kind: ActivityTaskKind | "workflow"; title: string; exitCode?: number } {
  const exit = summary.match(/exit code (-?\d+)\)?$/);
  const exitCode = exit ? Number(exit[1]) : undefined;
  const forms: [ActivityTaskKind | "workflow", RegExp][] = [
    ["bash", /^Background command "([\s\S]*)" (?:completed|failed|was stopped|killed)/],
    ["monitor", /^Monitor(?: event:)? "([\s\S]*)"/],
    ["workflow", /^Dynamic workflow "([\s\S]*)" /],
    ["agent", /^Agent "([\s\S]*)" /],
  ];
  for (const [kind, re] of forms) {
    const m = summary.match(re);
    if (m) return { kind, title: m[1]!.slice(0, 300), exitCode };
  }
  return { kind: "other", title: summary.slice(0, 300), exitCode };
}

/** A one-line preview of an agent's return value, generic over whatever shape a script returns. */
export function resultPreview(result: unknown): string | undefined {
  if (typeof result === "string") return shortText(result.trim(), 160) || undefined;
  if (!isRecord(result)) return undefined;
  const parts: string[] = [];
  for (const key of ["status", "verdict"]) if (typeof result[key] === "string") { parts.push(shortText(result[key], 60)); break; }
  for (const [key, value] of Object.entries(result)) {
    if (Array.isArray(value) && value.length) parts.push(`${value.length} ${key.replace(/_/g, " ")}`);
    if (parts.length >= 4) break;
  }
  if (!parts.length && typeof result.summary === "string") parts.push(shortText(result.summary, 160));
  return parts.join(" · ") || undefined;
}

// ── Byte-offset tail of append-only files ──────────────────────────────────────────────────────

async function readBounded(path: string, cap: number, fromEnd = false): Promise<{ text: string; truncated: boolean; mtime: number } | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
  if (!file) return null;
  try {
    const st = await file.stat();
    if (!st.isFile()) return null;
    const start = fromEnd ? Math.max(0, st.size - cap) : 0;
    const buf = Buffer.alloc(Math.min(cap, st.size - start));
    const { bytesRead } = await file.read(buf, 0, buf.length, start);
    return { text: buf.subarray(0, bytesRead).toString("utf8"), truncated: st.size > cap, mtime: st.mtimeMs };
  } finally { await file.close(); }
}

// ── Per-session index built from the main log ──────────────────────────────────────────────────

interface Launch { runId?: string; name?: string; summary?: string; at?: number }
interface SessionIndex {
  launches: Map<string, Launch>; // by task id
  notifications: Map<string, TaskNotification>;
  /** Background commands launched by this session itself: task id → "Run the tests". */
  bgTitles: Map<string, string>;
  toolUses: Map<string, { name: string; description?: string }>;
  artifacts: Map<string, ActivityArtifact>;
  truncated: boolean;
  tail?: TailState;
}
const emptyIndex = (): SessionIndex => ({ launches: new Map(), notifications: new Map(), bgTitles: new Map(), toolUses: new Map(), artifacts: new Map(), truncated: false });
// Only these lines can matter, so everything else (most of a long log) is never JSON-parsed.
const LOG_MARKERS = ['"queue-operation"', "task-notification", '"async_launched"', '"artifact_id"', '"run_in_background":true', '"name":"Monitor"', "running in background with ID:", "Monitor started (task "];

function bounded<K, V>(map: Map<K, V>, key: K, value: V, cap: number): void {
  map.delete(key);
  map.set(key, value);
  if (map.size > cap) map.delete(map.keys().next().value!);
}

export function indexLogLine(index: SessionIndex, line: string): void {
  if (!LOG_MARKERS.some((m) => line.includes(m))) return;
  const row = parse(line);
  if (!row) return;
  const at = time(row.timestamp);
  if (row.type === "queue-operation" && row.operation === "enqueue" && typeof row.content === "string") {
    const n = parseTaskNotification(row.content, at);
    if (n) bounded(index.notifications, n.taskId, n, 1000);
    return;
  }
  const message = object(row.message);
  if (row.type === "user" && typeof message.content === "string" && object(row.origin).kind === "task-notification") {
    const n = parseTaskNotification(message.content, at);
    if (n && !index.notifications.has(n.taskId)) bounded(index.notifications, n.taskId, n, 1000);
    return;
  }
  const result = object(row.toolUseResult);
  if (result.status === "async_launched" && typeof result.taskId === "string" && TASK_ID.test(result.taskId)) {
    const runId = typeof result.runId === "string" && RUN_ID.test(result.runId) ? result.runId : undefined;
    bounded(index.launches, result.taskId, { runId, name: str(result.workflowName, 120) ?? str(result.description, 120), summary: str(result.summary, 400), at }, 500);
  }
  if (typeof result.artifact_id === "string" && typeof result.url === "string" && /^https:\/\/claude\.ai\//.test(result.url)) {
    // Rows are chronological, so a later publish of the same artifact is its newer version.
    const id = result.artifact_id.slice(0, 128);
    bounded(index.artifacts, id, { id, url: result.url.slice(0, 500), title: str(result.title, 200) ?? "Artifact", icon: str(result.icon, 40), version: str(result.version, 60), at }, MAX_ARTIFACTS);
  }
  if (!Array.isArray(message.content)) return;
  for (const part of message.content) {
    if (!isRecord(part)) continue;
    if (part.type === "tool_use" && typeof part.id === "string" && (part.name === "Bash" || part.name === "Monitor")) {
      bounded(index.toolUses, part.id, { name: part.name, description: str(object(part.input).description, 300) }, 512);
    } else if (part.type === "tool_result" && typeof part.tool_use_id === "string") {
      const text = typeof part.content === "string" ? part.content : Array.isArray(part.content) ? part.content.map((c) => str(object(c).text, 400) ?? "").join("") : "";
      const id = text.match(/running in background with ID: ([a-z0-9]+)/)?.[1] ?? text.match(/^Monitor started \(task ([a-z0-9]+)/)?.[1];
      const use = index.toolUses.get(part.tool_use_id);
      if (id && use) bounded(index.bgTitles, id, use.description ?? use.name, 500);
    }
  }
}

// ── Workflow runs ──────────────────────────────────────────────────────────────────────────────

interface RunJournal { started: Map<string, { label: string; phase: string }>; results: Map<string, string | undefined>; mtime: number; truncated: boolean; tail?: TailState }

/** Fold journal rows into a run: who started in which phase, and who returned. */
export function indexJournalLine(run: RunJournal, line: string): void {
  const row = parse(line);
  if (!row || typeof row.agentId !== "string" || !isAgentId(row.agentId)) return;
  if (row.type === "started" && run.started.size < MAX_AGENTS) {
    run.started.set(row.agentId, { label: str(row.label, 120) ?? row.agentId, phase: str(row.phase, 80) ?? "" });
  } else if (row.type === "result") run.results.set(row.agentId, resultPreview(row.result));
}

interface Summary {
  status?: string; name?: string; summary?: string; taskId?: string; startedAt?: number; durationMs?: number;
  totalTokens?: number; totalToolCalls?: number; phases: string[]; agents: Map<string, ActivityAgent>;
}

export function parseRunSummary(value: unknown): Summary | null {
  if (!isRecord(value)) return null;
  const agents = new Map<string, ActivityAgent>();
  const progress = Array.isArray(value.workflowProgress) ? value.workflowProgress : [];
  for (const item of progress) {
    if (!isRecord(item) || item.type !== "workflow_agent" || typeof item.agentId !== "string" || !isAgentId(item.agentId)) continue;
    if (agents.size >= MAX_AGENTS) break;
    const state = item.state === "failed" || item.state === "error" ? "failed" : item.state === "done" || item.state === "completed" ? "done" : "running";
    agents.set(item.agentId, {
      id: item.agentId, label: str(item.label, 120) ?? item.agentId, phase: str(item.phaseTitle, 80) ?? "", state,
      model: str(item.model, 80), startedAt: num(item.startedAt), durationMs: num(item.durationMs), tokens: num(item.tokens),
      toolCalls: num(item.toolCalls), resultPreview: str(item.resultPreview, 160),
    });
  }
  const phases = (Array.isArray(value.phases) ? value.phases : []).flatMap((p) => str(object(p).title, 80) ?? []);
  return {
    status: str(value.status, 20), name: str(value.workflowName, 120), summary: str(value.summary, 400), taskId: str(value.taskId, 32),
    startedAt: num(value.startTime), durationMs: num(value.durationMs), totalTokens: num(value.totalTokens),
    totalToolCalls: num(value.totalToolCalls), phases, agents,
  };
}

/** The last tool a transcript tail shows the agent calling, as "Bash · Run the tests". */
export function lastToolFromTail(text: string): string | undefined {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.includes('"tool_use"')) continue;
    const row = parse(lines[i]!);
    const content = object(row?.message).content;
    if (row?.type !== "assistant" || !Array.isArray(content)) continue;
    const use = content.findLast((c) => isRecord(c) && c.type === "tool_use");
    if (!isRecord(use) || typeof use.name !== "string") continue;
    const input = object(use.input);
    const what = str(input.description, 120) ?? (typeof input.file_path === "string" ? basename(input.file_path) : undefined);
    return what ? `${use.name.slice(0, 40)} · ${what}` : use.name.slice(0, 40);
  }
  return undefined;
}

// ── The reader ─────────────────────────────────────────────────────────────────────────────────

interface Location { root: string; log: string; dir: string; project: string }
interface Cached<T> { key: string; value: T }

export interface ClaudeActivityOptions {
  /** Claude Code's private temp dirs, `<tmp>/claude-<uid>`; the first that exists holds `tasks/`. */
  tasksBases?: readonly string[];
  now?: () => number;
  watch?: (path: string, recursive: boolean, onEvent: () => void) => { close(): void } | null;
  /** How long a session stays watched after its last read. */
  watchTtlMs?: number;
  debounceMs?: number;
}

export function defaultTasksBases(env: NodeJS.ProcessEnv = process.env, uid = process.getuid?.() ?? 0): string[] {
  const name = `claude-${uid}`;
  return [...(env.CLAUDE_CODE_TMPDIR ? [join(env.CLAUDE_CODE_TMPDIR, name)] : []), join("/tmp", name)];
}

function nodeWatch(path: string, recursive: boolean, onEvent: () => void): { close(): void } | null {
  try {
    const w: FSWatcher = fsWatch(path, { recursive, persistent: false }, () => onEvent());
    w.on("error", () => w.close());
    return w;
  } catch { return null; }
}

interface Watched {
  paths: string[]; watchers: { close(): void }[]; expires: number; listeners: Map<string, () => void>;
  debounce?: ReturnType<typeof setTimeout>; ttl?: ReturnType<typeof setTimeout>; digest?: string;
}

export class ClaudeActivity {
  private locations = new Map<string, Location>();
  private indexes = new Map<string, SessionIndex>();
  private journals = new Map<string, RunJournal>();
  private summaries = new Map<string, Cached<Summary | null>>();
  private watched = new Map<string, Watched>();
  private readonly tasksBases: readonly string[];
  private readonly now: () => number;
  private readonly watchFn: NonNullable<ClaudeActivityOptions["watch"]>;
  private readonly watchTtlMs: number;
  private readonly debounceMs: number;

  constructor(private roots: readonly string[], options: ClaudeActivityOptions = {}) {
    this.tasksBases = options.tasksBases ?? defaultTasksBases();
    this.now = options.now ?? Date.now;
    this.watchFn = options.watch ?? nodeWatch;
    this.watchTtlMs = options.watchTtlMs ?? 90_000;
    this.debounceMs = options.debounceMs ?? 400;
  }

  static sessionKey(sessionId: string): string { return computeEtag(JSON.stringify(["claude-activity", sessionId])); }

  private async locate(sessionId: string): Promise<Location | null> {
    if (!isSessionId(sessionId)) return null;
    const cached = this.locations.get(sessionId);
    if (cached && (await containedRealpath(cached.log, cached.root)) === cached.log) return cached;
    for (const root of this.roots) {
      for (const project of await readdir(root).catch(() => [] as string[])) {
        const log = await containedRealpath(join(root, project, `${sessionId}.jsonl`), root);
        if (!log || !(await stat(log).then((s) => s.isFile(), () => false))) continue;
        const location = { root, log, dir: join(dirname(log), sessionId), project: basename(dirname(log)) };
        bounded(this.locations, sessionId, location, 32);
        return location;
      }
    }
    return null;
  }

  /**
   * A path under the session dir, only if nothing on the way is a symlink: `loc.dir` is built from
   * the resolved log, so any link (the session dir itself included) changes the resolved path.
   */
  private async sessionPath(loc: Location, ...parts: string[]): Promise<string | null> {
    const path = join(loc.dir, ...parts);
    return (await containedRealpath(path, loc.root)) === path ? path : null;
  }

  private async tasksDir(sessionId: string, loc: Location): Promise<string | null> {
    for (const base of this.tasksBases) {
      const dir = await containedRealpath(join(base, loc.project, sessionId, "tasks"), base);
      if (dir) return dir;
    }
    return null;
  }

  private async index(sessionId: string, loc: Location): Promise<SessionIndex> {
    let index = this.indexes.get(sessionId) ?? emptyIndex();
    const read = await readAppended(loc.log, MAX_LOG_BYTES, index.tail);
    if (read.reset) index = emptyIndex();
    index.tail = read.tail;
    index.truncated ||= read.truncated;
    for (const line of read.lines) indexLogLine(index, line);
    bounded(this.indexes, sessionId, index, 16);
    return index;
  }

  private async summary(path: string): Promise<Summary | null> {
    const st = await stat(path).catch(() => null);
    if (!st?.isFile()) return null;
    const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
    const cached = this.summaries.get(path);
    if (cached?.key === key) return cached.value;
    const file = await readBounded(path, MAX_SUMMARY_BYTES);
    let value: Summary | null = null;
    if (file && !file.truncated) try { value = parseRunSummary(JSON.parse(file.text)); } catch { /* still being written */ }
    bounded(this.summaries, path, { key, value }, 64);
    return value;
  }

  private async journal(path: string): Promise<RunJournal | null> {
    let run = this.journals.get(path);
    const read = await readAppended(path, MAX_JOURNAL_BYTES, run?.tail).catch(() => null);
    if (!read) return null;
    if (!run || read.reset) run = { started: new Map(), results: new Map(), mtime: 0, truncated: false };
    run.tail = read.tail;
    run.mtime = read.mtime;
    run.truncated ||= read.truncated;
    for (const line of read.lines) indexJournalLine(run, line);
    bounded(this.journals, path, run, 64);
    return run;
  }

  private async run(loc: Location, runId: string, launch: Launch | undefined, taskId: string | undefined, index: SessionIndex): Promise<[ActivityWorkflow, boolean]> {
    const runDir = await this.sessionPath(loc, "subagents", "workflows", runId);
    const summaryPath = await this.sessionPath(loc, "workflows", `${runId}.json`);
    const summary = summaryPath ? await this.summary(summaryPath) : null;
    const journal = runDir ? await this.journal(join(runDir, "journal.jsonl")) : null;
    taskId ??= summary?.taskId;
    const notice = taskId ? index.notifications.get(taskId) : undefined;
    const agents = new Map(summary?.agents);
    const finished = !!summary || !!notice;
    let updatedAt = journal?.mtime || undefined;
    for (const [id, start] of journal?.started ?? []) {
      if (agents.has(id) || agents.size >= MAX_AGENTS) continue;
      const done = journal!.results.has(id);
      // An agent that never returned from a finished run was stopped or superseded by a retry.
      const state = done ? "done" : finished ? "failed" : "running";
      const agent: ActivityAgent = { id, label: start.label, phase: start.phase, state, resultPreview: journal!.results.get(id) };
      const files = runDir ? await this.agentFiles(runDir, id, state === "running") : null;
      if (files) {
        agent.startedAt = files.startedAt;
        agent.updatedAt = files.updatedAt;
        agent.lastTool = files.lastTool;
        if (state !== "running" && files.startedAt && files.updatedAt) agent.durationMs = Math.max(0, files.updatedAt - files.startedAt);
        if (files.updatedAt && files.updatedAt > (updatedAt ?? 0)) updatedAt = files.updatedAt;
      }
      agents.set(id, agent);
    }
    const order = summary?.phases.length ? summary.phases : [];
    const phases: ActivityPhase[] = order.map((title) => ({ title, agents: [] }));
    for (const agent of agents.values()) {
      let phase = phases.find((p) => p.title === agent.phase);
      if (!phase) phases.push(phase = { title: agent.phase, agents: [] });
      phase.agents.push(agent);
    }
    const list = [...agents.values()];
    const ended = summary?.status ?? notice?.status;
    const status: ActivityWorkflowStatus = summary?.status === "completed" || notice?.status === "completed" ? "completed"
      : ended && ENDED_BADLY.has(ended) ? "failed"
        : finished ? "unknown" : "running";
    const startedAt = summary?.startedAt ?? launch?.at ?? list.reduce<number | undefined>((min, a) => a.startedAt && (!min || a.startedAt < min) ? a.startedAt : min, undefined);
    return [{
      runId, taskId, name: summary?.name ?? launch?.name ?? runId, summary: summary?.summary ?? launch?.summary, status, startedAt,
      durationMs: summary?.durationMs ?? (notice?.at && startedAt ? notice.at - startedAt : undefined), updatedAt,
      phases: phases.filter((p) => p.agents.length || order.includes(p.title)),
      agentCount: list.length, doneCount: list.filter((a) => a.state !== "running").length,
      totalTokens: summary?.totalTokens, totalToolCalls: summary?.totalToolCalls,
    }, !!journal?.truncated];
  }

  private async agentFiles(runDir: string, id: string, running: boolean): Promise<{ startedAt?: number; updatedAt?: number; lastTool?: string } | null> {
    if (!isAgentId(id)) return null;
    // The meta file is written once when the agent starts; the transcript grows until it ends.
    const meta = await containedRealpath(join(runDir, `agent-${id}.meta.json`), runDir);
    const log = await containedRealpath(join(runDir, `agent-${id}.jsonl`), runDir);
    const startedAt = meta ? await stat(meta).then((s) => s.mtimeMs, () => undefined) : undefined;
    if (!log) return { startedAt };
    if (!running) return { startedAt, updatedAt: await stat(log).then((s) => s.mtimeMs, () => undefined) };
    const tail = await readBounded(log, AGENT_TAIL_BYTES, true);
    return { startedAt, updatedAt: tail?.mtime, lastTool: tail ? lastToolFromTail(tail.text) : undefined };
  }

  private async runIds(loc: Location, index: SessionIndex): Promise<string[]> {
    const dir = await this.sessionPath(loc, "subagents", "workflows");
    const found = new Map<string, number>();
    for (const name of dir ? await readdir(dir).catch(() => [] as string[]) : []) {
      if (!RUN_ID.test(name)) continue;
      found.set(name, await stat(join(dir!, name)).then((s) => s.mtimeMs, () => 0));
    }
    for (const launch of index.launches.values()) if (launch.runId && !found.has(launch.runId)) found.set(launch.runId, launch.at ?? 0);
    return [...found].sort((a, b) => b[1] - a[1]).slice(0, MAX_RUNS).map(([id]) => id);
  }

  private async tasks(sessionId: string, loc: Location, index: SessionIndex): Promise<ActivityTask[]> {
    const tasks = new Map<string, ActivityTask>();
    for (const n of index.notifications.values()) {
      const described = describeTask(n.summary);
      if (described.kind === "workflow" || index.launches.get(n.taskId)?.runId) continue;
      tasks.set(n.taskId, {
        id: n.taskId, kind: described.kind, title: index.bgTitles.get(n.taskId) ?? described.title,
        // A monitor's event notices carry no status; any other status than completed did not finish.
        status: !n.status || n.status === "completed" ? "completed" : "failed",
        exitCode: described.exitCode, event: n.event, at: n.at, hasOutput: false,
      });
    }
    const dir = await this.tasksDir(sessionId, loc);
    for (const name of dir ? await readdir(dir).catch(() => [] as string[]) : []) {
      const id = name.match(/^([a-z0-9]{6,32})\.output$/)?.[1];
      if (!id || index.launches.get(id)?.runId) continue;
      const st = await lstat(join(dir!, name)).catch(() => null);
      // A symlink is a background Agent's transcript, which the subagents view already covers.
      if (!st?.isFile()) continue;
      const known = tasks.get(id);
      if (known) { known.hasOutput = st.size > 0; continue; }
      const title = index.bgTitles.get(id);
      const status = this.now() - st.mtimeMs < QUIET_TASK_MS ? "running" : "unknown";
      tasks.set(id, { id, kind: id.startsWith("b") ? "bash" : "other", title: title ?? `Background command ${id}`, status, at: st.mtimeMs, hasOutput: st.size > 0 });
    }
    return [...tasks.values()].sort((a, b) => (b.status === "running" ? 1 : 0) - (a.status === "running" ? 1 : 0) || (b.at ?? 0) - (a.at ?? 0)).slice(0, MAX_TASKS);
  }

  async list(sessionId: string): Promise<ActivityResponse> {
    const loc = await this.locate(sessionId);
    if (!loc) return { available: false, reason: "no-session" };
    const index = await this.index(sessionId, loc);
    const byRun = new Map<string, [string, Launch]>();
    for (const [taskId, launch] of index.launches) if (launch.runId) byRun.set(launch.runId, [taskId, launch]);
    const workflows: ActivityWorkflow[] = [];
    let truncated = index.truncated;
    for (const runId of await this.runIds(loc, index)) {
      const [taskId, launch] = byRun.get(runId) ?? [undefined, undefined];
      const [workflow, journalTruncated] = await this.run(loc, runId, launch, taskId, index);
      workflows.push(workflow);
      truncated ||= journalTruncated;
    }
    const artifacts = [...index.artifacts.values()].reverse();
    return { available: true, sessionKey: ClaudeActivity.sessionKey(sessionId), workflows, tasks: await this.tasks(sessionId, loc, index), artifacts, truncated };
  }

  /** One run with each finished agent's full return value (each capped), read only when opened. */
  async workflow(sessionId: string, runId: string): Promise<WorkflowDetailResponse | null> {
    if (!RUN_ID.test(runId)) return null;
    const listed = await this.list(sessionId);
    const workflow = listed.available ? listed.workflows.find((w) => w.runId === runId) : undefined;
    const loc = await this.locate(sessionId);
    if (!listed.available || !workflow || !loc) return null;
    const results: Record<string, unknown> = {};
    const runDir = await this.sessionPath(loc, "subagents", "workflows", runId);
    const journal = runDir ? await containedRealpath(join(runDir, "journal.jsonl"), runDir) : null;
    const file = journal ? await readBounded(journal, MAX_JOURNAL_BYTES, true) : null;
    for (const line of file?.text.split("\n") ?? []) {
      if (!line.startsWith('{"type":"result"')) continue;
      const row = parse(line);
      if (!row || typeof row.agentId !== "string" || !isAgentId(row.agentId)) continue;
      results[row.agentId] = line.length > MAX_RESULT_BYTES ? { truncated: true, preview: resultPreview(row.result) } : row.result;
    }
    return { sessionKey: listed.sessionKey, workflow, results };
  }

  /** The tail of one background command's output, by task id only. */
  async taskOutput(sessionId: string, taskId: string): Promise<TaskOutputResponse | null> {
    if (!TASK_ID.test(taskId)) return null;
    const loc = await this.locate(sessionId);
    const dir = loc ? await this.tasksDir(sessionId, loc) : null;
    if (!dir) return null;
    const path = await containedRealpath(join(dir, `${taskId}.output`), dir);
    if (path !== join(dir, `${taskId}.output`)) return null;
    const file = await readBounded(path, TASK_OUTPUT_BYTES, true);
    if (!file) return null;
    const text = file.truncated ? file.text.slice(file.text.indexOf("\n") + 1) : file.text;
    return { sessionKey: ClaudeActivity.sessionKey(sessionId), id: taskId, text, truncated: file.truncated, updatedAt: file.mtime };
  }

  /**
   * Keep this session watched for a while after a read and call `notify` (keyed so several panes
   * can share one session) when what {@link list} answers actually changed. Names only reach the
   * browser; it re-reads through the route. Losing an event costs one fallback poll.
   */
  async observe(sessionId: string, listenerKey: string, notify: () => void): Promise<void> {
    const loc = await this.locate(sessionId);
    if (!loc) return;
    // Only the runs directory nests (one folder per run); the others are flat.
    const runs = await this.sessionPath(loc, "subagents", "workflows");
    const paths = [loc.log, runs, await this.sessionPath(loc, "workflows"), await this.tasksDir(sessionId, loc)]
      .filter((p): p is string => !!p);
    // From here to `watched.set` nothing awaits, so overlapping calls share one entry.
    let entry = this.watched.get(sessionId);
    if (entry && entry.paths.join("\n") !== paths.join("\n")) { this.unwatch(sessionId); entry = undefined; }
    const created = !entry;
    if (!entry) {
      if (this.watched.size >= 8) this.unwatch(this.watched.keys().next().value!);
      const fresh: Watched = { paths, watchers: [], expires: 0, listeners: new Map() };
      const fire = () => {
        if (this.watched.get(sessionId) !== fresh) return;
        if (this.now() > fresh.expires) return this.unwatch(sessionId);
        clearTimeout(fresh.debounce);
        fresh.debounce = setTimeout(() => void this.changed(sessionId, fresh), this.debounceMs);
      };
      fresh.watchers = paths.flatMap((p) => this.watchFn(p, p === runs, fire) ?? []);
      entry = fresh;
    }
    // Re-inserted so the 8-session cap evicts the least recently read.
    this.watched.delete(sessionId);
    this.watched.set(sessionId, entry);
    entry.expires = this.now() + this.watchTtlMs;
    entry.listeners.set(listenerKey, notify);
    // A quiet session fires no event that could notice its own expiry.
    clearTimeout(entry.ttl);
    const armed = entry;
    entry.ttl = setTimeout(() => { if (this.watched.get(sessionId) === armed) this.unwatch(sessionId); }, this.watchTtlMs);
    entry.ttl.unref?.();
    if (created) entry.digest = await this.digest(sessionId);
  }

  private async digest(sessionId: string): Promise<string> {
    return computeEtag(JSON.stringify(await this.list(sessionId).catch(() => null)));
  }

  private async changed(sessionId: string, entry: Watched): Promise<void> {
    if (this.watched.get(sessionId) !== entry) return;
    const digest = await this.digest(sessionId);
    if (digest === entry.digest) return;
    entry.digest = digest;
    for (const notify of entry.listeners.values()) notify();
  }

  private unwatch(sessionId: string): void {
    const entry = this.watched.get(sessionId);
    if (!entry) return;
    clearTimeout(entry.debounce);
    clearTimeout(entry.ttl);
    for (const w of entry.watchers) w.close();
    this.watched.delete(sessionId);
  }

  close(): void { for (const id of [...this.watched.keys()]) this.unwatch(id); }
}
