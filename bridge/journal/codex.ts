// Codex's journal adapter.
//
// SHAPE OF THE SOURCE (verified against on-disk rollouts from codex 0.32.0 AND 0.145.0, 2026-07-29 —
// the path layout and the row envelope are identical across that span; 0.145 adds `world_state` and
// `turn_context` row types, and a `developer` message role, all of which this parser ignores):
//   ~/.codex/sessions/YYYY/MM/DD/rollout-<ISO-ts>-<session-uuid>.jsonl
//   {"timestamp":"…","type":"session_meta","payload":{"id":"<uuid>","cwd":"…","cli_version":"…"}}
//   {"timestamp":"…","type":"response_item","payload":{"type":"message"|"reasoning"|
//                                                      "function_call"|"function_call_output"|
//                                                      "custom_tool_call"|"custom_tool_call_output", …}}
//   {"timestamp":"…","type":"event_msg","payload":{"type":"user_message"|"agent_message"|
//                                                  "agent_reasoning"|"token_count", …}}
//   {"timestamp":"…","type":"compacted","payload":{"message":"…","replacement_history":[…], …}}
// Compaction's envelope was verified on the isolated Nenu QA session, 2026-09-07. Its message
// can be empty; the native event is still completion evidence. Never render replacement_history,
// which contains rewritten model input and would duplicate conversation and injected instructions.
// `{timestamp,type,payload}` are the ONLY top-level keys.
//
// THE TRAP: ROWS ARE DOUBLE-BOOKED. The same conversation is written twice — once as `response_item`
// (the API-shaped record) and once as `event_msg` (the UI event stream). Measured on one session: 29
// `response_item` user messages against 28 `event_msg` user_messages, and the same for assistant
// turns. Parse both families as speech and every turn renders twice. We take `response_item` for
// speech and retain only native lifecycle metadata from `event_msg`, because only `response_item` carries tool RESULTS
// (`function_call_output`) — the event stream has the calls' narration but not their output.
//
// Where Herdr's id comes from: Codex's `SessionStart` hook reports `session_id` to
// `pane.report_agent_session` (herdr integration `codex`, version 6), so the pane record carries a
// kind-`id` ref exactly like Claude's. It needs `herdr integration install codex`; without the hook
// there is no id and the journal correctly reports "no-session".

import { parseCodexUsage } from "./usage.ts";
import { CodexTurnTracker } from "./turns.ts";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { containedRealpath, exists, loadTail, rootList, statFile } from "./files.ts";
import { clamp, MAX_RESULT_CHARS, MAX_TEXT_CHARS, oneLine, stripAnsi, summarizeToolInput } from "./text.ts";
import type {
  AgentSessionRef,
  JournalAdapter,
  TranscriptEntry,
  TranscriptPart,
  TranscriptSource,
} from "./types.ts";

/** Codex names sessions with the same canonical uuid shape Claude does. */
const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isCodexSessionId(value: string): boolean {
  return SESSION_ID_RE.test(value);
}

/**
 * A stable per-row cursor, synthesised because Codex rows carry NO id of their own — and
 * `TranscriptEntry.uuid` is the paging cursor (`?before=`).
 *
 * Row POSITION is the obvious candidate and the wrong one: a log over the byte cap is tail-read, so
 * the window's first row is not the file's first row, and the offset moves as the file grows. Hashing
 * the row's own bytes instead makes the cursor a property of the CONTENT, so it survives a window
 * that starts somewhere else. The occurrence counter disambiguates rows that are byte-identical
 * (two identical shell calls); an unknown cursor degrades to "newest" rather than to an empty page,
 * so the rare miss is a re-render, never a dead end.
 *
 * KNOWN FAILURE MODE, accepted. If a >32 MB log's tail window shifts between two requests AND an
 * earlier byte-identical row falls out of it, the occurrence counters renumber: a cursor the client
 * holds as `cx-<h>-2` can then name what used to be `cx-<h>-3`. That pages to a slightly wrong
 * position rather than degrading to "newest" — the one case where the miss is silent. It needs a
 * multi-megabyte log, duplicate rows identical to the byte, and a window shift between two taps; the
 * harm is a misplaced page in a view you scroll anyway, so it isn't worth a per-row index the format
 * doesn't give us.
 *
 * INVARIANT this relies on: `seen` is advanced for every `response_item` row, INCLUDING rows that
 * emit no entry (a tool output that folds onto its call, an empty reasoning row). Numbering must be a
 * function of the parsed window alone — if it depended on which rows happened to render, adding a
 * renderable row would renumber the ones before it.
 */
export function codexCursor(line: string, seen: Map<string, number>): string {
  // djb2 — we need determinism and speed, not collision resistance; a collision costs a re-render.
  let hash = 5381;
  for (let i = 0; i < line.length; i++) hash = ((hash << 5) + hash + line.charCodeAt(i)) | 0;
  const key = (hash >>> 0).toString(36);
  const n = seen.get(key) ?? 0;
  seen.set(key, n + 1);
  return n === 0 ? `cx-${key}` : `cx-${key}-${n}`;
}

/** Flatten a Codex content list (`input_text` / `output_text` / `text` blocks) into plain text. */
function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) =>
      b && typeof b === "object" && typeof (b as { text?: unknown }).text === "string"
        ? (b as { text: string }).text
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/**
 * Unwrap a `function_call_output.output`, which is a JSON STRING wrapping `{"output": "…"}` rather
 * than the output itself. Falls back to the raw string when it isn't that shape — a tool whose
 * output isn't JSON should still show its output rather than nothing.
 */
export function codexToolOutput(raw: unknown): string {
  // Custom-tool results use the Responses content-list shape, including text plus image blocks.
  // Only literal textual output belongs in this transcript; never serialize image/binary payloads.
  if (Array.isArray(raw)) return raw.flatMap((block) => {
    if (!block || typeof block !== "object") return [];
    const item = block as Record<string, unknown>;
    return (item.type === "input_text" || item.type === "output_text" || item.type === "text") && typeof item.text === "string" ? [item.text] : [];
  }).join("\n");
  if (typeof raw !== "string") return "";
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && typeof (parsed as { output?: unknown }).output === "string") {
      return (parsed as { output: string }).output;
    }
  } catch {
    // not JSON — the raw string IS the output
  }
  return raw;
}

/** `arguments` arrives as a JSON string, not an object — parse before summarising. */
function codexToolSummary(args: unknown): string {
  if (typeof args !== "string") return summarizeToolInput(args);
  try {
    return summarizeToolInput(JSON.parse(args));
  } catch {
    return oneLine(args); // malformed/partial arguments still say something useful
  }
}

/**
 * Injected context Codex persists with a `user` role even though its own conversation UI hides it.
 * Rendering either wrapper as "You" would be actively wrong — the operator never typed it — so it
 * is dropped exactly like Claude's `system-reminder`.
 */
export function isInjectedContext(text: string): boolean {
  const body = text.trim();
  if (body.startsWith("<environment_context>")) return true;
  return (body.startsWith("# AGENTS.md instructions for ") || body.startsWith("# AGENTS.md instructions\n"))
    && body.includes("\n<INSTRUCTIONS>\n")
    && /<\/INSTRUCTIONS>(?:\s*<environment_context>[\s\S]*<\/environment_context>)?$/.test(body);
}

/** Codex app metadata appended to final answers is not part of the visible assistant message. */
export function visibleAssistantText(text: string, phase: unknown): string {
  if (phase !== "final_answer") return text;
  const marker = "<oai-mem-citation>";
  const start = text.lastIndexOf(marker);
  if (start < 0) return text;
  const metadata = text.slice(start).trim();
  if (!metadata.endsWith("</oai-mem-citation>")
    || !metadata.includes("<citation_entries>")
    || !metadata.includes("<rollout_ids>")) return text;
  return text.slice(0, start).trimEnd();
}

interface CodexRow {
  timestamp?: unknown;
  type?: unknown;
  payload?: unknown;
}

/**
 * Parse a Codex rollout log into oldest-first turns. PURE — no fs, no clock.
 *
 * Unparseable lines are skipped: the log is appended to live, so the last line can be a partial
 * write, and a tail-read window starts mid-line by construction.
 */
export function parseCodexTranscript(text: string): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  const turns = new CodexTurnTracker();
  const emit = (entry: TranscriptEntry) => { turns.attach(entry); entries.push(entry); };
  const seen = new Map<string, number>();
  // call_id → the part awaiting its output, so a `function_call_output` lands on its own call.
  const pendingTools = new Map<string, Extract<TranscriptPart, { kind: "tool" }>>();

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let row: CodexRow;
    try {
      row = JSON.parse(line) as CodexRow;
    } catch {
      continue;
    }
    turns.observe(row);
    const payload = row.payload;
    if (payload === null || typeof payload !== "object") continue;
    const p = payload as Record<string, unknown>;
    const ts = typeof row.timestamp === "string" ? row.timestamp : "";
    if (row.type === "compacted") {
      if (typeof p.message !== "string") continue;
      const summary = stripAnsi(p.message).trim() || "Context compacted";
      emit({
        uuid: codexCursor(line, seen), ts, role: "summary",
        parts: [{ kind: "text", ...clamp(summary, MAX_TEXT_CHARS) }],
      });
      continue;
    }
    // The double-booking guard: ordinary UI stream events already occur in response_item.
    if (row.type !== "response_item") continue;
    const uuid = codexCursor(line, seen);

    if (p.type === "message") {
      // Roles are matched EXPLICITLY, never "assistant or else user". Codex 0.145 writes `developer`
      // rows carrying the injected system prompts (permissions, multi-agent instructions) — three of
      // them before the first real turn — and treating an unknown role as speech would render those
      // as things the operator said. Anything that isn't user or assistant is plumbing: drop it.
      if (p.role !== "user" && p.role !== "assistant") continue;
      const role = p.role;
      const rawBody = stripAnsi(blockText(p.content));
      const body = role === "assistant" ? visibleAssistantText(rawBody, p.phase) : rawBody;
      if (body.trim() === "") continue;
      if (role === "user" && isInjectedContext(body)) continue;
      emit({ uuid, ts, role, parts: [{ kind: "text", ...clamp(body, MAX_TEXT_CHARS) }],
        ...(role === "assistant" && (p.phase === "commentary" || p.phase === "final_answer") ? { phase: p.phase } : {}),
      });
      continue;
    }

    if (p.type === "reasoning") {
      // Unlike Claude — whose persisted `thinking` text is empty every time — Codex writes a real
      // reasoning summary here, so this branch actually renders.
      const summary = Array.isArray(p.summary)
        ? p.summary
            .map((s) =>
              s && typeof s === "object" && typeof (s as { text?: unknown }).text === "string"
                ? (s as { text: string }).text
                : "",
            )
            .filter(Boolean)
            .join("\n\n")
        : "";
      if (summary.trim() === "") continue; // encrypted-only reasoning row — nothing to show
      emit({
        uuid,
        ts,
        role: "assistant",
        parts: [{ kind: "thinking", ...clamp(stripAnsi(summary), MAX_TEXT_CHARS) }],
      });
      continue;
    }

    if (p.type === "function_call" || p.type === "custom_tool_call") {
      const part: Extract<TranscriptPart, { kind: "tool" }> = {
        kind: "tool",
        name: typeof p.name === "string" ? p.name : "tool",
        // Custom tools carry raw code/text, not JSON arguments (even when the code happens to be
        // valid JSON). Keep a bounded literal one-line gist instead of guessing its structure.
        summary: p.type === "custom_tool_call" ? typeof p.input === "string" ? oneLine(stripAnsi(p.input)) : "" : codexToolSummary(p.arguments),
      };
      if (typeof p.call_id === "string") pendingTools.set(p.call_id, part);
      emit({ uuid, ts, role: "assistant", parts: [part] });
      continue;
    }

    if (p.type === "function_call_output" || p.type === "custom_tool_call_output") {
      const id = typeof p.call_id === "string" ? p.call_id : "";
      const target = pendingTools.get(id);
      const outputText = stripAnsi(codexToolOutput(p.output));
      if (target) {
        // Mutated in place — the part already sits in an emitted entry, which is exactly why results
        // attach without reordering anything.
        pendingTools.delete(id);
        target.result = clamp(outputText, MAX_RESULT_CHARS);
      } else if (outputText.trim() !== "") {
        // Orphan output (its call fell outside a tail-read window) — kept unattached so the window
        // never silently drops output.
        emit({
          uuid,
          ts,
          role: "assistant",
          parts: [
            { kind: "tool", name: "result", summary: "", result: clamp(outputText, MAX_RESULT_CHARS) },
          ],
        });
      }
    }
  }

  return turns.finish(entries);
}

/**
 * Real filesystem source rooted at Codex's `sessions` directory.
 *
 * Resolution is a targeted walk rather than Claude's flat scan, because the uuid is in the FILENAME
 * under date-partitioned directories (`YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`). We walk newest-date
 * first, so a live session is found after reading a handful of directory entries rather than the
 * whole year. The hit is cached; a cached path is re-verified before use, since a session can be
 * deleted while the bridge is up.
 *
 * No continuation-following, deliberately: Codex reports its session on the `SessionStart` hook, so a
 * resumed conversation re-reports its NEW id and the pane record follows it. That's the failure
 * Claude's followContinuation exists to paper over, and Codex's hook simply doesn't have it.
 */
export class CodexTranscriptSource implements TranscriptSource {
  private readonly pathCache = new Map<string, string>();

  private readonly roots: string[];

  /** One sessions directory or several (a second `CODEX_HOME`), searched in order. */
  constructor(roots: string | readonly string[]) {
    this.roots = rootList(roots);
  }

  async resolve(ref: AgentSessionRef): Promise<string | null> {
    if (ref.kind !== "id" || !isCodexSessionId(ref.value)) return null;
    const sessionId = ref.value;
    const cached = this.pathCache.get(sessionId);
    if (cached !== undefined) {
      if (await exists(cached)) return cached;
      this.pathCache.delete(sessionId);
    }

    const suffix = `-${sessionId.toLowerCase()}.jsonl`;
    for (const root of this.roots) {
      const hit = await this.findUnder(root, suffix);
      // A hit that failed containment is `null` too — that root has nothing it may serve for this
      // uuid either way, and the next root is asked on its own terms (files.ts header).
      if (hit === null) continue;
      this.pathCache.set(sessionId, hit);
      return hit;
    }
    return null;
  }

  /** Newest first at every level: a session being read is almost always today's. */
  private async findUnder(root: string, suffix: string): Promise<string | null> {
    for (const year of await descending(root)) {
      for (const month of await descending(join(root, year))) {
        for (const day of await descending(join(root, year, month))) {
          const dir = join(root, year, month, day);
          let names: string[];
          try {
            names = await readdir(dir);
          } catch {
            continue;
          }
          const hit = names.find(
            (n) => n.startsWith("rollout-") && n.toLowerCase().endsWith(suffix),
          );
          if (hit === undefined) continue;
          return containedRealpath(join(dir, hit), root);
        }
      }
    }
    return null;
  }

  stat = statFile;

  load = loadTail;
}

/** Directory entries, newest-name first. Empty when the directory doesn't exist. */
async function descending(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).sort().reverse();
  } catch {
    return [];
  }
}

/** Codex's journal adapter. `agent` matches the Herdr snapshot's `agent` string. */
export function codexJournal(roots: string | readonly string[]): JournalAdapter {
  return {
    agent: "codex",
    parseUsage: parseCodexUsage,
    source: new CodexTranscriptSource(roots),
    parse: parseCodexTranscript,
  };
}
