import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { Sparkle, ChevronDown, ChevronRight, FilePen, FilePlus, FileText, Globe, ListTodo, ChatCircleDots, Search, SquareTerminal, Wrench, type IconComponent } from "@/components/ui/icon";
import { displayPath } from "@/lib/display-path";
import { FileMediaContext } from "@/lib/file-preview-context";
import { localFilePath } from "@/lib/file-links";
import { IMAGE_EXTENSION, imageLabel } from "@/lib/message-images";
import { splitHighlight } from "@/lib/transcript-search";
import type { TranscriptPart } from "@/lib/types";
import { cn } from "@/lib/utils";
import { commandOutput, describeTool, firstLine, QUESTION_STEP, stepsDiff, stepsSummary, type LiveStep, type StepKind, type ToolStepDescription, type WorkStep } from "@/lib/work-timeline";
import { DiffStat } from "./diff-stat";
import { FIND_CURRENT_HIT, FIND_HIT, MarkdownText } from "./markdown-text";
import { MediaViewerContext, type MediaViewer } from "./file-preview-provider";
import { ImageStrip, type StripImage } from "./message-images";
import { Elapsed, LiveGlyph } from "./work-activity-label";

// A turn's work as a timeline: one line per step, its icon, a verb and what it acted on, in the quiet
// greys, so the steps read as the agent working and its prose as what it says. A step with
// a body (a call's output, a whole thought) opens it under its line; nothing groups steps behind a
// second fold, so a failure is one tap from its output once the turn is open.

type ToolPart = Extract<TranscriptPart, { kind: "tool" }>;

/** The pane's folder: a step's path reads from it, as the operator names files inside the project. */
export const PaneCwdContext = createContext("");

/** Whether `text` holds the searched words: a folded body that does opens, so the hit is on screen. */
export function containsQuery(text: string, query: string): boolean {
  const needle = query.trim().toLowerCase();
  return needle !== "" && text.toLowerCase().includes(needle);
}

function matches(part: ToolPart, query: string) {
  return [part.name, part.summary, part.result?.text ?? ""].some((text) => containsQuery(text, query));
}

/** `text` with find's hits marked; `current` when it belongs to find's current match, whose hits go solid. */
export function Highlight({ text, query, current = false }: { text: string; query: string; current?: boolean }) {
  return <>{splitHighlight(text, query).map((piece, index) => piece.hit
    ? <mark key={index} aria-current={current || undefined} className={cn(FIND_HIT, current && FIND_CURRENT_HIT)}>{piece.text}</mark>
    : <span key={index}>{piece.text}</span>)}</>;
}

// Tools that show the model an image by path; their summary is the path they read.
const VIEW_TOOL = /^(read|view_?image|read_?file|view)$/i;

/**
 * What a call showed the agent: images its result carries in the journal, image files it delivered,
 * or the image a read tool opened by path. Journal images need their entry (`owner`) and the viewer.
 */
function toolImages(part: ToolPart, owner: string | undefined, viewer: MediaViewer | null, url: ((path: string) => string) | null): StripImage[] {
  const attachments = part.result?.attachments ?? [];
  const inline = attachments.flatMap((a) => a.kind === "image" ? [a] : []);
  if (inline.length) return owner ? inline.map(({ index }, i) => ({
    src: viewer?.journalUrl(owner, index), label: imageLabel(i), item: { kind: "journal", entry: owner, index, label: imageLabel(i) },
  })) : [];
  const read = VIEW_TOOL.test(part.name) && !part.result?.isError ? localFilePath(part.summary) : null;
  const files = [...attachments.flatMap((a) => a.kind === "file" ? [a.path] : []), ...(read ? [read] : [])].filter((path) => IMAGE_EXTENSION.test(path));
  return url ? files.map((path) => ({ src: url(path), label: path.split("/").at(-1) ?? path, item: { kind: "file", path } })) : [];
}

/** One gallery across several calls numbers its images once, in order. */
export function relabel(images: StripImage[]): StripImage[] {
  return images.map((image, i) => image.item.kind === "journal"
    ? { ...image, label: imageLabel(i), item: { ...image.item, label: imageLabel(i) } }
    : image);
}

export function useToolImages() {
  const viewer = useContext(MediaViewerContext);
  const url = useContext(FileMediaContext);
  return (part: ToolPart, owner?: string) => toolImages(part, owner, viewer, url);
}

const STEP_ICONS: Record<StepKind | "thinking", IconComponent> = {
  terminal: SquareTerminal, read: FileText, edit: FilePen, write: FilePlus, search: Search, web: Globe, agent: Sparkle, plan: ListTodo, tool: Wrench,
  question: ChatCircleDots, thinking: Sparkle,
};

/**
 * A plan's title from its summary, which the journal keeps as one line: up to its next heading, and
 * without the "Plan:" Claude opens most of them with, since the line already says Plan.
 */
function planTitle(summary: string): string {
  return firstLine(summary.split(/\s#{1,6}\s/, 1)[0] ?? "").replace(/^Plan:\s*/i, "");
}

/**
 * A call as its line draws it: the timeline's description and the words that say what it acted on. A
 * call that asks the operator reads by what it asks, not by the CLI's name for it: a Question with the
 * question it asks, a Plan with the plan's title.
 */
function describeCall(part: ToolPart): ToolStepDescription & { text: string } {
  const question = part.questions?.[0]?.title;
  if (question) return { ...QUESTION_STEP, text: question };
  const step = describeTool(part.name);
  return { ...step, text: step.target === "title" ? planTitle(part.summary) : part.summary };
}

// 36px on a mouse, 44px under a finger, both from padding around one 20px line.
const LINE = "flex w-full min-w-0 items-center gap-2 py-2 text-left text-subhead min-h-9 coarse:min-h-11";

/** A step in progress: its line carries the live glyph for its icon, and how long it has run. */
type Live = Pick<LiveStep, "since">;

/**
 * A step's line. With `onToggle` it is the button that opens the step's body; without, it keeps the
 * chevron's place, so whatever ends a line sits in one column down the timeline. A toggle reports
 * itself (`data-work-toggle`) so the thread holds still and stops following. The live step is the
 * tail the thread follows, so it opens without reporting and the thread keeps following it.
 */
function StepLine({ icon, live, label, expanded, controls, onToggle, children }: {
  icon: ReactNode;
  live?: Live;
  label?: string;
  expanded?: boolean;
  controls?: string;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const lead = live ? <LiveGlyph /> : icon;
  const time = live?.since && <Elapsed since={live.since} className="shrink-0 text-footnote text-muted-foreground" />;
  if (!onToggle) return <div className={LINE}>{lead}{children}{time}<span aria-hidden="true" className="size-3.5 shrink-0" /></div>;
  return <button type="button" data-work-toggle={live ? undefined : true} aria-label={label} aria-expanded={expanded} aria-controls={controls} onClick={onToggle}
    className={cn(LINE, "group")}>
    {lead}{children}{time}
    <ChevronRight aria-hidden="true" className={`size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:text-foreground motion-reduce:transition-none ${expanded ? "rotate-90" : ""}`} />
  </button>;
}

function StepIcon({ kind }: { kind: StepKind | "thinking" }) {
  const Icon = STEP_ICONS[kind];
  return <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />;
}

/**
 * What a step acted on: a path shows its folders muted and its file name whole, code stays monospace.
 * The folders give up whole leading segments first, then lose characters from their start (the rtl
 * box puts the ellipsis on the left), so the folders nearest the file are the ones that stay.
 */
function StepTarget({ text, format, query, current }: { text: string; format: ToolStepDescription["target"] | "thought"; query: string; current: boolean }) {
  const cwd = useContext(PaneCwdContext);
  if (!text) return <span className="flex-1" />;
  if (format === "path") {
    const { dir, base } = displayPath(text, cwd, 32);
    return <span className="flex min-w-0 flex-1">
      {dir && <span className="min-w-0 truncate text-subtle-foreground [direction:rtl]"><span dir="ltr"><Highlight text={dir} query={query} current={current} /></span></span>}
      <span className="max-w-full shrink-0 truncate text-muted-foreground"><Highlight text={base} query={query} current={current} /></span>
    </span>;
  }
  return <span className={cn("min-w-0 flex-1 truncate text-subtle-foreground", format === "code" && "font-mono text-code", format === "thought" && "italic")}>
    <Highlight text={text} query={query} current={current} />
  </span>;
}

/** A step's path as its row reads it whole, for the row's name: what a voice command says is what it sees. */
function spokenPath(path: string, cwd: string): string {
  const { dir, base } = displayPath(path, cwd, Infinity);
  return dir + base;
}

/** A finished step that failed says so on its line, so the failure shows before anything opens. */
function FailedChip() {
  return <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-destructive/40 px-2 text-caption text-destructive">
    <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />Failed
  </span>;
}

/** A call the operator has to answer for says so on its line: the blocked dot, and the words plain (direction.md). */
function WaitingChip() {
  return <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 text-caption text-foreground">
    <span aria-hidden="true" className="size-1.5 rounded-full bg-status-blocked" />Waiting on you
  </span>;
}

const OUTPUT = "min-w-0 font-mono text-code whitespace-pre-wrap [overflow-wrap:anywhere]";

/**
 * A tool call as one step. Its output stays verbatim text, never Markdown (the XSS boundary). A call
 * `waiting` is the one a live dialog asks the operator about: it has not run, so it reads as the
 * request, with no clock and no claim about its output.
 */
export function ToolStep({ id, part, owner, query, active, focused, live, waiting = false }: { id: string; part: ToolPart; owner?: string; query: string; active: boolean; focused: boolean; live?: Live; waiting?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const images = useToolImages();
  const open = expanded || focused || matches(part, query);
  const step = describeCall(part);
  const cwd = useContext(PaneCwdContext);
  const target = step.target === "path" && step.text ? spokenPath(step.text, cwd) : step.text;
  const failed = !!part.result?.isError;
  const asking = waiting && !part.result;
  const running = !part.result && active && !asking;
  const verb = asking ? step.ask : running ? step.doing : step.done;
  const status = failed ? "Failed" : asking ? "Waiting on you" : !part.result && !active ? "No output recorded" : null;
  const truncated = !!part.result?.truncated;
  return (
    <div data-tool={id} data-step={step.kind} className="min-w-0">
      <StepLine icon={<StepIcon kind={step.kind} />} live={asking ? undefined : live} label={[verb, target, status, truncated ? "Truncated" : null].filter(Boolean).join(" ")}
        expanded={open} controls={contentId} onToggle={() => setExpanded((value) => !value)}>
        {/* A tool's own name can run long; it gives way before the target's first half and the chip. */}
        <span className={cn("text-muted-foreground", step.kind === "tool" ? "min-w-0 max-w-[45%] truncate" : "shrink-0")}>{verb}</span>
        <StepTarget text={step.text} format={step.target} query={query} current={focused} />
        {failed ? <FailedChip /> : asking ? <WaitingChip /> : status && <span className="shrink-0 text-caption text-muted-foreground">{status}</span>}
        {truncated && <span className="shrink-0 text-caption text-muted-foreground">Truncated</span>}
      </StepLine>
      <ImageStrip images={images(part, owner)} label="Images the tool returned" className="pb-1 pl-6" />
      {/* Under a finger the output takes the row's full width: a phone fits few characters of code a line. */}
      {open && <div id={contentId} className="mb-2 ml-6 min-w-0 space-y-2 rounded-lg bg-muted px-3 py-2 coarse:ml-0">
        <p className="font-mono text-caption text-muted-foreground"><Highlight text={part.name} query={query} current={focused} /></p>
        {part.summary && <pre className={OUTPUT}><Highlight text={part.summary} query={query} current={focused} /></pre>}
        {part.result ? <pre className={OUTPUT}><Highlight text={part.result.text} query={query} current={focused} />{part.result.truncated && <span className="text-muted-foreground">{"\n… output truncated"}</span>}</pre>
          : <p className="text-footnote text-muted-foreground">{asking ? "Waiting on you" : active ? "Running…" : "No output recorded"}</p>}
      </div>}
    </div>
  );
}

/** A thought as one italic line of its opening words; the whole of it opens beneath. */
export function ThinkingStep({ text, truncated = false, query, focused = false, live }: { text: string; truncated?: boolean; query: string; focused?: boolean; live?: Live }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const open = expanded || focused || containsQuery(text, query);
  const preview = firstLine(text);
  // Open, the thought is below in full, so its line names it instead of repeating its start. One
  // being written names itself ahead of its opening words.
  const shown = open ? "" : preview;
  return <div data-step="thinking" className="min-w-0">
    <StepLine icon={<StepIcon kind="thinking" />} live={live} label={`Thinking: ${preview}${truncated ? " · truncated" : ""}`} expanded={open} controls={contentId}
      onToggle={preview ? () => setExpanded((value) => !value) : undefined}>
      {(live || !shown) && <span className="shrink-0 text-muted-foreground">Thinking</span>}
      <StepTarget text={shown} format="thought" query={query} current={focused} />
    </StepLine>
    {open && preview && <div id={contentId} className="min-w-0 pb-2 pl-6 text-muted-foreground [overflow-wrap:anywhere]">
      <MarkdownText text={text} query={query} current={focused} />
      {truncated && <p className="text-footnote">… truncated</p>}
    </div>}
  </div>;
}

/**
 * The bottom line of a running turn: the step in progress, marked live. It opens like any step, so a
 * command or a thought cut short on a phone can be read whole while it runs. The call a live dialog
 * asks about (`waiting`) keeps this place and reads as waiting.
 */
export function LiveStepRow({ step, query, focused, marker, waiting = false }: { step: LiveStep; query: string; focused: boolean; marker?: string; waiting?: boolean }) {
  return <div data-live-step data-turn={marker} className={focused && marker ? "rounded ring-2 ring-primary/60" : undefined}>
    {step.part.kind === "tool"
      ? <ToolStep id={`${step.entry}:${step.index}`} part={step.part} owner={step.entry} query={query} active focused={focused} live={step} waiting={waiting} />
      : <ThinkingStep text={step.part.text} truncated={step.part.truncated} query={query} focused={focused} live={step} />}
  </div>;
}

// On a desk, a turn reads as Claude Code's does: the agent's words at prose size, and between two of
// them one quiet line for the steps it took. Open, the line is a table, one row per step: its verb in
// grey, what it touched in small monospace (or the call's own description), and a row opens onto its
// command and its output, in blocks of their own. Nothing of a step is ever drawn at prose size.

/** Whether a step holds the searched words: its fold opens, so find's hit is on screen. */
function stepMatches(step: WorkStep, query: string) {
  return step.part.kind === "tool" ? matches(step.part, query) : containsQuery(step.part.text, query);
}

/** A failed step's code, else that it failed, in the destructive tint. */
function FailureChip({ code }: { code?: number }) {
  return <span className="shrink-0 rounded-full bg-destructive/15 px-2 text-caption font-medium text-destructive">{code !== undefined ? `exit ${code}` : "Failed"}</span>;
}

const BLOCK = "min-w-0 overflow-hidden rounded-lg border bg-background";
const BLOCK_TEXT = "max-h-96 overflow-y-auto px-3 py-2 font-mono text-caption leading-5 text-muted-foreground whitespace-pre-wrap [overflow-wrap:anywhere]";

/** What a call ran and what it answered, verbatim: never Markdown (the XSS boundary), never at prose size. */
function StepBody({ part, query, focused, waiting, active }: { part: ToolPart; query: string; focused: boolean; waiting: boolean; active: boolean }) {
  const step = describeCall(part);
  const { code, output } = commandOutput(part.result?.text ?? "");
  const pending = waiting ? "Waiting on you" : active ? "Running…" : "No output recorded";
  return <div className="min-w-0 space-y-2">
    {part.summary && <pre className={cn(BLOCK, BLOCK_TEXT)}>{step.kind === "terminal" && <span aria-hidden="true" className="text-subtle-foreground">$ </span>}<Highlight text={part.summary} query={query} current={focused} /></pre>}
    <div className={BLOCK}>
      <div className="flex items-center justify-between border-b px-3 py-1 text-caption text-muted-foreground">
        <span>Output</span>{code !== undefined && <span>exit {code}</span>}
      </div>
      {part.result ? <pre className={BLOCK_TEXT}><Highlight text={output} query={query} current={focused} />{part.result.truncated && <span className="text-subtle-foreground">{"\n… output truncated"}</span>}</pre>
        : <p className="px-3 py-2 text-caption text-muted-foreground">{pending}</p>}
    </div>
  </div>;
}

/** What a desk's row says it acted on: the call's description, else its target in small monospace. */
function RowTarget({ part, query, focused }: { part: ToolPart; query: string; focused: boolean }) {
  const cwd = useContext(PaneCwdContext);
  const step = describeCall(part);
  if (part.description) return <span className="min-w-0 flex-1 truncate text-foreground"><Highlight text={part.description} query={query} current={focused} /></span>;
  const text = step.target === "path" && step.text ? spokenPath(step.text, cwd) : step.text;
  return <span className={cn("min-w-0 flex-1 truncate", step.target === "text" || step.target === "title" ? "text-foreground" : "font-mono text-caption text-muted-foreground")}>
    <Highlight text={text} query={query} current={focused} />
  </span>;
}

const ROW = "group flex w-full min-w-0 items-center gap-3 px-3.5 py-2.5 text-left text-footnote";
const ROW_CHEVRON = "size-3.5 shrink-0 text-subtle-foreground transition-transform group-hover:text-foreground motion-reduce:transition-none";

/** One step as a row of its run's table; it opens onto its command and output, a thought onto its words. */
function StepRow({ step, query, focused, active, waiting }: { step: WorkStep; query: string; focused: boolean; active: boolean; waiting: boolean }) {
  // A tap wins over opening on its own (find's hit, the focused entry), so a row a search opened closes on one tap.
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const contentId = useId();
  const open = expanded ?? (focused || stepMatches(step, query));
  const { part } = step;
  const tool = part.kind === "tool" ? part : null;
  const thought = part.kind === "thinking" ? part : null;
  const call = tool && describeCall(tool);
  const asking = waiting && !tool?.result;
  const verb = !call ? "Thought" : asking ? call.ask : !tool!.result && active ? call.doing : call.done;
  const failed = !!tool?.result?.isError;
  const diff = tool?.diff && !failed ? { additions: tool.diff.added, deletions: tool.diff.removed } : null;
  return <div data-step-row data-tool={tool ? `${step.entry}:${step.index}` : undefined} className="min-w-0">
    <button type="button" data-work-toggle aria-expanded={open} aria-controls={contentId} onClick={() => setExpanded(!open)} className={ROW}>
      <span className="min-w-14 shrink-0 whitespace-nowrap text-muted-foreground">{verb}</span>
      {tool ? <RowTarget part={tool} query={query} focused={focused} />
        : <span className="min-w-0 flex-1 truncate italic text-muted-foreground"><Highlight text={firstLine(thought!.text)} query={query} current={focused} /></span>}
      {failed ? <FailureChip code={commandOutput(tool!.result!.text).code} /> : asking ? <WaitingChip /> : diff && <DiffStat diff={diff} className="text-caption" />}
      {tool?.result?.truncated && <span className="shrink-0 text-caption text-muted-foreground">Truncated</span>}
      {open ? <ChevronDown aria-hidden="true" className={ROW_CHEVRON} /> : <ChevronRight aria-hidden="true" className={ROW_CHEVRON} />}
    </button>
    {open && <div id={contentId} className="min-w-0 px-3.5 pb-3.5 pl-[5.125rem]">
      {tool ? <StepBody part={tool} query={query} focused={focused} waiting={asking} active={active} />
        : <div className="text-footnote text-muted-foreground [overflow-wrap:anywhere]"><MarkdownText text={thought!.text} query={query} current={focused} />
          {thought!.truncated && <p>… truncated</p>}</div>}
    </div>}
  </div>;
}

/**
 * The steps between two of the agent's texts, as one grey line ("Ran 4 commands, read 2 files" and
 * the lines its edits changed). It opens onto the table of its steps, and on its own when find's hit
 * or the focused entry is inside.
 */
export function WorkSteps({ steps, query, focusedUuid, active, asked }: { steps: WorkStep[]; query: string; focusedUuid?: string; active: boolean; asked?: string }) {
  const [expanded, setExpanded] = useState<boolean | null>(null);
  const contentId = useId();
  const open = expanded ?? steps.some((step) => step.entry === focusedUuid || stepMatches(step, query));
  const diff = stepsDiff(steps);
  const failures = steps.filter(({ part }) => part.kind === "tool" && part.result?.isError).length;
  // An entry's scroll marker sits on its first row, wherever its run is.
  const marked = new Set<string>();
  return <div data-work-steps className="min-w-0 space-y-2">
    <button type="button" data-work-toggle aria-expanded={open} aria-controls={contentId} onClick={() => setExpanded(!open)}
      className="group flex min-h-8 w-fit max-w-full min-w-0 items-center gap-1.5 text-left text-footnote text-muted-foreground hover:text-foreground">
      <span className="min-w-0 truncate">{stepsSummary(steps)}</span>
      {diff && <DiffStat diff={diff} className="rounded-md bg-muted px-1.5 text-caption" />}
      {failures > 0 && <span className="whitespace-nowrap text-destructive">· {failures} failed</span>}
      {open ? <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" /> : <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />}
    </button>
    {open && <ol id={contentId} data-work-log className="min-w-0 divide-y overflow-hidden rounded-xl border bg-card/40 select-text">
      {steps.map((step) => {
        const first = !marked.has(step.entry);
        marked.add(step.entry);
        const focused = step.entry === focusedUuid;
        return <li key={`${step.entry}:${step.index}`} data-turn={first ? step.entry : undefined} className={focused ? "ring-2 ring-inset ring-primary/60" : undefined}>
          <StepRow step={step} query={query} focused={focused} active={active} waiting={asked === `${step.entry}:${step.index}`} />
        </li>;
      })}
    </ol>}
  </div>;
}

/**
 * A desk's running step, below every fold: the live glyph, its verb, what it does (the call's own
 * description when it has one) and how long it has run. It opens onto its command while it runs.
 */
export function DeskLiveStep({ step, query, focused, marker, waiting = false }: { step: LiveStep; query: string; focused: boolean; marker?: string; waiting?: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const contentId = useId();
  const { part } = step;
  const call = part.kind === "tool" ? describeCall(part) : null;
  const open = expanded || focused;
  const described = part.kind === "tool" && !!part.description;
  const what = part.kind === "tool" ? part.description || call!.text : firstLine(part.text);
  return <div data-live-step data-turn={marker} className={cn("min-w-0", focused && marker && "rounded ring-2 ring-primary/60")}>
    <button type="button" aria-expanded={open} aria-controls={contentId} onClick={() => setExpanded((value) => !value)}
      className="flex min-h-8 w-full min-w-0 items-center gap-2 text-left text-footnote text-muted-foreground hover:text-foreground">
      {waiting ? <StepIcon kind={call?.kind ?? "thinking"} /> : <LiveGlyph />}
      <span className="shrink-0 text-foreground">{!call ? "Thinking" : waiting ? call.ask : call.doing}</span>
      <span className={cn("min-w-0 truncate", !call && "italic", call && !described && call.target !== "text" && call.target !== "title" && "font-mono text-caption")}>
        <Highlight text={what} query={query} current={focused} />
      </span>
      {waiting ? <WaitingChip /> : step.since && <span className="shrink-0 text-subtle-foreground">· <Elapsed since={step.since} /></span>}
    </button>
    {open && <div id={contentId} className="min-w-0 pt-1 pl-6">
      {part.kind === "tool" ? <StepBody part={part} query={query} focused={focused} waiting={waiting} active />
        : <div className="text-footnote text-muted-foreground [overflow-wrap:anywhere]"><MarkdownText text={part.text} query={query} current={focused} /></div>}
    </div>}
  </div>;
}
