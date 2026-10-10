import { basename } from "node:path";
import { toolQuestions } from "./journal/questions.ts";
import { record, type CodexRpc } from "./codex-rpc.ts";
import type { TranscriptEntry, TranscriptPart, TranscriptTurn } from "./journal/types.ts";
import { isInjectedContext, visibleAssistantText } from "./journal/codex.ts";

const text = (value: unknown): string => typeof value === "string" ? value : "";
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];
const MAX_RESULT = 20_000;
const clip = (value: string) => ({ text: value.slice(-MAX_RESULT), truncated: value.length > MAX_RESULT });

export function codexLifecycle(turn: Record<string, unknown>): TranscriptTurn {
  return {
    status: turn.status === "inProgress" ? "running" : turn.status === "completed" ? "completed" : "aborted",
    ...(typeof turn.durationMs === "number" ? { durationMs: turn.durationMs } : {}),
  };
}

function imageLabel(content: Record<string, unknown>): string {
  const source = content.type === "localImage" ? text(content.path) : text(content.url);
  // A data: URL is the image itself; never echo its bytes into the transcript.
  return source && !source.startsWith("data:") ? `[Image: ${basename(source)}]` : "[Image]";
}

/** One app-server ThreadItem as a transcript entry, or null when it has nothing to show. */
export function codexItemEntry(item: Record<string, unknown>, turnId: string, turn?: TranscriptTurn): TranscriptEntry | null {
  const parts: TranscriptPart[] = [];
  let role: TranscriptEntry["role"] = "assistant";
  switch (item.type) {
    case "userMessage": {
      role = "user";
      for (const rawContent of list(item.content)) {
        const content = record(rawContent);
        if (content.type === "text" && !isInjectedContext(text(content.text))) parts.push({ kind: "text", text: text(content.text) });
        else if (content.type === "image" || content.type === "localImage") parts.push({ kind: "text", text: imageLabel(content) });
      }
      break;
    }
    case "agentMessage": parts.push({ kind: "text", text: visibleAssistantText(text(item.text), item.phase) }); break;
    case "plan": if (text(item.text)) parts.push({ kind: "text", text: text(item.text) }); break;
    case "hookPrompt": {
      role = "note";
      const body = list(item.fragments).map((v) => text(record(v).text)).filter(Boolean).join("\n");
      if (body) parts.push({ kind: "text", text: body });
      break;
    }
    case "reasoning": {
      const summary = list(item.summary).filter((v): v is string => typeof v === "string").join("\n");
      if (summary) parts.push({ kind: "thinking", text: summary });
      break;
    }
    case "commandExecution": parts.push({ kind: "tool", name: "Bash", summary: text(item.command),
      ...(typeof item.aggregatedOutput === "string" ? { result: { ...clip(item.aggregatedOutput), isError: typeof item.exitCode === "number" && item.exitCode !== 0 } } : {}) }); break;
    case "fileChange": {
      const changes = list(item.changes).map(record);
      const diff = changes.map((change) => text(change.diff)).filter(Boolean).join("\n");
      parts.push({ kind: "tool", name: "Edit", summary: changes.map((change) => text(change.path)).join(", "),
        ...(diff ? { result: { ...clip(diff), isError: item.status === "failed" } } : {}) });
      break;
    }
    case "mcpToolCall": case "dynamicToolCall": {
      const questions = toolQuestions(item.tool, typeof item.arguments === "string" ? item.arguments : JSON.stringify(item.arguments));
      parts.push({ kind: "tool", name: text(item.tool) || "Tool", summary: text(item.server), ...(questions ? { questions } : {}) });
      break;
    }
    case "collabAgentToolCall": parts.push({ kind: "tool", name: text(item.tool) || "Agent", summary: text(item.prompt).slice(0, 500) }); break;
    case "subAgentActivity": parts.push({ kind: "tool", name: "Subagent", summary: `${text(item.kind)} ${text(item.agentPath)}`.trim() }); break;
    case "imageView": parts.push({ kind: "tool", name: "view_image", summary: text(item.path) }); break;
    case "imageGeneration": {
      // `result` is the generated image as base64; only its saved path and prompt are transcript.
      const failure = item.failure ? text(record(item.failure).message) || "Image generation failed" : "";
      parts.push({ kind: "tool", name: "image_generation", summary: text(item.savedPath) || text(item.revisedPrompt).slice(0, 500),
        ...(failure ? { result: { text: failure, isError: true } } : {}) });
      break;
    }
    case "webSearch": parts.push({ kind: "tool", name: "WebSearch", summary: text(item.query) }); break;
    case "contextCompaction": role = "summary"; parts.push({ kind: "text", text: "Conversation compacted" }); break;
    default: if (typeof item.type === "string") parts.push({ kind: "tool", name: item.type, summary: text(item.status) });
  }
  if (!parts.length || typeof item.id !== "string") return null;
  return {
    uuid: item.id, ts: "", role, parts, turnId, ...(turn ? { turn } : {}),
    ...(item.phase === "commentary" || item.phase === "final_answer" ? { phase: item.phase } : {}),
  };
}

type Rpc = Pick<CodexRpc, "request">;

// Items per thread/items/list call. One item is about 2.4 KB on a measured 948 KB thread, so a call
// stays near 20 KB; a generated image still carries its base64 and can exceed it.
export const ITEM_PAGE = 8;
// Daemon bytes one page reads before it stops and reports hasMore. Every web caller pages back with
// `before`, so a large `limit` (the history view asks for 5000) costs round trips, not a whole-thread read.
export const PAGE_BYTES = 64 * 1024;
// Calls spent looking for a `before` whose cursor was forgotten before degrading to the newest page.
const WALK_CALLS = 8;
const TURN_PAGE = 50;
const MAX_CALLS = 64;

/**
 * Paged reads of an app-server thread, newest first, instead of hydrating every turn per read.
 * `before` is an entry uuid (an item id); the continuation cursor it maps to is remembered per thread.
 * A page ends on a call boundary: it may hold up to ITEM_PAGE - 1 entries beyond `limit`, and one
 * call beyond the byte budget.
 */
export class CodexHistory {
  private readonly cursors = new Map<string, string>();
  private readonly turns = new Map<string, Map<string, TranscriptTurn>>();
  constructor(private readonly rpc: Rpc, private readonly budget = PAGE_BYTES) {}

  async page(threadId: string, opts: { limit: number; before?: string }): Promise<{ entries: TranscriptEntry[]; hasMore: boolean }> {
    const anchor = opts.before;
    let cursor = anchor === undefined ? undefined : this.cursors.get(`${threadId}\0${anchor}`);
    // Without a remembered cursor (a restart, an evicted one), walk a bounded way down to `before`.
    // An anchor it does not reach degrades to the newest page, like the journal pager, never to an
    // empty page or a whole-thread walk driven by a client string.
    let skipping = anchor !== undefined && cursor === undefined;
    const newestFirst: TranscriptEntry[] = [];
    let more = true;
    let bytes = 0;
    let walked = 0;
    for (let calls = 0; more && calls < MAX_CALLS && newestFirst.length < opts.limit && bytes < this.budget; calls++) {
      const page = record(await this.rpc.request("thread/items/list", {
        threadId, limit: ITEM_PAGE, sortDirection: "desc", ...(cursor ? { cursor } : {}),
      }));
      const rows = list(page.data);
      if (!skipping) bytes += JSON.stringify(rows).length;
      for (const raw of rows) {
        const row = record(raw);
        const item = record(row.item);
        if (skipping) { skipping = item.id !== anchor; continue; }
        const entry = codexItemEntry(item, text(row.turnId));
        if (entry) newestFirst.push(entry);
      }
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
      more = cursor !== undefined;
      if (skipping && (!more || ++walked >= WALK_CALLS)) {
        skipping = false;
        cursor = undefined;
        more = true;
      }
    }
    const lifecycles = await this.lifecycles(threadId, new Set(newestFirst.map((entry) => entry.turnId ?? "")));
    const entries = newestFirst.reverse().map((entry) => {
      const turn = lifecycles.get(entry.turnId ?? "");
      return turn ? { ...entry, turn } : entry;
    });
    const oldest = entries[0];
    if (oldest && cursor) {
      if (this.cursors.size >= 512) this.cursors.delete(this.cursors.keys().next().value!);
      this.cursors.set(`${threadId}\0${oldest.uuid}`, cursor);
    }
    return { entries, hasMore: more };
  }

  /** Turn status by id. The newest page is always re-read (a running turn ends); older turns are final. */
  private async lifecycles(threadId: string, needed: Set<string>): Promise<Map<string, TranscriptTurn>> {
    const known = this.turns.get(threadId) ?? new Map<string, TranscriptTurn>();
    this.turns.delete(threadId);
    if (this.turns.size >= 16) this.turns.delete(this.turns.keys().next().value!);
    this.turns.set(threadId, known);
    let cursor: string | undefined;
    for (let calls = 0; calls < 20; calls++) {
      if (calls > 0 && [...needed].every((id) => known.has(id))) break;
      const page = record(await this.rpc.request("thread/turns/list", {
        threadId, limit: TURN_PAGE, sortDirection: "desc", itemsView: "notLoaded", ...(cursor ? { cursor } : {}),
      }));
      for (const raw of list(page.data)) {
        const turn = record(raw);
        if (typeof turn.id === "string") known.set(turn.id, codexLifecycle(turn));
      }
      cursor = typeof page.nextCursor === "string" && page.nextCursor ? page.nextCursor : undefined;
      if (!cursor) break;
    }
    return known;
  }
}
