import { QuestionLiveContext, TranscriptQuestion } from "./transcript-question";
import { FileMediaContext } from "@/lib/file-preview-context";
import { filePathsInText, sentFiles } from "@/lib/chat-files";
import { IMAGE_EXTENSION, imageLabel, journalImages, splitMessageImages } from "@/lib/message-images";
import { ArtifactCards } from "./artifact-card";
import { ChatMedia } from "./chat-media";
import { MediaViewerContext } from "./file-preview-provider";
import { ImageStrip, JournalImages, type StripImage } from "./message-images";
import { useContext, useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "@/components/ui/icon";

import { CopyButton, QUIET_ACTION } from "@/components/copy-button";
import { MarkdownText } from "@/components/markdown-text";
import { clockTime as formatClock } from "@/lib/format";
import { cn } from "@/lib/utils";
import { searchableText } from "@/lib/transcript-search";
import { containsQuery, DeskLiveStep, Highlight, LiveStepRow, relabel, ThinkingStep, ToolStep, useToolImages, WorkSteps } from "@/components/work-log-tools";
import { useMediaQuery } from "@/hooks/use-media-query";
import { Elapsed, WorkActivityLabel } from "@/components/work-activity-label";
import { buildWorkTimeline, describeTool, formatWorkDuration, liveStep, workSegments, type LiveStep, type WorkTurn } from "@/lib/work-timeline";
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
  const ts = iso ? Date.parse(iso) : NaN;
  return Number.isNaN(ts) ? "" : formatClock(ts);
}

function dayKey(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString(undefined, { dateStyle: "medium" });
}

const META_LINE = "flex min-h-8 max-w-full items-center gap-2 text-left text-footnote text-muted-foreground";

/** Injected text as one quiet line: a loaded skill, a notification. It opens onto its body when it has more than its caption. */
function ContextLine({ label, text, truncated, query, focused = false }: { label: string; text: string; truncated?: boolean; query: string; focused?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const caption = <span className="min-w-0 truncate"><Highlight text={label} query={query} current={focused} /></span>;
  if (text.trim() === "" || text.trim() === label) return <div data-notice className={META_LINE}>
    <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center"><span className="size-1 rounded-full bg-current" /></span>
    {caption}
  </div>;
  const open = expanded || focused || containsQuery(text, query);
  return <div data-notice>
    <button type="button" data-work-toggle aria-expanded={open} onClick={() => setExpanded((value) => !value)} className={`${META_LINE} hover:text-foreground coarse:min-h-11`}>
      <ChevronRight aria-hidden="true" className={`size-4 shrink-0 p-px ${open ? "rotate-90" : ""}`} />
      {caption}
    </button>
    {open && <div className="pb-2 pl-6 text-muted-foreground [overflow-wrap:anywhere] select-text"><MarkdownText text={text} query={query} current={focused} />
      {truncated && <p className="text-footnote">… truncated</p>}</div>}
  </div>;
}

/** Compaction marks where the session's earlier context was summarised: a divider, with the summary behind it. */
function CompactionLine({ text, time, truncated, query, focused = false }: { text: string; time: string; truncated: boolean; query: string; focused?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const open = expanded || focused || containsQuery(text, query);
  const rule = <span aria-hidden="true" className="h-px min-w-6 flex-1 bg-border" />;
  const caption = <span className="shrink-0"><Highlight text="Context compacted" query={query} current={focused} />{time && ` · ${time}`}</span>;
  if (!text) return <div data-notice className="flex min-h-8 items-center gap-3 text-footnote text-muted-foreground">{rule}{caption}{rule}</div>;
  return <div data-notice>
    <button type="button" data-work-toggle aria-expanded={open} onClick={() => setExpanded((value) => !value)}
      className="flex min-h-8 w-full items-center gap-3 text-footnote text-muted-foreground hover:text-foreground coarse:min-h-11">
      {rule}
      <span className="flex shrink-0 items-center gap-1">{caption}
        <ChevronDown aria-hidden="true" className={`size-3.5 shrink-0 transition-transform motion-reduce:transition-none ${open ? "rotate-180" : ""}`} />
      </span>
      {rule}
    </button>
    {open && <div className="pb-2 text-muted-foreground [overflow-wrap:anywhere]"><MarkdownText text={text} query={query} current={focused} />
      {truncated && <p className="text-footnote">… truncated</p>}</div>}
  </div>;
}

/**
 * A note's part as its line. The web is live the moment it is built and the bridge only after a
 * restart, so an older bridge's plain-text note is drawn the same way: its first line, the rest behind it.
 */
function NoteLine({ part, query, focused }: { part: TranscriptPart; query: string; focused: boolean }) {
  if (part.kind === "context") return <ContextLine {...part} query={query} focused={focused} />;
  if (part.kind !== "text") return null;
  const [first = ""] = part.text.trim().split("\n", 1);
  return <ContextLine label={first} text={part.text} truncated={part.truncated} query={query} focused={focused} />;
}

function Part({ part, entryId, id = entryId, query, focused = false, active = false, waiting = false, compactMedia = false, uploads = true, delivers = true }: {
  part: TranscriptPart;
  entryId: string;
  /** The step's own key in the timeline, when an entry holds several. */
  id?: string;
  query: string;
  focused?: boolean;
  active?: boolean;
  /** This call is what a live dialog asks the operator about. */
  waiting?: boolean;
  compactMedia?: boolean;
  /** False when the entry's journal already holds its images, so upload paths don't show them twice. */
  uploads?: boolean;
  /** False for text that names files without handing them over: no cards, no thumbnails. */
  delivers?: boolean;
}) {
  const media = useContext(FileMediaContext);
  // Inline journal images render as one strip per entry (EntryImages), not part by part.
  if (part.kind === "image") return null;
  // Tool output is COMMAND output, not prose — it stays verbatim in a monospace block (see ToolPart).
  if (part.kind === "tool") return <ToolStep id={id} part={part} owner={entryId} query={query} active={active} focused={focused} waiting={waiting} />;
  if (part.kind === "thinking") return <ThinkingStep text={part.text} truncated={part.truncated} query={query} focused={focused} />;
  if (part.kind === "context") return <ContextLine {...part} query={query} focused={focused} />;
  // Prose is Markdown, so it renders formatted. MarkdownText emits React elements only — never
  // markup — so this keeps the same XSS boundary the raw text node had.
  return (
    <div>
      <MarkdownText
        text={compactMedia && media ? splitMessageImages(part.text).text : part.text}
        query={query}
        current={focused}
      />
      {delivers && <ChatMedia text={part.text} compact={compactMedia} uploads={uploads} />}
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
  stamp,
}: {
  entry: TranscriptEntry;
  /** False for a turn continuing the same speaker's run: only the run's first bubble shows its time. */
  showHeader: boolean;
  query: string;
  focused?: boolean;
  /** The time a turn's answer shows beside its Copy: when the turn finished, or "" for none. */
  stamp?: string;
}) {
  const time = clockTime(entry.ts);
  const inline = journalImages(entry).length > 0;

  // Neither of these is speech, so each is one quiet line, attributed to neither party, its body
  // folded behind it. Their file names stay text: a recap or an injected note names files relative
  // to folders of its own, it does not deliver them.
  if (entry.role === "summary" || entry.role === "note") {
    const recap = entry.parts.map((part) => (part.kind === "text" ? part.text : "")).join("\n\n").trim();
    return (
      <div title={time || undefined}>
        {entry.role === "summary"
          ? <CompactionLine text={recap} time={time}
              truncated={entry.parts.some((part) => part.kind === "text" && part.truncated)} query={query} focused={focused} />
          : entry.parts.map((part, i) => <NoteLine key={i} part={part} query={query} focused={focused} />)}
        <EntryImages entry={entry} />
      </div>
    );
  }

  // A chat, not a log: your messages are soft bubbles on the right, raised a step off the page as the
  // composer is, and the agent's are plain text on the left. The header already names the agent, so
  // neither side repeats a speaker label; the time sits under your bubble, beside a finished turn's
  // Copy, and on hover for the agent.
  // What a command of theirs loaded (a skill's body) is not their words: a line beside the bubble.
  if (entry.role === "user") {
    const loaded = entry.parts.filter((part) => part.kind === "context");
    return (
      <div data-speaker="user" className="flex flex-col items-end" title={time || undefined}>
        <div className="max-w-[min(85%,28rem)] min-w-0 space-y-1.5 rounded-xl border bg-card px-3.5 py-2.5 [overflow-wrap:anywhere] select-text">
          {entry.parts.map((part, i) => part.kind === "context" ? null : (
            <Part key={i} part={part} entryId={entry.uuid} query={query} focused={focused} compactMedia uploads={!inline} />
          ))}
          <EntryImages entry={entry} />
        </div>
        {showHeader && time && <time dateTime={entry.ts} className="mt-1 px-1 text-footnote leading-none text-muted-foreground">{time}</time>}
        {loaded.map((part, i) => <div key={i} className="max-w-[85%] min-w-0"><ContextLine {...part} query={query} focused={focused} /></div>)}
      </div>
    );
  }
  // Their words, as they wrote them (Markdown), for pasting anywhere else.
  const words = entry.parts.flatMap((part) => (part.kind === "text" ? [part.text] : [])).join("\n\n");
  return (
    <div data-speaker="assistant" className="space-y-1.5 px-0.5 select-text" title={time || undefined}>
      {entry.parts.map((part, i) => (
        <Part key={i} part={part} entryId={entry.uuid} query={query} focused={focused} />
      ))}
      <EntryImages entry={entry} />
      {(words.trim() || stamp) && <div className="flex items-center gap-1 text-footnote text-subtle-foreground">
        {words.trim() && <CopyButton what="message" iconOnly payload={() => ({ text: words })}
          className={cn(QUIET_ACTION, "-ml-1.5 min-w-7 justify-center px-1.5 text-subtle-foreground")} />}
        {stamp && <time dateTime={entry.ts}>{stamp}</time>}
      </div>}
    </div>
  );
}

/** The parts of an entry that draw as steps: images go to one gallery, the live step to the bottom row. */
function stepParts(entry: TranscriptEntry, live: LiveStep | null) {
  return entry.parts.flatMap((part, index) => part.kind === "image" || (live?.entry === entry.uuid && live.index === index) ? [] : [{ part, index }]);
}

/**
 * The call a live dialog asks the operator about, as `entry:index`: a question the turn asks, or else
 * the first call still without its result, the one the agent stopped at. Never a subagent's call: what
 * waits there is a call inside the subagent, so its own call runs on.
 */
function askedCall(turn: WorkTurn): string | undefined {
  const pending = turn.activity.flatMap((entry) => entry.parts.flatMap((part, index) =>
    part.kind === "tool" && !part.result && describeTool(part.name).kind !== "agent" ? [{ part, id: `${entry.uuid}:${index}` }] : []));
  return (pending.find(({ part }) => part.questions?.length) ?? pending[0])?.id;
}

/** A turn's work, one step per row, in the order it happened. */
function ActivityLog({ entries, query, focusedUuid, active, asked, live, className }: { entries: TranscriptEntry[]; query: string; focusedUuid?: string; active: boolean; asked?: string; live: LiveStep | null; className?: string }) {
  return <ol data-work-log className={cn("min-w-0 select-text", className)}>
    {entries.map((entry) => {
      const steps = stepParts(entry, live);
      if (!steps.length && !journalImages(entry).length) return null;
      const focused = focusedUuid === entry.uuid;
      return <li key={entry.uuid} data-turn={entry.uuid} className={focused ? "rounded ring-2 ring-primary/60" : undefined}>
        {steps.map(({ part, index }) => {
          const id = `${entry.uuid}:${index}`;
          return <Part key={index} part={part} entryId={entry.uuid} id={id} query={query} focused={focused} active={active} waiting={id === asked} />;
        })}
        <EntryImages entry={entry} />
      </li>;
    })}
  </ol>;
}

/**
 * A desk's turn: the agent's words between its runs of steps, each run one fold, and the step in
 * progress below them all. Nothing folds the turn as a whole, so what the agent said stays in reach.
 */
function DeskWork({ turn, query, focusedUuid, waiting, asked, live, liveMarker }: { turn: WorkTurn; query: string; focusedUuid?: string; waiting: boolean; asked?: string; live: LiveStep | null; liveMarker?: string }) {
  const duration = turn.durationMs !== undefined ? formatWorkDuration(turn.durationMs) : "";
  return <>
    {workSegments(turn.activity, live).map((segment) => segment.kind === "steps"
      ? <WorkSteps key={segment.id} steps={segment.steps} query={query} focusedUuid={focusedUuid} active={turn.active || waiting} asked={asked} />
      : <div key={`${segment.entry.uuid}:${segment.parts[0]!.index}`} data-turn={segment.entry.uuid} data-speaker="assistant"
          className={cn("space-y-1.5 px-0.5 select-text", segment.entry.uuid === focusedUuid && "rounded ring-2 ring-primary/60")}>
          {segment.parts.map(({ part, index }) => <Part key={index} part={part} entryId={segment.entry.uuid} query={query} focused={segment.entry.uuid === focusedUuid} />)}
        </div>)}
    {live && <DeskLiveStep step={live} query={query} focused={live.entry === focusedUuid} marker={liveMarker} waiting={asked === `${live.entry}:${live.index}`} />}
    {turn.active && !live && <p className="min-h-8 text-footnote text-muted-foreground"><Elapsed since={turn.startedAt} prefix="Working for " fallback="Working…" /></p>}
    {turn.interrupted && <p className="text-footnote text-muted-foreground">{duration ? `Stopped after ${duration}` : "Stopped"}</p>}
  </>;
}

function WorkTurnView({ turn, query, focusedUuid, questionActive, waiting, desk }: { turn: WorkTurn; query: string; focusedUuid?: string; questionActive: boolean; waiting: boolean; desk: boolean }) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const needle = query.trim().toLowerCase();
  const searching = turn.activity.some((entry) => entry.uuid === focusedUuid || (needle !== "" && searchableText(entry).toLowerCase().includes(needle)));
  const open = searching || (expanded ?? !turn.settled);
  const tools = turn.activity.flatMap((entry) => entry.parts.filter((part) => part.kind === "tool"));
  const failures = tools.filter((part) => part.result?.isError).length;
  const live = liveStep(turn);
  // A turn held up by a dialog has not ended: the call the dialog asks about waits, the others run on.
  const asked = waiting ? askedCall(turn) : undefined;
  const hasDetails = turn.activity.some((entry) => stepParts(entry, live).length > 0 || journalImages(entry).length > 0);
  const duration = turn.settled && turn.durationMs !== undefined ? formatWorkDuration(turn.durationMs) : "";
  const label = turn.interrupted ? (duration ? "Stopped after" : "Stopped") : turn.settled ? "Worked" : "Work log";
  // One time per turn, when it finished, beside its answer's Copy (or on its line when it has no
  // answer). The question's time is already under its bubble, so a turn that ends in the minute it
  // started says it no second time.
  const end = turn.settled ? turn.entries.at(-1)?.ts ?? "" : "";
  const finished = clockTime(end);
  const endTime = finished !== clockTime(turn.startedAt ?? "") ? finished : "";
  // The live step's own entry may have nothing else to draw; the live row then carries its scroll marker.
  const liveEntry = live?.entry ? turn.activity.find((entry) => entry.uuid === live.entry) : undefined;
  const liveMarker = liveEntry && !stepParts(liveEntry, live).length && !journalImages(liveEntry).length ? liveEntry.uuid : undefined;
  const viewer = useContext(MediaViewerContext);
  const toolImages = useToolImages();
  // Folded work still shows what the agent looked at, as one gallery for the turn; a desk's runs never
  // draw their images, so its gallery stays.
  const turnImages: StripImage[] = open && !desk ? [] : relabel(turn.activity.flatMap((entry) => [
    ...entry.parts.flatMap((part) => part.kind === "tool" ? toolImages(part, entry.uuid) : []),
    ...journalImages(entry).map(({ index }) => ({ src: viewer?.journalUrl(entry.uuid, index), label: imageLabel(0), item: { kind: "journal" as const, entry: entry.uuid, index, label: imageLabel(0) } })),
  ]));
  const answerPaths = turn.answer ? turn.answer.parts.flatMap((part) => part.kind === "text" ? filePathsInText(part.text) : []) : [];
  const delivered = [...new Set(turn.activity.flatMap((entry) => entry.parts.flatMap(sentFiles)))]
    .filter((path) => !IMAGE_EXTENSION.test(path) && !answerPaths.some((mention) => path === mention || path.endsWith(`/${mention.replace(/^\.\//, "")}`)));
  // The line reads as the board's "Worked 1m 52s": the duration a step quieter than the word, and the
  // chevron after them, shown under a finger and, under a pointer, once the line is hovered or open.
  // The line holds nothing but its toggle unless a turn with no answer keeps its time beside it.
  const line = <button type="button" data-work-toggle aria-expanded={open} disabled={!hasDetails} onClick={() => setExpanded(!open)}
    className="group flex min-h-8 w-fit max-w-full min-w-0 items-center gap-1.5 text-left text-footnote text-muted-foreground hover:text-foreground disabled:opacity-100 coarse:min-h-11">
    {turn.active ? <Elapsed since={turn.startedAt} prefix="Working for " fallback="Working…" />
      : <>{label} {duration && <span className="text-subtle-foreground">{duration}</span>}</>}
    {failures > 0 && <span className="whitespace-nowrap text-destructive">· {failures} failed</span>}
    {hasDetails && <ChevronRight aria-hidden="true" className={cn("size-3.5 shrink-0 transition-[rotate,opacity] duration-150 ease-out motion-reduce:transition-none",
      open ? "rotate-90" : "pointer-fine:opacity-0 pointer-fine:group-hover:opacity-100 pointer-fine:group-focus-visible:opacity-100")} />}
  </button>;
  const questions = tools.flatMap((part, toolIndex) => (part.questions ?? []).map((question, index) =>
    <TranscriptQuestion key={`${toolIndex}:${index}`} {...question} active={questionActive && !part.result} />));
  const answer = turn.answer && <div data-turn={turn.activity.some((entry) => entry.uuid === turn.answer!.uuid) ? undefined : turn.answer.uuid}
    className={turn.answer.uuid === focusedUuid ? "rounded ring-2 ring-primary/60" : undefined}>
    <Turn entry={turn.answer} showHeader query={query} focused={turn.answer.uuid === focusedUuid} stamp={endTime} />
  </div>;
  if (desk) return <div className="space-y-3" data-work-turn={turn.id}>
    {questions}
    <DeskWork turn={turn} query={query} focusedUuid={focusedUuid} waiting={waiting} asked={asked} live={live} liveMarker={liveMarker} />
    {answer}
    {endTime && !turn.answer && <p className="text-footnote text-muted-foreground"><time dateTime={end}>{endTime}</time></p>}
    <ArtifactCards paths={delivered} />
    <ImageStrip images={turnImages} max={3} label="Images from this turn" />
  </div>;
  return <div className="space-y-2" data-work-turn={turn.id}>
    {endTime && !turn.answer ? <div className="flex max-w-full flex-wrap items-center gap-x-1.5 text-footnote text-muted-foreground">
      {line}<span className="whitespace-nowrap">· <time dateTime={end}>{endTime}</time></span>
    </div> : line}
    {questions}
    {/* While the turn runs, its steps are part of the conversation: they flow under its line, no rail
        and no indent, its live row last. Finished, they fold away; opened again, the rail under the
        line ties them to it. */}
    {(open || live) && <div className={turn.settled ? "ml-[7px] min-w-0 border-l pl-3" : "min-w-0"}>
      {/* Opened by a tap, the steps fade in under the line; opened on their own (a running turn, a
          search hit), they are simply there. */}
      {open && <ActivityLog entries={turn.activity} query={query} focusedUuid={focusedUuid} active={turn.active || waiting} asked={asked} live={live}
        className={expanded ? "animate-in fade-in slide-in-from-top-1 duration-200 ease-out motion-reduce:animate-none" : undefined} />}
      {live && <LiveStepRow step={live} query={query} focused={live.entry === focusedUuid} marker={liveMarker} waiting={asked === `${live.entry}:${live.index}`} />}
    </div>}
    {answer}
    <ArtifactCards paths={delivered} />
    <ImageStrip images={turnImages} max={3} label="Images from this turn" />
  </div>;
}

export function TranscriptView({ entries, query = "", focusedUuid, activityStatus, activityLabel = true, onWorkToggle }: {
  entries: TranscriptEntry[];
  query?: string;
  focusedUuid?: string;
  activityStatus?: AgentStatus;
  /** False while the trailing Working… belongs under a message the journal does not show yet. */
  activityLabel?: boolean;
  onWorkToggle?: (anchor: HTMLElement) => void;
}) {
  // A question is pending until its call has a result: Claude records the answer as the
  // AskUserQuestion tool_result, which can land without any user-typed turn after it.
  const questionIndex = entries.findLastIndex((entry) => entry.parts.some((part) => part.kind === "tool" && part.questions?.length));
  const questionOpen = entries[questionIndex]?.parts.some((part) => part.kind === "tool" && !!part.questions?.length && !part.result);
  const pendingQuestion = questionOpen && questionIndex > entries.findLastIndex((entry) => entry.role === "user") ? entries[questionIndex]?.uuid : undefined;
  const rows = useMemo(() => buildWorkTimeline(entries, activityStatus), [entries, activityStatus]);
  const desk = useMediaQuery("(min-width: 1024px)");
  // While a dialog waits on the operator, the newest turn, if it has not ended, is the one it holds up.
  const dialogLive = useContext(QuestionLiveContext) !== null;
  const tail = rows.at(-1);
  const waitingTurn = dialogLive && tail?.kind === "work" && !tail.settled ? tail.id : undefined;
  let lastDay = "";
  let lastRole = "";
  const last = entries.at(-1);
  const pending = activityLabel && activityStatus === "working" && !rows.some((row) => row.kind === "work" && row.active) &&
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
        {newDay && <div className="pt-1 text-center text-footnote text-muted-foreground"><time dateTime={entry.ts}>{day}</time></div>}
        {row.kind === "message" ? <Turn entry={entry} showHeader={showHeader} query={query} focused={entry.uuid === focusedUuid} />
          : <WorkTurnView turn={row} query={query} focusedUuid={focusedUuid} questionActive={row.entries.some((entry) => entry.uuid === pendingQuestion)} waiting={row.id === waitingTurn} desk={desk} />}
      </div>;
    })}
    {pending && <div className="px-0.5 py-1" role="status"><WorkActivityLabel startedAt={last?.role === "user" ? last.ts : undefined} /></div>}
  </div>;
}
