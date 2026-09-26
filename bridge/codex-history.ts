import { record } from "./codex-rpc.ts";
import type { TranscriptEntry, TranscriptPart, TranscriptTurn } from "./journal/types.ts";
import { isInjectedContext, visibleAssistantText } from "./journal/codex.ts";

const text = (value: unknown): string => typeof value === "string" ? value : "";
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : [];

export function codexEntries(thread: Record<string, unknown>): TranscriptEntry[] {
  const entries: TranscriptEntry[] = [];
  for (const value of list(thread.turns)) {
    const turn = record(value);
    const lifecycle: TranscriptTurn = {
      status: turn.status === "inProgress" ? "running" : turn.status === "completed" ? "completed" : "aborted",
      ...(typeof turn.durationMs === "number" ? { durationMs: turn.durationMs } : {}),
    };
    for (const raw of list(turn.items)) {
      const item = record(raw);
      const parts: TranscriptPart[] = [];
      let role: TranscriptEntry["role"] = "assistant";
      switch (item.type) {
        case "userMessage":
          role = "user";
          for (const rawContent of list(item.content)) {
            const content = record(rawContent);
            if (content.type === "text" && !isInjectedContext(text(content.text))) parts.push({ kind: "text", text: text(content.text) });
            else if (content.type === "image" || content.type === "localImage") parts.push({ kind: "text", text: "[Image]" });
          }
          break;
        case "agentMessage": parts.push({ kind: "text", text: visibleAssistantText(text(item.text), item.phase) }); break;
        case "reasoning": {
          const summary = list(item.summary).filter((v): v is string => typeof v === "string").join("\n");
          if (summary) parts.push({ kind: "thinking", text: summary });
          break;
        }
        case "commandExecution": parts.push({ kind: "tool", name: "Bash", summary: text(item.command),
          ...(typeof item.aggregatedOutput === "string" ? { result: { text: item.aggregatedOutput.slice(-20_000), truncated: item.aggregatedOutput.length > 20_000, isError: typeof item.exitCode === "number" && item.exitCode !== 0 } } : {}) }); break;
        case "fileChange": parts.push({ kind: "tool", name: "Edit", summary: list(item.changes).map((v) => text(record(v).path)).join(", ") }); break;
        case "mcpToolCall": case "dynamicToolCall": parts.push({ kind: "tool", name: text(item.tool) || "Tool", summary: text(item.server) }); break;
        case "webSearch": parts.push({ kind: "tool", name: "WebSearch", summary: text(item.query) }); break;
        case "contextCompaction": role = "summary"; parts.push({ kind: "text", text: "Conversation compacted" }); break;
        default: if (typeof item.type === "string") parts.push({ kind: "tool", name: item.type, summary: text(item.status) });
      }
      if (parts.length && typeof item.id === "string") entries.push({
        uuid: item.id, ts: "", role, parts, turnId: text(turn.id), turn: lifecycle,
        ...(item.phase === "commentary" || item.phase === "final_answer" ? { phase: item.phase } : {}),
      });
    }
  }
  return entries;
}
