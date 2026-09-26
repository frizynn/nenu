import { ChatMedia } from "./chat-media";
import { useMemo, useState } from "react";
import { ChevronRight, Info, User } from "lucide-react";

import { AgentIcon } from "@/components/agent-icon";
import { MarkdownText } from "@/components/markdown-text";
import { searchableText } from "@/lib/transcript-search";
import { WorkLogTools } from "@/components/work-log-tools";
import { WorkActivityLabel } from "@/components/work-activity-label";
import { buildWorkTimeline, formatWorkDuration, type WorkTurn } from "@/lib/work-timeline";
import type { AgentStatus, TranscriptEntry, TranscriptPart } from "@/lib/types";

// Renders an agent transcript — the conversation history a Claude pane's terminal structurally
// cannot hold (it runs on the alternate screen, which keeps no scrollback ring; see
// bridge/transcript.ts). This is a DIFFERENT representation from the terminal mirror, deliberately:
// the mirror is a faithful 51-row snapshot of a TUI, while this is the thread itself — role-tagged
// turns, timestamps, and tool calls folded together with the output they produced.
//
// XSS boundary, same rule as the mirror: every string from the log reaches the DOM as a React TEXT
// NODE, never as markup. Prose IS parsed as Markdown (lib/markdown.ts) — but that parser emits an
// AST which the renderer maps to React elements, so no HTML string is ever constructed. Do not
// "improve" this by swapping in a markdown→HTML library without re-deriving that boundary.

/** Times only — the date lives on the day divider, and a phone row has no width to spare. */
function clockTime(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ""
    : d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function dayKey(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

function ThinkingPart({ part, query, focused = false }: { part: Extract<TranscriptPart, { kind: "thinking" }>; query: string; focused?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const hit = query.trim() !== "" && part.text.toLowerCase().includes(query.trim().toLowerCase());
  const open = expanded || focused || hit;
  return <div>
    <button type="button" data-work-toggle aria-expanded={open} onClick={() => setExpanded((value) => !value)}
      className="flex min-h-11 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground md:min-h-7">
      <ChevronRight aria-hidden="true" className={`size-3.5 ${open ? "rotate-90" : ""}`} />Thinking{part.truncated ? " · truncated" : ""}
    </button>
    {open && <div className="pb-2 pl-5 text-xs text-muted-foreground"><MarkdownText text={part.text} query={query} />
      {part.truncated && <p>… truncated</p>}</div>}
  </div>;
}

function Part({ part, query, focused = false, active = false }: { part: TranscriptPart; query: string; focused?: boolean; active?: boolean }) {
  // Tool output is COMMAND output, not prose — it stays verbatim in a monospace block (see ToolPart).
  if (part.kind === "tool") return <WorkLogTools calls={[{ id: "single", part }]} query={query} active={active} />;
  if (part.kind === "thinking") return <ThinkingPart part={part} query={query} focused={focused} />;
  // Prose is Markdown, so it renders formatted. MarkdownText emits React elements only — never
  // markup — so this keeps the same XSS boundary the raw text node had.
  return (
    <div>
      <MarkdownText
        text={part.text}
        query={query}
      />
      <ChatMedia text={part.text} />
      {part.truncated && <div className="text-xs text-muted-foreground">… truncated</div>}
    </div>
  );
}

function Turn({
  entry,
  agent,
  showHeader,
  query,
  focused = false,
}: {
  entry: TranscriptEntry;
  agent?: string;
  /** False for a turn continuing the same speaker's run — see the grouping note in TranscriptView. */
  showHeader: boolean;
  query: string;
  focused?: boolean;
}) {
  const time = clockTime(entry.ts);

  // Neither of these is speech, so both render dashed-and-muted — visibly set apart from the
  // conversation rather than attributed to the user or the agent.
  if (entry.role === "summary" || entry.role === "note") {
    return (
      <div className="rounded-lg border border-dashed bg-muted/30 px-3 py-2">
        <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
          <Info className="size-3" />
          {entry.role === "summary" ? "Context compacted" : "System"}
          {time && ` · ${time}`}
        </div>
        {entry.parts.map((part, i) => (
          <Part key={i} part={part} query={query} focused={focused} />
        ))}
      </div>
    );
  }

  const isUser = entry.role === "user";
  return (
    <div className={isUser ? "rounded-lg border bg-muted/50 px-3 py-2" : "px-1"}>
      {showHeader && (
        <div className="mb-1 flex items-center gap-1.5">
          {isUser ? (
            <User className="size-3.5 text-muted-foreground" />
          ) : (
            <AgentIcon agent={agent ?? "claude"} className="size-4" />
          )}
          <span className="text-[11px] font-semibold tracking-wide text-muted-foreground uppercase">
            {isUser ? "You" : (agent ?? "agent")}
          </span>
          {time && <span className="text-[11px] text-muted-foreground">{time}</span>}
        </div>
      )}
      <div className="space-y-1.5">
        {entry.parts.map((part, i) => (
          <Part key={i} part={part} query={query} focused={focused} />
        ))}
      </div>
    </div>
  );
}

function ActivityLog({ entries, query, focusedUuid, active }: { entries: TranscriptEntry[]; query: string; focusedUuid?: string; active: boolean }) {
  const blocks: Array<{ kind: "tools"; entries: TranscriptEntry[] } | { kind: "entry"; entry: TranscriptEntry }> = [];
  for (const entry of entries) {
    if (entry.parts.every((part) => part.kind === "tool")) {
      const last = blocks.at(-1);
      if (last?.kind === "tools") last.entries.push(entry);
      else blocks.push({ kind: "tools", entries: [entry] });
    } else blocks.push({ kind: "entry", entry });
  }
  return <div className="space-y-1 pl-5 text-xs text-muted-foreground">
    {blocks.map((block) => block.kind === "tools"
      ? <WorkLogTools key={block.entries[0]!.uuid} calls={block.entries.flatMap((entry) => entry.parts.flatMap((part, index) => part.kind === "tool" ? [{ id: `${entry.uuid}:${index}`, entryId: index === 0 ? entry.uuid : undefined, part }] : []))} query={query} focusedEntryId={focusedUuid} active={active} />
      : <div key={block.entry.uuid} data-turn={block.entry.uuid} className={focusedUuid === block.entry.uuid ? "rounded ring-2 ring-primary/60" : undefined}>
          {block.entry.parts.map((part, index) => <Part key={index} part={part} query={query} focused={focusedUuid === block.entry.uuid} active={active} />)}
        </div>)}
  </div>;
}

function WorkTurnView({ turn, agent, query, focusedUuid }: { turn: WorkTurn; agent?: string; query: string; focusedUuid?: string }) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const needle = query.trim().toLowerCase();
  const searching = turn.activity.some((entry) => entry.uuid === focusedUuid || (needle !== "" && searchableText(entry).toLowerCase().includes(needle)));
  const open = searching || (expanded ?? !turn.settled);
  const tools = turn.activity.flatMap((entry) => entry.parts.filter((part) => part.kind === "tool"));
  const failures = tools.filter((part) => part.result?.isError).length;
  const truncated = turn.activity.some((entry) => entry.parts.some((part) => part.kind === "tool" ? part.result?.truncated : part.truncated));
  const hasDetails = turn.activity.length > 0;
  const label = turn.interrupted ? "Stopped" : turn.settled ? "Worked" : "Work log";
  const duration = turn.durationMs !== undefined ? ` for ${formatWorkDuration(turn.durationMs)}` : "";
  const lastPart = turn.activity.at(-1)?.parts.at(-1);
  return <div className="space-y-2" data-work-turn={turn.id}>
    <button type="button" data-work-toggle aria-expanded={open} disabled={!hasDetails}
      onClick={() => setExpanded(!open)} className="flex min-h-11 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0 text-left text-xs text-muted-foreground hover:text-foreground disabled:opacity-100 md:min-h-7">
      <ChevronRight aria-hidden="true" className={`size-3.5 shrink-0 ${open ? "rotate-90" : ""}`} />
      {turn.active ? <WorkActivityLabel startedAt={turn.startedAt} thinking={lastPart?.kind === "thinking"} /> : <span>{label}{turn.settled ? duration : ""}</span>}
      {tools.length > 0 && <span className="whitespace-nowrap">· {tools.length} tool {tools.length === 1 ? "call" : "calls"}</span>}
      {failures > 0 && <span className="whitespace-nowrap text-destructive">· {failures} {failures === 1 ? "error" : "errors"}</span>}
      {truncated && <span className="whitespace-nowrap">· truncated</span>}
    </button>
    {open && <ActivityLog entries={turn.activity} query={query} focusedUuid={focusedUuid} active={turn.active} />}
    {turn.answer && <div data-turn={turn.activity.some((entry) => entry.uuid === turn.answer!.uuid) ? undefined : turn.answer.uuid}
      className={turn.answer.uuid === focusedUuid ? "rounded ring-2 ring-primary/60" : undefined}>
      <Turn entry={turn.answer} agent={agent} showHeader query={query} focused={turn.answer.uuid === focusedUuid} />
    </div>}
  </div>;
}

export function TranscriptView({ entries, agent, query = "", focusedUuid, activityStatus, onWorkToggle }: {
  entries: TranscriptEntry[];
  agent?: string;
  query?: string;
  focusedUuid?: string;
  activityStatus?: AgentStatus;
  onWorkToggle?: (anchor: HTMLElement) => void;
}) {
  const rows = useMemo(() => buildWorkTimeline(entries, activityStatus), [entries, activityStatus]);
  let lastDay = "";
  let lastRole = "";
  const last = entries.at(-1);
  const pending = activityStatus === "working" && !rows.some((row) => row.kind === "work" && row.active) &&
    (!last || last.role === "user" || (last.role === "assistant" && last.phase !== "final_answer" && last.turn?.status !== "completed" && last.turn?.status !== "aborted"));
  return <div className="space-y-3" onClickCapture={(event) => {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-work-toggle]") : null;
    if (anchor) onWorkToggle?.(anchor);
  }}>
    {rows.map((row) => {
      const entry = row.kind === "message" ? row.entry : row.entries[0]!;
      const day = dayKey(entry.ts);
      const newDay = day !== "" && day !== lastDay;
      if (newDay) lastDay = day;
      const showHeader = newDay || entry.role !== lastRole;
      lastRole = entry.role;
      return <div key={row.kind === "message" ? `message:${entry.uuid}` : `work:${row.id}`} data-turn={row.kind === "message" ? entry.uuid : undefined}
        className={`${showHeader ? "space-y-3 pt-1" : "space-y-3"} ${row.kind === "message" && entry.uuid === focusedUuid ? "rounded-lg ring-2 ring-primary/60 ring-offset-2 ring-offset-background" : ""}`}>
        {newDay && <div className="flex items-center gap-2 pt-1"><div className="h-px flex-1 bg-border" /><span className="text-[11px] font-medium text-muted-foreground">{day}</span><div className="h-px flex-1 bg-border" /></div>}
        {row.kind === "message" ? <Turn entry={entry} agent={agent} showHeader={showHeader} query={query} focused={entry.uuid === focusedUuid} />
          : <WorkTurnView turn={row} agent={agent} query={query} focusedUuid={focusedUuid} />}
      </div>;
    })}
    {pending && <div className="px-1 py-2" role="status"><WorkActivityLabel startedAt={last?.role === "user" ? last.ts : undefined} /></div>}
  </div>;
}
