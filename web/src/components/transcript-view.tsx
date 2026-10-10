import { TranscriptQuestion } from "./transcript-question";
import { FileMediaContext } from "@/lib/file-preview-context";
import { filePathsInText, sentFiles } from "@/lib/chat-files";
import { IMAGE_EXTENSION, imageLabel, journalImages, shownParts, splitMessageImages, type ShownPart } from "@/lib/message-images";
import { ArtifactCards } from "./artifact-card";
import { ChatMedia } from "./chat-media";
import { MediaViewerContext } from "./file-preview-provider";
import { ImageStrip, JournalImages, type StripImage } from "./message-images";
import { useContext, useMemo, useState } from "react";
import { ChevronRight, Info } from "lucide-react";

import { MarkdownText } from "@/components/markdown-text";
import { searchableText } from "@/lib/transcript-search";
import { relabel, useToolImages, WorkLogTools } from "@/components/work-log-tools";
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

function Part({ part, entryId, query, focused = false, active = false, compactMedia = false, uploads = true }: {
  part: ShownPart;
  entryId: string;
  query: string;
  focused?: boolean;
  active?: boolean;
  compactMedia?: boolean;
  /** False when the entry's journal already holds its images, so upload paths don't show them twice. */
  uploads?: boolean;
}) {
  const media = useContext(FileMediaContext);
  // Inline journal images render as one strip per entry (EntryImages), not part by part.
  if (part.kind === "image") return null;
  // Tool output is COMMAND output, not prose — it stays verbatim in a monospace block (see ToolPart).
  if (part.kind === "tool") return <WorkLogTools calls={[{ id: "single", part, owner: entryId }]} query={query} active={active} />;
  if (part.kind === "thinking") return <ThinkingPart part={part} query={query} focused={focused} />;
  // Prose is Markdown, so it renders formatted. MarkdownText emits React elements only — never
  // markup — so this keeps the same XSS boundary the raw text node had.
  return (
    <div>
      <MarkdownText
        text={compactMedia && media ? splitMessageImages(part.text).text : part.text}
        query={query}
      />
      <ChatMedia text={part.text} compact={compactMedia} uploads={uploads} />
      {part.truncated && <div className="text-xs text-muted-foreground">… truncated</div>}
    </div>
  );
}

/** The images an entry holds inline, as one gallery; the user's sit in the bubble like uploads. */
function EntryImages({ entry }: { entry: TranscriptEntry }) {
  const images = journalImages(entry);
  return images.length ? <JournalImages entry={entry.uuid} images={images} className="pt-1" /> : null;
}

function Turn({
  entry,
  showHeader,
  query,
  focused = false,
}: {
  entry: TranscriptEntry;
  /** False for a turn continuing the same speaker's run: only the run's first bubble shows its time. */
  showHeader: boolean;
  query: string;
  focused?: boolean;
}) {
  const time = clockTime(entry.ts);
  const inline = journalImages(entry).length > 0;

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
        {shownParts(entry).map((part, i) => (
          <Part key={i} part={part} entryId={entry.uuid} query={query} focused={focused} />
        ))}
        <EntryImages entry={entry} />
      </div>
    );
  }

  // A chat, not a log: your messages are soft bubbles on the right, the agent's are plain text on
  // the left. The header already names the agent, so neither side repeats a speaker label; the time
  // sits under your bubble and on hover for the agent.
  if (entry.role === "user") {
    return (
      <div data-speaker="user" className="flex flex-col items-end" title={time || undefined}>
        <div className="max-w-[85%] min-w-0 space-y-1.5 rounded-2xl rounded-br-md bg-muted px-3.5 py-2 [overflow-wrap:anywhere]">
          {shownParts(entry).map((part, i) => (
            <Part key={i} part={part} entryId={entry.uuid} query={query} focused={focused} compactMedia uploads={!inline} />
          ))}
          <EntryImages entry={entry} />
        </div>
        {showHeader && time && <span className="mt-1 px-1 text-[11px] leading-none text-muted-foreground/70">{time}</span>}
      </div>
    );
  }
  return (
    <div data-speaker="assistant" className="space-y-1.5 px-0.5" title={time || undefined}>
      {shownParts(entry).map((part, i) => (
        <Part key={i} part={part} entryId={entry.uuid} query={query} focused={focused} />
      ))}
      <EntryImages entry={entry} />
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
      ? <WorkLogTools key={block.entries[0]!.uuid} calls={block.entries.flatMap((entry) => entry.parts.flatMap((part, index) => part.kind === "tool" ? [{ id: `${entry.uuid}:${index}`, entryId: index === 0 ? entry.uuid : undefined, owner: entry.uuid, part }] : []))} query={query} focusedEntryId={focusedUuid} active={active} />
      : <div key={block.entry.uuid} data-turn={block.entry.uuid} className={focusedUuid === block.entry.uuid ? "rounded ring-2 ring-primary/60" : undefined}>
          {shownParts(block.entry).map((part, index) => <Part key={index} part={part} entryId={block.entry.uuid} query={query} focused={focusedUuid === block.entry.uuid} active={active} />)}
          <EntryImages entry={block.entry} />
        </div>)}
  </div>;
}

function WorkTurnView({ turn, query, focusedUuid, questionActive }: { turn: WorkTurn; query: string; focusedUuid?: string; questionActive: boolean }) {
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
  const viewer = useContext(MediaViewerContext);
  const toolImages = useToolImages();
  // Folded work still shows what the agent looked at, as one gallery for the turn.
  const turnImages: StripImage[] = open ? [] : relabel(turn.activity.flatMap((entry) => [
    ...shownParts(entry).flatMap((part) => part.kind === "tool" ? toolImages(part, entry.uuid) : []),
    ...journalImages(entry).map(({ index }) => ({ src: viewer?.journalUrl(entry.uuid, index), label: imageLabel(0), item: { kind: "journal" as const, entry: entry.uuid, index, label: imageLabel(0) } })),
  ]));
  const answerPaths = turn.answer ? shownParts(turn.answer).flatMap((part) => part.kind === "text" ? filePathsInText(part.text) : []) : [];
  const delivered = [...new Set(turn.activity.flatMap((entry) => shownParts(entry).flatMap(sentFiles)))]
    .filter((path) => !IMAGE_EXTENSION.test(path) && !answerPaths.some((mention) => path === mention || path.endsWith(`/${mention.replace(/^\.\//, "")}`)));
  return <div className="space-y-2" data-work-turn={turn.id}>
    <button type="button" data-work-toggle aria-expanded={open} disabled={!hasDetails}
      onClick={() => setExpanded(!open)} className="flex min-h-11 max-w-full flex-wrap items-center gap-x-1.5 gap-y-0 text-left text-xs text-muted-foreground hover:text-foreground disabled:opacity-100 md:min-h-7">
      <ChevronRight aria-hidden="true" className={`size-3.5 shrink-0 ${open ? "rotate-90" : ""}`} />
      {turn.active ? <WorkActivityLabel startedAt={turn.startedAt} thinking={lastPart?.kind === "thinking"} /> : <span>{label}{turn.settled ? duration : ""}</span>}
      {tools.length > 0 && <span className="whitespace-nowrap">· {tools.length} tool {tools.length === 1 ? "call" : "calls"}</span>}
      {failures > 0 && <span className="whitespace-nowrap text-destructive">· {failures} {failures === 1 ? "error" : "errors"}</span>}
      {truncated && <span className="whitespace-nowrap">· truncated</span>}
    </button>
    {tools.flatMap((part, toolIndex) => (part.questions ?? []).map((question, index) =>
      <TranscriptQuestion key={`${toolIndex}:${index}`} {...question} active={questionActive} />))}
    {open && <ActivityLog entries={turn.activity} query={query} focusedUuid={focusedUuid} active={turn.active} />}
    {turn.answer && <div data-turn={turn.activity.some((entry) => entry.uuid === turn.answer!.uuid) ? undefined : turn.answer.uuid}
      className={turn.answer.uuid === focusedUuid ? "rounded ring-2 ring-primary/60" : undefined}>
      <Turn entry={turn.answer} showHeader query={query} focused={turn.answer.uuid === focusedUuid} />
    </div>}
    <ArtifactCards paths={delivered} />
    <ImageStrip images={turnImages} max={3} label="Images from this turn" />
  </div>;
}

export function TranscriptView({ entries, query = "", focusedUuid, activityStatus, onWorkToggle }: {
  entries: TranscriptEntry[];
  query?: string;
  focusedUuid?: string;
  activityStatus?: AgentStatus;
  onWorkToggle?: (anchor: HTMLElement) => void;
}) {
  // A question is pending until its call has a result: Claude records the answer as the
  // AskUserQuestion tool_result, which can land without any user-typed turn after it.
  const questionIndex = entries.findLastIndex((entry) => entry.parts.some((part) => part.kind === "tool" && part.questions?.length));
  const questionOpen = entries[questionIndex]?.parts.some((part) => part.kind === "tool" && !!part.questions?.length && !part.result);
  const pendingQuestion = questionOpen && questionIndex > entries.findLastIndex((entry) => entry.role === "user") ? entries[questionIndex]?.uuid : undefined;
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
        {newDay && <div className="pt-1 text-center text-[11px] text-muted-foreground/70">{day}</div>}
        {row.kind === "message" ? <Turn entry={entry} showHeader={showHeader} query={query} focused={entry.uuid === focusedUuid} />
          : <WorkTurnView turn={row} query={query} focusedUuid={focusedUuid} questionActive={row.entries.some((entry) => entry.uuid === pendingQuestion)} />}
      </div>;
    })}
    {pending && <div className="px-0.5 py-1" role="status"><WorkActivityLabel startedAt={last?.role === "user" ? last.ts : undefined} /></div>}
  </div>;
}
