import { basename, dirname, join } from "node:path";
import { CodexTurnTracker } from "./journal/turns.ts";
import { object as record } from "./subagent-files.ts";
import type { TurnState } from "./types.ts";

// The CLIs' own state, decoded (ADR 0067). Pure: the service in agent-state.ts owns files and
// watchers. Every shape here was measured on Claude Code 2.1.295/2.1.296 and Codex 0.162.1; an
// unknown shape decodes to null and the caller falls back to the screen.

// ── Claude: ~/.claude/sessions/<pid>.json ────────────────────────────────────────────────────────

/** The statuses Claude writes (2.1.296: `status:h.isLoading||h.delegatedActive?"busy":"idle"`, plus
 *  `waiting` for a dialog and `shell` for idle with a background shell). Anything else is a format
 *  this reader does not know. */
const CLAUDE_STATUSES = new Set(["idle", "busy", "waiting", "shell"] as const);
export type ClaudeStatus = "idle" | "busy" | "waiting" | "shell";

export interface ClaudeSessionFile {
  pid: number;
  sessionId: string;
  status: ClaudeStatus;
  /** Set with `waiting`: "permission prompt", "input needed", "dialog open", … */
  waitingFor?: string;
  /** Epoch ms of the last status change: the start of the current busy spell. */
  statusUpdatedAt: number;
  version?: string;
  /** When the owning process started, to tell a reused pid from the session's own: see {@link sameProcStart}. */
  procStart?: string;
}

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Decode one session file for `pid`. Null for a file of another shape, kind or pid. */
export function decodeClaudeSession(text: string, pid: number): ClaudeSessionFile | null {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return null; }
  const row = record(raw);
  const status = row.status;
  if (row.pid !== pid || typeof row.sessionId !== "string" || !SESSION_ID.test(row.sessionId)) return null;
  if (typeof status !== "string" || !CLAUDE_STATUSES.has(status as ClaudeStatus)) return null;
  if (row.kind !== undefined && row.kind !== "interactive") return null;
  if (typeof row.statusUpdatedAt !== "number" || !Number.isFinite(row.statusUpdatedAt)) return null;
  const waitingFor = typeof row.waitingFor === "string" && row.waitingFor.trim() ? row.waitingFor.trim().slice(0, 80) : undefined;
  return {
    pid,
    sessionId: row.sessionId,
    status: status as ClaudeStatus,
    statusUpdatedAt: row.statusUpdatedAt,
    ...(waitingFor ? { waitingFor } : {}),
    ...(typeof row.version === "string" ? { version: row.version.slice(0, 40) } : {}),
    ...(typeof row.procStart === "string" ? { procStart: row.procStart } : {}),
  };
}

/**
 * Claude on Linux writes `procStart` as the process's start in clock ticks since boot, field 22 of
 * `/proc/<pid>/stat` (measured 2.1.308–2.1.310, fixture from 2.1.310: "73776502"); on macOS in `ps -o lstart` form.
 */
export const procStartTicks = (procStart: string) => /^\d+$/.test(procStart.trim());

/**
 * Whether a `procStart` in `ps -o lstart` form names the process that started at `startedMs`. Claude
 * 2.1.296 writes it in UTC (measured: "Sun Oct 11 12:56:04 2026" for a process `ps` shows at 14:56:04
 * local), so both readings are tried; one second of slack covers the rounding.
 */
export function sameProcStart(procStart: string, startedMs: number): boolean {
  const text = procStart.trim().replace(/\s+/g, " ");
  return [Date.parse(`${text} UTC`), Date.parse(text)].some((at) => Number.isFinite(at) && Math.abs(at - startedMs) <= 1_500);
}

/** Field 22 (start ticks) of a `/proc/<pid>/stat` line. Field 2, the command name, may hold spaces and
 *  parentheses, so fields are counted after its last `)`. */
export function statStartTicks(stat: string): string | null {
  const ticks = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/)[19];
  return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : null;
}

/** Each Claude profile's sessions folder, next to the projects folder the journal reads. */
export function claudeSessionDirs(projectRoots: readonly string[]): string[] {
  return [...new Set(projectRoots.map((root) => join(dirname(root), "sessions")))];
}

/**
 * Claude's transcript, reduced to what says whether the main turn is over: when the conversation last
 * moved (a typed prompt, an assistant row) and when a turn last ended (an assistant row that stopped
 * with `end_turn`, `turn_duration`, `stop_hook_summary`, an interruption row), plus Claude's own queue
 * replayed from its `queue-operation` rows. Sidechains (subagents) are not the main turn and are
 * skipped. The `end_turn` row matters: 2.1.296 holds `turn_duration` back while teammates or detached
 * tool calls still run (`_deferSwarmDuration`, `_holdDurationForDetachedToolCalls`, read in code),
 * but the main chain's last assistant row is written either way.
 */
export class ClaudeTurnScan {
  lastMove = -Infinity;
  lastEnd = -Infinity;
  /** When a real reply last came through: an assistant row that is no API error and not Claude's own. */
  lastReply = -Infinity;
  /** The usage limit that refused the latest request, until a reply came through after it. */
  limit: { at: number; resetsAt: number } | undefined;
  private fifo: { content: string; notice: boolean }[] = [];

  line(text: string): void {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return; }
    const row = record(raw);
    if (row.isSidechain === true) return;
    const at = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : NaN;
    if (row.type === "queue-operation") return this.queue(row);
    if (!Number.isFinite(at)) return;
    if (row.type === "system" && (row.subtype === "turn_duration" || row.subtype === "stop_hook_summary")) {
      this.lastEnd = Math.max(this.lastEnd, at);
    } else if (row.type === "assistant") {
      this.lastMove = Math.max(this.lastMove, at);
      if (record(row.message).stop_reason === "end_turn") this.lastEnd = Math.max(this.lastEnd, at);
      if (row.apiError === "usage_limit_reached") {
        const resetsAt = limitResetsAt(row);
        if (resetsAt !== null && at >= (this.limit?.at ?? -Infinity)) this.limit = { at, resetsAt };
      } else if (row.isApiErrorMessage !== true && record(row.message).model !== "<synthetic>") {
        // Claude's own rows ("No response requested.", around a resume) carry no reply from the account.
        this.lastReply = Math.max(this.lastReply, at);
        if (this.limit && at > this.limit.at) this.limit = undefined;
      }
    } else if (row.type === "user" && row.isMeta !== true && row.isCompactSummary !== true) {
      const said = userText(record(row.message).content);
      if (INTERRUPTED.test(said)) this.lastEnd = Math.max(this.lastEnd, at);
      // A notification row can land after the turn ended without starting another (measured): a turn
      // it does start shows in the assistant rows that follow.
      else if (said && !NOTICE.test(said)) this.lastMove = Math.max(this.lastMove, at);
    }
  }

  /** Messages the operator queued in Claude that it has not read yet. Notifications are not counted. */
  get queued(): number {
    return this.fifo.filter((item) => !item.notice).length;
  }

  private queue(row: Record<string, unknown>): void {
    const content = typeof row.content === "string" ? row.content.trim() : "";
    switch (row.operation) {
      case "enqueue":
        this.fifo.push({ content, notice: NOTICE.test(content) });
        // A tail that missed the matching dequeues must not grow without bound.
        if (this.fifo.length > MAX_QUEUED) this.fifo.shift();
        break;
      case "dequeue": this.fifo.shift(); break;
      case "remove": {
        const at = this.fifo.findIndex((item) => item.content === content);
        if (at >= 0) this.fifo.splice(at, 1);
        break;
      }
      case "popAll": this.fifo.length = 0; break;
    }
  }
}

/**
 * When the limit on a `usage_limit_reached` row resets, in epoch ms. Claude 2.1.306 writes it twice,
 * in seconds: `quotaLimits.resetsAt` and `apiErrorParams.rate_limit_info.resetsAt` (measured).
 */
function limitResetsAt(row: Record<string, unknown>): number | null {
  const seconds = record(row.quotaLimits).resetsAt ?? record(record(row.apiErrorParams).rate_limit_info).resetsAt;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds > 1e9 ? seconds * 1000 : null;
}

const MAX_QUEUED = 64;
/** "[Request interrupted by user]" and "[Request interrupted by user for tool use]" (measured). */
const INTERRUPTED = /^\[Request interrupted by user\b/;
/** Queue rows Claude itself adds for finished tasks and background agents, never the operator's. */
const NOTICE = /^<(task-notification|agent-message)\b/;

function userText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content.map((block) => {
    const b = record(block);
    return b.type === "text" && typeof b.text === "string" ? b.text : "";
  }).join("").trim();
}

/**
 * Claude's turn from its session file and, while busy, its transcript (ADR 0067). `busy` alone is not
 * a running turn: delegated work (a background agent or workflow) keeps it busy after the main turn
 * ended, and Escape then does nothing (measured 2.1.296). So a busy session whose transcript ended a
 * turn inside this busy spell, and has not moved since, is background work only. `busySince` is when
 * the spell began; it defaults to the file's last status change, which a dialog answered mid-spell
 * moves (waiting → busy), so the service passes the spell's real start when it saw one.
 */
export function claudeTurn(
  file: ClaudeSessionFile,
  scan: Pick<ClaudeTurnScan, "lastMove" | "lastEnd" | "queued"> | null,
  busySince = file.statusUpdatedAt,
  limit?: TurnState["limit"],
): TurnState {
  const source = "claude-session" as const;
  if (file.waitingFor || file.status === "waiting") return { running: false, waiting: file.waitingFor ?? "dialog open", source };
  // Only a Claude at rest is held by its limit: a turn that runs got through.
  const held = limit ? { limit } : {};
  if (file.status === "idle") return { running: false, ...held, source };
  if (file.status === "shell") return { running: false, background: true, ...held, source };
  if (scan && scan.lastEnd >= busySince && scan.lastEnd >= scan.lastMove) return { running: false, background: true, source };
  return { running: true, ...(scan ? { queued: scan.queued > 0 ? "sends" as const : null } : {}), source };
}

/**
 * Whether Claude's usage limit still holds it (ADR 0120): its transcript's latest request was refused
 * by the limit, the reset has not passed, and no Claude of the same profile (one account) has had a
 * reply since, which is how a switched account shows. `replied` is that profile's latest reply.
 */
export function claudeLimit(scan: Pick<ClaudeTurnScan, "limit"> | null, replied: number, now: number): TurnState["limit"] {
  const limit = scan?.limit;
  if (!limit || limit.at <= replied || now >= limit.resetsAt) return undefined;
  return { resetsAt: limit.resetsAt };
}

// ── Codex: the rollout JSONL ────────────────────────────────────────────────────────────────────

/**
 * Codex's open turn from its rollout: `task_started` opens it, `task_complete` or `turn_aborted` with
 * the same turn id closes it, and nothing else reopens it (a background command finishing after an
 * abort appends `item_completed` under the old id, measured). `known` stays false until a turn row
 * was seen, because a tail that starts mid-turn cannot tell an idle thread from a long turn.
 */
export class CodexTurnScan {
  private readonly tracker = new CodexTurnTracker();
  known = false;
  line(text: string): void {
    let raw: unknown;
    try { raw = JSON.parse(text); } catch { return; }
    const row = record(raw);
    const kind = record(row.payload).type;
    if (row.type === "event_msg" && (kind === "task_started" || kind === "task_complete" || kind === "turn_aborted")) this.known = true;
    this.tracker.observe(row);
  }
  get open(): string | undefined {
    return this.tracker.openTurn();
  }
}

export function codexTurn(scan: CodexTurnScan): TurnState | null {
  if (!scan.known) return null;
  return { running: scan.open !== undefined, source: "codex-rollout" };
}

const ROLLOUT = /^rollout-.+-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

/**
 * The rollout a Codex process writes now, among the files it holds open. After `/new` the process
 * keeps the old rollout open too (measured 0.162.1), so the newest thread wins: thread ids are
 * UUIDv7 and sort by creation time.
 */
export function newestRollout(paths: readonly string[]): string | null {
  let best: { path: string; id: string } | null = null;
  for (const path of paths) {
    const id = ROLLOUT.exec(basename(path))?.[1]?.toLowerCase();
    if (id && (!best || id > best.id)) best = { path, id };
  }
  return best?.path ?? null;
}

/** Positive pids of a pane's foreground processes, from Herdr's `pane.process_info`. */
export function foregroundPids(info: unknown): number[] {
  const row = record(info);
  const pids = new Set<number>();
  const processes = Array.isArray(row.foreground_processes) ? row.foreground_processes : [];
  for (const value of processes) {
    const pid = record(value).pid;
    if (typeof pid === "number" && Number.isSafeInteger(pid) && pid > 0) pids.add(pid);
  }
  const group = row.foreground_process_group_id;
  if (typeof group === "number" && Number.isSafeInteger(group) && group > 0) pids.add(group);
  return [...pids];
}
