// Claude Code's journal adapter.
//
// WHY THIS EXISTS. A pane running Claude sits on the terminal's ALTERNATE SCREEN, and the alternate
// screen has no scrollback ring — Herdr's terminal core (Ghostty) keeps nothing behind the viewport.
// Empirically: every claude pane reports `scroll.max_offset_from_bottom: 0`, and `pane.read` returns
// exactly `viewport_rows + 1` lines no matter how many you ask for (200, 600, 5000, 10000 — all 52).
// A plain bash pane on the primary screen, by contrast, reports 6895 and pages fine. So "load older"
// against a Claude pane can never work: the bytes were never retained. This is upstream terminal
// behaviour, not a Nenu bug and not a config knob.
//
// The history does exist, though — Claude Code writes every turn to its own session log at
// `~/.claude/projects/<mangled-cwd>/<session-uuid>.jsonl`, and Herdr hands us that uuid on the pane
// record (`agent_session.value`, kind `id`). It is strictly BETTER than terminal scrollback would
// have been: real message boundaries, timestamps, tool calls folded together with their results, and
// it survives the pane being closed.
//
// SHAPE OF THE SOURCE (verified against Claude Code 2.1.220, 2026-07-26):
//   {"type":"user",      "message":{"role":"user","content":"..." | [ {type:"tool_result",...} ]}, ...}
//   {"type":"assistant", "message":{"role":"assistant","content":[ {type:"text"|"thinking"|"tool_use"} ]}}
//   plus bookkeeping rows we ignore (mode, permission-mode, ai-title, file-history-*, queue-operation…).
// Human turns carry a STRING content; a `user` row whose content is a LIST is tool-result traffic,
// not something the user typed — we fold those into the tool call that produced them rather than
// rendering 705 fake "user" turns. `isSidechain` marks subagent traffic (dropped by default);
// `isCompactSummary` marks the summary Claude writes when a session is compacted; `isMeta` marks
// text written for the model rather than by the operator (verified against 2.1.296, see line()).

import { claudeUsageRow, parseClaudeUsage } from "./usage.ts";
import { ClaudeTurnTracker } from "./turns.ts";
import { askUserQuestions } from "./questions.ts";
import { feedText } from "./lines.ts";
import type { InteractionHint } from "../types.ts";
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { containedRealpath, exists, head, loadTail, readRange, rootList, statFile } from "./files.ts";
import { clamp, MAX_RESULT_CHARS, MAX_TEXT_CHARS, stripAnsi, summarizeToolInput } from "./text.ts";
import {
  MAX_QUEUE_EVENTS,
  type AgentSessionRef,
  type ImageLocator,
  type JournalAdapter,
  type JournalFacts,
  type JournalParser,
  type NativeQueueEvent,
  type SessionTelemetry,
  type ToolAttachment,
  type TranscriptEntry,
  type TranscriptPart,
  type TranscriptSource,
} from "./types.ts";

/** A session uuid as Claude writes it — canonical 8-4-4-4-12 hex. Anything else never touches fs. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Guard used before any path work. Exported so tests can pin the shape the fs layer relies on. */
export function isSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/** Inner text of the first `<tag>…</tag>`, trimmed; null when the tag isn't present. */
function inner(tag: string, text: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(text);
  return m ? (m[1] ?? "").trim() : null;
}

/** True when the content IS this envelope (rather than merely mentioning the tag in prose). */
function isEnvelope(tag: string, text: string): boolean {
  return text.trimStart().startsWith(`<${tag}>`);
}

/**
 * Classify a `user` row's string content.
 *
 * Only about half of these are things a human typed — Claude Code reuses the user role as the
 * carrier for injected plumbing. Measured across 60 session logs: 1196 string-content user rows, of
 * which 359 `task-notification`, 82 `local-command-caveat`, 82 `command-name`, 78
 * `local-command-stdout` and 21 `system-reminder` were envelopes rather than speech. Rendering those
 * verbatim as "You" would be actively wrong, so each is handled on its merits:
 *
 *  - `system-reminder` / `local-command-caveat` → DROPPED. Both are addressed to the model, never
 *    shown to the operator in the TUI (the caveat literally says "DO NOT respond to these").
 *  - `command-name` → a slash command the user really did run; shown as `/compact`, args included.
 *  - `local-command-stdout` → that command's output. Real, but not speech → a `note`.
 *  - `bash-input` / `bash-stdout` → the same pair for `!` shell mode: `! pwd`, then a `note`.
 *  - `task-notification` → a background agent finishing. Reduced to its `<summary>` line → a `note`.
 *
 * Returns null for "drop this row entirely".
 */
export function classifyUserText(
  raw: string,
): { role: "user" | "note"; text: string } | null {
  const text = stripAnsi(raw);

  if (isEnvelope("system-reminder", text)) return null;
  if (isEnvelope("local-command-caveat", text)) return null;

  // Newer versions lead a slash command with `<command-message>`; the command line is the same.
  if (isEnvelope("command-name", text) || isEnvelope("command-message", text)) {
    const name = inner("command-name", text) ?? "";
    const args = inner("command-args", text) ?? "";
    const line = `${name} ${args}`.trim();
    return line === "" ? null : { role: "user", text: line };
  }

  if (isEnvelope("local-command-stdout", text)) {
    const stdout = inner("local-command-stdout", text) ?? "";
    return stdout === "" ? null : { role: "note", text: stdout };
  }

  // `!` shell mode: the command the user ran, then its output in a row of its own.
  if (isEnvelope("bash-input", text)) {
    const command = inner("bash-input", text) ?? "";
    return command === "" ? null : { role: "user", text: `! ${command}` };
  }

  if (isEnvelope("bash-stdout", text)) {
    const output = [inner("bash-stdout", text), inner("bash-stderr", text)].filter(Boolean).join("\n");
    return output === "" ? null : { role: "note", text: output };
  }

  if (isEnvelope("task-notification", text)) {
    const summary = inner("summary", text);
    return summary ? { role: "note", text: summary } : null;
  }

  return text.trim() === "" ? null : { role: "user", text };
}

/** Flatten a `tool_result.content`, which is either a plain string or a list of text blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
      ? (b as { text: string }).text
      : ""))
    .filter(Boolean)
    .join("\n");
}

interface RawRow extends Record<string, unknown> {
  type?: unknown;
  uuid?: unknown;
  timestamp?: unknown;
  isSidechain?: unknown;
  isCompactSummary?: unknown;
  isMeta?: unknown;
  turnCompanion?: unknown;
  message?: { role?: unknown; content?: unknown } | unknown;
}

type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;
type Usage = Omit<SessionTelemetry, "fileTruncated">;

const QUEUE_OPERATIONS = new Set(["enqueue", "dequeue", "remove", "popAll"]);
const str = (value: unknown, max = 200): string | undefined =>
  typeof value === "string" && value !== "" && value.length <= max ? value : undefined;

/** A base64 image block (`{type:"image", source:{type:"base64", media_type, data}}`), or null. */
function base64Image(block: unknown): { mediaType?: string; data: string } | null {
  if (block === null || typeof block !== "object") return null;
  const b = block as Record<string, unknown>;
  const source = b.source as Record<string, unknown> | undefined;
  if (b.type !== "image" || !source || source.type !== "base64" || typeof source.data !== "string") return null;
  const mediaType = str(source.media_type, 100);
  return { ...(mediaType ? { mediaType } : {}), data: source.data };
}

/**
 * Every inline image of a row, in the one order the parser numbers them: the message's own image
 * blocks and the images inside its tool results, as they appear. journal-image re-reads a row and
 * picks the n-th from this list, so the parser and this walk must never disagree.
 */
export function claudeRowImages(row: unknown): Array<{ mediaType?: string; data: string }> {
  const message = row !== null && typeof row === "object" ? (row as RawRow).message : undefined;
  const content = message !== null && typeof message === "object" ? (message as { content?: unknown }).content : undefined;
  if (!Array.isArray(content)) return [];
  return content.flatMap((block) => {
    const image = base64Image(block);
    if (image) return [image];
    const inner = block && typeof block === "object" && (block as { type?: unknown }).type === "tool_result"
      ? (block as { content?: unknown }).content : undefined;
    return Array.isArray(inner) ? inner.flatMap((b) => base64Image(b) ?? []) : [];
  });
}

/** Files SendUserFile reports delivering, from the row's structured `toolUseResult`. */
function sentFiles(row: RawRow): Array<{ kind: "file"; path: string }> {
  const result = row.toolUseResult;
  const attachments = result && typeof result === "object" ? (result as { attachments?: unknown }).attachments : undefined;
  if (!Array.isArray(attachments)) return [];
  return attachments.flatMap((a) => {
    const path = a && typeof a === "object" ? str((a as { path?: unknown }).path, 4096) : undefined;
    return path?.startsWith("/") ? [{ kind: "file" as const, path }] : [];
  });
}

/** The hint a pending AskUserQuestion or ExitPlanMode gives a dialog the screen detects. */
function questionHint(name: string, input: unknown, ts: string): InteractionHint | undefined {
  const observedAt = Date.parse(ts) || 0;
  const questions = askUserQuestions(name, input);
  if (questions) {
    const [first] = questions;
    return { source: "claude-journal", observedAt, question: first!.title, options: first!.options };
  }
  if (name !== "ExitPlanMode") return undefined;
  const plan = input && typeof input === "object" ? (input as { plan?: unknown }).plan : undefined;
  return { source: "claude-journal", observedAt, ...(typeof plan === "string" ? { detail: plan.slice(0, MAX_TEXT_CHARS) } : {}) };
}

/**
 * Claude's grammar as a resumable parser (see JournalParser). All carried state lives here: the tool
 * calls awaiting results, the turn tracker, the image index and the journal's facts.
 *
 * `includeSidechains` defaults false: subagent traffic is a different conversation and would swamp
 * the thread you opened.
 */
export class ClaudeParser implements JournalParser {
  private readonly list: TranscriptEntry[] = [];
  private readonly turns = new ClaudeTurnTracker();
  // tool_use id → the part awaiting its result, so a `tool_result` row lands on the call that made it.
  private readonly pendingTools = new Map<string, { part: ToolPart; entry: string }>();
  private readonly pendingQuestions = new Map<string, InteractionHint>();
  private readonly imageIndex = new Map<string, ImageLocator[]>();
  private readonly queue: NativeQueueEvent[] = [];
  private title: string | undefined;
  private usageState: Usage | undefined;

  constructor(private readonly opts: { includeSidechains?: boolean } = {}) {}

  entries(): TranscriptEntry[] {
    return this.turns.finish(this.list);
  }

  facts(): JournalFacts {
    const pending = [...this.pendingQuestions.values()].at(-1);
    return {
      ...(this.title ? { title: this.title } : {}),
      queue: [...this.queue],
      ...(pending ? { pendingQuestion: pending } : {}),
    };
  }

  usage(): Usage | undefined {
    return this.usageState;
  }

  images(entryUuid: string): readonly ImageLocator[] {
    return this.imageIndex.get(entryUuid) ?? [];
  }

  private addImage(entry: string, locator: ImageLocator): number | null {
    if (entry === "") return null; // an entry without a uuid has no address to serve it by
    const list = this.imageIndex.get(entry) ?? [];
    list.push(locator);
    this.imageIndex.set(entry, list);
    return list.length - 1;
  }

  private note(event: NativeQueueEvent): void {
    this.queue.push(event);
    if (this.queue.length > MAX_QUEUE_EVENTS) this.queue.shift();
  }

  /** Bookkeeping rows that carry facts rather than speech. True when the row was one. */
  private fact(row: RawRow, ts: string): boolean {
    if (row.type === "custom-title") {
      const title = str(row.customTitle);
      if (title) this.title = title;
      return true;
    }
    if (row.type === "queue-operation") {
      const kind = row.operation;
      if (typeof kind !== "string" || !QUEUE_OPERATIONS.has(kind)) return true;
      const content = str(row.content, MAX_TEXT_CHARS);
      const reason = str(row.reason), commandUuid = str(row.commandUuid), deliveryId = str(row.deliveryId);
      this.note({
        kind: kind as NativeQueueEvent["kind"], ts,
        ...(content ? { content } : {}), ...(reason ? { reason } : {}),
        ...(commandUuid ? { commandUuid } : {}), ...(deliveryId ? { deliveryId } : {}),
      });
      return true;
    }
    return false;
  }

  line(line: string, offset: number, bytes: number): void {
    if (line.trim() === "") return;
    let row: RawRow;
    try {
      row = JSON.parse(line) as RawRow;
    } catch {
      return; // partial trailing write, or the clipped first line of a tail read
    }
    if (row === null || typeof row !== "object") return;
    this.usageState = claudeUsageRow(row, this.usageState);
    const type = row.type;
    if (row.isSidechain === true && !this.opts.includeSidechains) return;
    const uuid = typeof row.uuid === "string" ? row.uuid : "";
    const ts = typeof row.timestamp === "string" ? row.timestamp : "";
    if (this.fact(row, ts)) { this.turns.observe(row); return; }
    if (type === "attachment") { this.absorbed(row, uuid, ts); return; }
    if (type !== "user" && type !== "assistant") { this.turns.observe(row); return; }

    const message = row.message;
    if (message === null || typeof message !== "object") return;
    const content = (message as { content?: unknown }).content;
    // `isMeta` marks text Claude Code wrote for the model, never typed by the operator; its own
    // human-turn test excludes it. Text riding along with a call (`turnCompanion`: an image's
    // dimensions, a loaded skill's body) has nothing to show. Text that drives the agent (another
    // session's message, a scheduled prompt, hook feedback) explains its next step, so it is a note.
    const meta = type === "user" && row.isMeta === true;
    const human = type === "user" && !meta && row.isCompactSummary !== true && (
      typeof content === "string" ? classifyUserText(content)?.role === "user" :
      Array.isArray(content) && content.some((block) => block?.type === "text" && typeof block.text === "string" && classifyUserText(block.text)?.role === "user")
    );
    this.turns.observe(row, human);
    if (meta && row.turnCompanion === true) return;
    const parts: TranscriptPart[] = [];
    // Set by a meta row, or a `user` row whose string content turns out to be injected plumbing.
    let roleOverride: "note" | undefined = meta ? "note" : undefined;
    // Counts every image of the row in claudeRowImages' order, whether or not it lands on a part.
    let nth = 0;
    const locate = (): ImageLocator => ({ offset, bytes, nth: nth++ });

    if (typeof content === "string") {
      // A string content is the HUMAN-turn carrier — but Claude Code also routes injected plumbing
      // through it, so classify before believing it (see classifyUserText).
      const classified = classifyUserText(content);
      if (classified === null) return;
      if (classified.role === "note") roleOverride = "note";
      parts.push({ kind: "text", ...clamp(classified.text, MAX_TEXT_CHARS) });
    } else if (Array.isArray(content)) {
      const results = content.filter((block) => block?.type === "tool_result").length;
      for (const block of content) {
        if (block === null || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        const image = base64Image(b);
        if (image) {
          const index = this.addImage(uuid, locate());
          if (index !== null) parts.push({ kind: "image", index, ...(image.mediaType ? { mediaType: image.mediaType } : {}) });
        } else if (b.type === "text" && typeof b.text === "string") {
          if (b.text.trim() !== "")
            parts.push({ kind: "text", ...clamp(stripAnsi(b.text), MAX_TEXT_CHARS) });
        } else if (b.type === "thinking" && typeof b.thinking === "string") {
          if (b.thinking.trim() !== "")
            parts.push({ kind: "thinking", ...clamp(stripAnsi(b.thinking), MAX_TEXT_CHARS) });
        } else if (b.type === "tool_use") {
          const name = typeof b.name === "string" ? b.name : "tool";
          const part: ToolPart = { kind: "tool", name, summary: summarizeToolInput(b.input) };
          const questions = askUserQuestions(name, b.input);
          if (questions) part.questions = questions;
          if (typeof b.id === "string") {
            this.pendingTools.set(b.id, { part, entry: uuid });
            const hint = questionHint(name, b.input, ts);
            if (hint) this.pendingQuestions.set(b.id, hint);
          }
          parts.push(part);
        } else if (b.type === "tool_result") {
          // Fold onto the call that produced it. The awaited part is MUTATED in place — it already
          // sits in an emitted entry, which is exactly why results attach without reordering anything.
          const id = typeof b.tool_use_id === "string" ? b.tool_use_id : "";
          const target = this.pendingTools.get(id);
          this.pendingQuestions.delete(id);
          // Tool output routinely carries colour codes (any command run through a shell) — strip
          // them, since this view renders text nodes rather than interpreting escapes.
          const resultText = stripAnsi(toolResultText(b.content));
          const owner = target?.entry ?? uuid;
          const attachments: ToolAttachment[] = [];
          for (const inner of Array.isArray(b.content) ? b.content : []) {
            const img = base64Image(inner);
            if (!img) continue;
            const index = this.addImage(owner, locate());
            if (index !== null) attachments.push({ kind: "image", index, ...(img.mediaType ? { mediaType: img.mediaType } : {}) });
          }
          // toolUseResult describes the row's one result; with several it would be ambiguous.
          if (target?.part.name === "SendUserFile" && results === 1 && b.is_error !== true) attachments.push(...sentFiles(row));
          const result = {
            ...clamp(resultText, MAX_RESULT_CHARS),
            ...(b.is_error === true ? { isError: true } : {}),
            ...(attachments.length ? { attachments } : {}),
          };
          if (target) {
            this.pendingTools.delete(id);
            target.part.result = result;
          } else if (resultText.trim() !== "" || attachments.length) {
            // Orphan result (its call fell outside a tail-read window) — keep it, unattached, so the
            // window never silently drops output.
            parts.push({ kind: "tool", name: "result", summary: "", result });
          }
        }
      }
    }

    if (parts.length === 0) return; // bookkeeping row with nothing to show
    const role: TranscriptEntry["role"] =
      row.isCompactSummary === true
        ? "summary"
        : type === "assistant"
          ? "assistant"
          : (roleOverride ?? "user");
    const stop = (message as { stop_reason?: unknown }).stop_reason;
    const phase = role === "assistant" && parts.some((part) => part.kind === "text")
      ? stop === "end_turn" ? "final_answer" : stop === "tool_use" ? "commentary" : undefined : undefined;
    this.push({ uuid, ts, role, parts, ...(phase ? { phase } : {}) });
  }

  /**
   * A message the operator queued while Claude worked, absorbed into the running turn. Claude writes
   * it ONLY as this attachment (never as a user row), so without it the history would lose something
   * the operator said. It stays in the running turn, as it did on screen.
   */
  private absorbed(row: RawRow, uuid: string, ts: string): void {
    this.turns.observe(row);
    const attachment = row.attachment;
    if (attachment === null || typeof attachment !== "object") return;
    const a = attachment as Record<string, unknown>;
    if (a.type !== "queued_command") return;
    const prompt = str(a.prompt, MAX_TEXT_CHARS);
    const commandUuid = str(a.source_uuid), deliveryId = str(a.delivery_id);
    this.note({
      kind: "queued_command", ts, ...(prompt ? { content: prompt } : {}),
      ...(commandUuid ? { commandUuid } : {}), ...(deliveryId ? { deliveryId } : {}),
    });
    const origin = a.origin && typeof a.origin === "object" ? (a.origin as { kind?: unknown }).kind : undefined;
    if (origin !== "human" || !prompt || uuid === "") return;
    const classified = classifyUserText(prompt);
    if (classified?.role !== "user") return;
    this.push({ uuid, ts, role: "user", parts: [{ kind: "text", ...clamp(classified.text, MAX_TEXT_CHARS) }] });
  }

  private push(entry: TranscriptEntry): void {
    this.turns.attach(entry);
    this.list.push(entry);
  }
}

/**
 * Parse a Claude session log into oldest-first turns.
 *
 * PURE — no fs, no clock — so the whole grammar is unit-testable (`bun test`). Unparseable lines are
 * skipped rather than thrown on: a log is appended to live, so the final line can be a partial write,
 * and a tail-read window starts mid-line by construction.
 */
export function parseClaudeTranscript(
  text: string,
  opts: { includeSidechains?: boolean } = {},
): TranscriptEntry[] {
  const parser = new ClaudeParser(opts);
  feedText(text, (line, offset, bytes) => parser.line(line, offset, bytes));
  return parser.entries();
}

/**
 * The uuid of a log's first entry — its conversation ROOT.
 *
 * Claude Code does not keep one file per conversation. Resuming a session (and `/fork`, and
 * promotion to a background job) COPIES the whole thread into a fresh `<new-uuid>.jsonl` and
 * continues there, while Herdr keeps reporting whichever id the agent last announced. Observed live:
 * Herdr named a log frozen at 18:12 while the conversation had been continuing in a different file
 * until 20:59 — nearly three hours of history simply invisible.
 *
 * Every copy preserves the original first entry, so the root uuid identifies the lineage: three logs
 * of one conversation all began `bcb07539-…`, while unrelated sessions in the same directory each had
 * their own. Exported for the tests.
 */
export function conversationRoot(text: string): string | null {
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const row = JSON.parse(line) as { uuid?: unknown };
      if (typeof row.uuid === "string" && row.uuid !== "") return row.uuid;
    } catch {
      continue; // a clipped/partial line — keep looking
    }
  }
  return null;
}

/**
 * Real filesystem source rooted at Claude's projects directory.
 *
 * Resolution is by UUID SCAN, not by reconstructing the mangled project-directory name from the
 * pane's cwd. The mangling is lossy (every non-alphanumeric becomes "-") and, worse, a pane's
 * reported cwd drifts as the agent works — a subdirectory cwd would derive a directory that doesn't
 * exist. Session uuids are globally unique, so scanning the project dirs for `<uuid>.jsonl` is both
 * correct and cheap (measured: ~14 ms across 306 logs, and the hit is then cached).
 *
 * MORE THAN ONE ROOT is normal here: `CLAUDE_CONFIG_DIR` gives each Claude profile its own projects
 * tree, and a herd can hold panes from several (issue #92). The roots are searched IN ORDER and the
 * first one holding the uuid wins — and that is not a heuristic, it is the same global uniqueness the
 * scan already relies on: two roots cannot disagree about who a uuid belongs to. No profile detection
 * exists or is needed. The root that produced a hit is remembered with it, because everything after
 * resolution (continuation-following, and the containment check that guards it) must stay inside THAT
 * root rather than whichever root happened to be configured first.
 */
export class ClaudeTranscriptSource implements TranscriptSource {
  private readonly pathCache = new Map<string, { path: string; root: string }>();
  /** Conversation root per log file (see rootOf). */
  private readonly rootCache = new Map<string, string>();

  private readonly roots: string[];

  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    // Claude always reports an id. A path-kind ref for this agent is not something we've ever seen,
    // and inventing a meaning for it would widen the fs surface for no gain.
    if (ref.kind !== "id" || !isSessionId(ref.value)) return null;
    const sessionId = ref.value;
    const cached = this.pathCache.get(sessionId);
    if (cached !== undefined) {
      // Re-verify: a cached path can vanish when a session is deleted.
      //
      // The cache memoises only the EXPENSIVE part — the global scan that maps a uuid to its file,
      // which never changes. Continuation-following must still run on every call, because the
      // conversation rotates into a new file WHILE the bridge is up: caching its result would pin the
      // answer to whatever was true at the first request and go stale minutes later.
      if (await exists(cached.path)) return this.followContinuation(cached.path, cached.root);
      this.pathCache.delete(sessionId);
    }

    const file = `${sessionId}.jsonl`;
    for (const root of this.roots) {
      let dirs: string[];
      try {
        dirs = await readdir(root);
      } catch {
        continue; // this projects dir doesn't exist — a profile that isn't on this machine
      }
      for (const dir of dirs) {
        const candidate = join(root, dir, file);
        if (!(await exists(candidate))) continue;
        const real = await containedRealpath(candidate, root);
        if (real === null) {
          // A log by this name exists here but points out of this root, so it is not this root's to
          // serve — and we do not go on to accept it under a sibling root either (files.ts header).
          // Abandoning the root rather than the whole search is the only multi-root difference: a
          // planted symlink in one profile can't blank the history of the others.
          break;
        }
        this.pathCache.set(sessionId, { path: real, root });
        return this.followContinuation(real, root);
      }
    }
    return null;
  }

  /**
   * Follow a rotated conversation to the log it actually continues in.
   *
   * The id Herdr reports can name a FROZEN PREFIX (see {@link conversationRoot}), so serving it
   * verbatim silently drops everything since the rotation. We look for siblings sharing this log's
   * root uuid and prefer the most recently written one.
   *
   * Two guards keep this from making things worse:
   *  - a candidate must be at least as large as the log we already have, so following can never show
   *    LESS history than not following;
   *  - only the first line of each sibling is read (plus a stat), so the scan is a few milliseconds
   *    over a directory of ~40 logs — and this route is on-demand, never on the poll loop.
   *
   * Known limit: a `/fork` of the same conversation shares the root too, so a fork being written more
   * recently than the pane's own session would win. That needs a per-pane session id Herdr doesn't
   * expose; showing the freshest branch of the right conversation beats showing a stale one.
   */
  private async followContinuation(path: string, root: string): Promise<string> {
    const dir = dirname(path);
    let self: { root: string | null; size: number; mtimeMs: number };
    try {
      const st = await stat(path);
      self = { root: await this.rootOf(path, st), size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      return path;
    }
    if (self.root === null) return path;

    let best = { path, size: self.size, mtimeMs: self.mtimeMs };
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return path;
    }
    for (const name of names) {
      if (!name.endsWith(".jsonl")) continue;
      const candidate = join(dir, name);
      if (candidate === path) continue;
      try {
        const st = await stat(candidate);
        if (st.mtimeMs <= best.mtimeMs || st.size < self.size) continue;
        // Containment AGAIN, before a byte of the candidate is read. The directory got here from a
        // path `resolve` already validated, but a sibling INSIDE it can still be a symlink out of the
        // root — and anything that writes into the projects tree can plant one. Following it would
        // read a file the journal never owned, which is exactly what files.ts promises it can't.
        const real = await containedRealpath(candidate, root);
        if (real === null) continue;
        if ((await this.rootOf(real, st)) !== self.root) continue;
        best = { path: real, size: st.size, mtimeMs: st.mtimeMs };
      } catch {
        continue; // unreadable sibling — ignore it rather than fail the whole read
      }
    }
    return best.path;
  }

  /**
   * A log's conversation root, read from its first line once per file. Only the answer is cached,
   * never which file wins: sizes, mtimes and containment are re-checked on every call because the
   * continuation grows by appends and a sibling can be swapped for a symlink at any time. A null root
   * (empty or half-written first line) is not cached, so a file still being created is read again.
   * Keyed by inode too, so a path deleted and recreated with another conversation is read afresh.
   */
  private async rootOf(path: string, st: { ino: number }): Promise<string | null> {
    const key = `${st.ino}:${path}`;
    const cached = this.rootCache.get(key);
    if (cached !== undefined) return cached;
    const value = conversationRoot(await head(path));
    if (value !== null) {
      this.rootCache.set(key, value);
      if (this.rootCache.size > 1024) this.rootCache.delete(this.rootCache.keys().next().value!);
    }
    return value;
  }

  stat = statFile;

  load = loadTail;

  read = readRange;
}

/**
 * Claude's journal adapter. `agent` matches the Herdr snapshot's `agent` string.
 *
 * `roots` is one projects directory or several (one per `CLAUDE_CONFIG_DIR` profile), searched in
 * order.
 */
export function claudeJournal(roots: string | readonly string[]): JournalAdapter {
  return {
    agent: "claude",
    parseUsage: parseClaudeUsage,
    source: new ClaudeTranscriptSource(roots),
    parse: (text) => parseClaudeTranscript(text),
    parser: () => new ClaudeParser(),
    rowImages: claudeRowImages,
  };
}
