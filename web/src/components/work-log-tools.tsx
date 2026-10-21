import { createContext, useContext, useId, useState, type ReactNode } from "react";
import { Brain, ChevronRight, FilePen, FilePlus, FileText, Globe, ListTodo, ChatCircleDots, Search, Sparkle, Terminal, Wrench, type IconComponent } from "@/components/ui/icon";
import { displayPath } from "@/lib/display-path";
import { FileMediaContext } from "@/lib/file-preview-context";
import { localFilePath } from "@/lib/file-links";
import { clockTime } from "@/lib/format";
import { IMAGE_EXTENSION, imageLabel } from "@/lib/message-images";
import { shellTokens, type ShellTokenKind } from "@/lib/shell-tokens";
import { splitHighlight } from "@/lib/transcript-search";
import type { TranscriptPart } from "@/lib/types";
import { cn } from "@/lib/utils";
import { commandOutput, describeTool, firstLine, foldsSteps, QUESTION_STEP, stepsDiff, stepsSummary, type LiveStep, type StepKind, type ToolStepDescription, type WorkStep } from "@/lib/work-timeline";
import { DiffStat } from "./diff-stat";
import { FIND_CURRENT_HIT, FIND_HIT, MarkdownText } from "./markdown-text";
import { MediaViewerContext, type MediaViewer } from "./file-preview-provider";
import { ImageStrip, type StripImage } from "./message-images";
import { Fold } from "./fold";
import { LiveGlyph } from "./work-activity-label";

// A turn's work as a timeline, the same on a phone and a desk: one line per step, its icon and what it
// did in the quiet greys, so the steps read as the agent working and its prose as what it says. A
// command reads as itself; a thought as its opening words. Several calls between two of the agent's
// texts fold under one line ("Ran 3 commands"), and a step opens onto its command, coloured as a shell
// reads it, and its output in grey (ADR 0113).

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
  terminal: Terminal, read: FileText, edit: FilePen, write: FilePlus, search: Search, web: Globe, agent: Sparkle, plan: ListTodo, tool: Wrench,
  question: ChatCircleDots, thinking: Brain,
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

// 24px on a mouse, as T3 Code's rows are, 44px under a finger. The row lights on hover as every row
// does (ADR 0111), its fill reaching past the icon so the icon column stays where it is.
const ROW = "group -mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-0.5 text-left text-subhead min-h-6 coarse:min-h-11 pointer-fine:hover:bg-hover";
const CHEVRON = "size-3 shrink-0 text-subtle-foreground transition-[rotate,color] duration-120 ease-out group-hover:text-foreground motion-reduce:transition-none";

/** A step in progress: its line carries the live glyph for its icon; the turn's line says how long. */
type Live = Pick<LiveStep, "since">;

/**
 * A step's line. With `onToggle` it is the button that opens the step's body; without, it keeps the
 * chevron's place, so whatever ends a line sits in one column down the timeline. A toggle reports
 * itself (`data-work-toggle`) so the thread holds still and stops following. The live step is the
 * tail the thread follows, so it opens without reporting and the thread keeps following it.
 */
function StepLine({ icon, live, label, title, expanded, controls, onToggle, children }: {
  icon: ReactNode;
  live?: Live;
  label?: string;
  title?: string;
  expanded?: boolean;
  controls?: string;
  onToggle?: () => void;
  children: ReactNode;
}) {
  const lead = live ? <LiveGlyph /> : icon;
  const chevron = <ChevronRight aria-hidden="true" className={cn(CHEVRON, expanded && "rotate-90", !onToggle && "invisible")} />;
  if (!onToggle) return <div className={ROW} title={title}>{lead}{children}{chevron}</div>;
  return <button type="button" data-work-toggle={live ? undefined : true} aria-label={label} aria-expanded={expanded} aria-controls={controls} onClick={onToggle}
    title={title} className={ROW}>
    {lead}{children}{chevron}
  </button>;
}

function StepIcon({ kind, failed = false }: { kind: StepKind | "thinking"; failed?: boolean }) {
  const Icon = STEP_ICONS[kind];
  return <Icon aria-hidden="true" className={cn("size-4 shrink-0", failed ? "text-destructive opacity-50" : "text-muted-foreground")} />;
}

/**
 * What a step acted on: a path shows its folders muted and its file name whole, code stays monospace.
 * The folders give up whole leading segments first, then lose characters from their start (the rtl
 * box puts the ellipsis on the left), so the folders nearest the file are the ones that stay. A command
 * reads as the line it is, in the row's own type: it is the row's name, not a block of code.
 */
function StepTarget({ text, format, query, current }: { text: string; format: ToolStepDescription["target"] | "thought" | "command"; query: string; current: boolean }) {
  const cwd = useContext(PaneCwdContext);
  if (!text) return <span className="flex-1" />;
  if (format === "path") {
    const { dir, base } = displayPath(text, cwd, 32);
    return <span className="flex min-w-0 flex-1">
      {dir && <span className="min-w-0 truncate text-subtle-foreground [direction:rtl]"><span dir="ltr"><Highlight text={dir} query={query} current={current} /></span></span>}
      <span className="max-w-full shrink-0 truncate text-muted-foreground"><Highlight text={base} query={query} current={current} /></span>
    </span>;
  }
  return <span className={cn("min-w-0 flex-1 truncate", format === "command" || format === "thought" ? "text-muted-foreground" : "text-subtle-foreground", format === "code" && "font-mono text-code")}>
    {/* A command reads as it ran: its first line as written, never through the Markdown a thought goes through. */}
    <Highlight text={format === "command" ? text.split("\n").find((line) => line.trim()) ?? text : text} query={query} current={current} />
  </span>;
}

/** A step's path as its row reads it whole, for the row's name: what a voice command says is what it sees. */
function spokenPath(path: string, cwd: string): string {
  const { dir, base } = displayPath(path, cwd, Infinity);
  return dir + base;
}

/** A call the operator has to answer for says so on its line: the blocked dot, and the words plain (direction.md). */
function WaitingChip() {
  return <span className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 text-caption text-foreground">
    <span aria-hidden="true" className="size-1.5 rounded-full bg-status-blocked" />Waiting on you
  </span>;
}

const SYNTAX: Record<ShellTokenKind, string | undefined> = {
  command: "text-syntax-command", flag: "text-syntax-flag", argument: "text-syntax-argument", string: "text-syntax-argument",
  variable: "text-syntax-variable", keyword: "text-syntax-keyword", operator: "text-muted-foreground", comment: "text-subtle-foreground", space: undefined,
};

/** A command as a shell reads it, in colour; every piece is a text node, and find's hits stay marked. */
function ShellLine({ text, query, current }: { text: string; query: string; current: boolean }) {
  return <>{shellTokens(text).map((token, index) => <span key={index} className={SYNTAX[token.kind]}><Highlight text={token.text} query={query} current={current} /></span>)}</>;
}

const OUTPUT = "min-w-0 font-mono text-code whitespace-pre-wrap [overflow-wrap:anywhere]";

/**
 * What a call ran and what it answered, verbatim: never Markdown (the XSS boundary). The command in
 * colour, then its output in grey under it, a failure's exit code first as the CLI says it. A long
 * output scrolls in place under a pointer; under a finger it runs whole, so the chat stays the one box
 * that scrolls.
 */
function StepBody({ part, kind, query, focused, pending }: { part: ToolPart; kind: StepKind; query: string; focused: boolean; pending: string }) {
  const { code, output } = commandOutput(part.result?.text ?? "");
  return <div className="min-w-0 space-y-2 pt-1 pb-3">
    {containsQuery(part.name, query) && <p className="font-mono text-caption text-subtle-foreground"><Highlight text={part.name} query={query} current={focused} /></p>}
    {part.summary && <pre className={cn(OUTPUT, "text-foreground")}>{kind === "terminal" ? <ShellLine text={part.summary} query={query} current={focused} /> : <Highlight text={part.summary} query={query} current={focused} />}</pre>}
    {part.result ? <pre className={cn(OUTPUT, "text-muted-foreground pointer-fine:max-h-80 pointer-fine:overflow-y-auto")}>
      {code !== undefined && `Error: Exit code ${code}\n`}<Highlight text={output} query={query} current={focused} />
      {part.result.truncated && <span className="text-subtle-foreground">{"\n… output truncated"}</span>}
    </pre> : <p className="text-footnote text-muted-foreground">{pending}</p>}
  </div>;
}

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
  const diff = part.diff && !failed ? { additions: part.diff.added, deletions: part.diff.removed } : null;
  // A command reads as the line it is. Finished, it is the row's whole name: its verb would only say
  // "Ran" on every line of a run of them; running or asked about, the verb says which.
  const command = step.kind === "terminal";
  const quiet = command && !asking && !running;
  return (
    <div data-tool={id} data-step={step.kind} className="min-w-0">
      {/* What the agent said the call is for (a Bash call's description) is its line's tooltip on a desk. */}
      <StepLine icon={<StepIcon kind={step.kind} failed={failed} />} live={asking ? undefined : live} title={part.description}
        label={[verb, target, status, part.result?.truncated ? "Truncated" : null].filter(Boolean).join(" ")}
        expanded={open} controls={contentId} onToggle={() => setExpanded((value) => !value)}>
        {/* A tool's own name can run long; it gives way before the target's first half and the chip. */}
        {!quiet && <span className={cn("text-muted-foreground", step.kind === "tool" ? "min-w-0 max-w-[45%] truncate" : "shrink-0")}>{verb}</span>}
        <StepTarget text={step.text} format={command ? "command" : step.target} query={query} current={focused} />
        {diff && <DiffStat diff={diff} className="text-caption" />}
        {asking ? <WaitingChip /> : status && <span className="shrink-0 text-caption text-subtle-foreground">{status}</span>}
      </StepLine>
      <ImageStrip images={images(part, owner)} label="Images the tool returned" className="pb-1 pl-6" />
      <Fold value={open} animate={expanded}>{() => <div id={contentId}>
        <StepBody part={part} kind={step.kind} query={query} focused={focused} pending={asking ? "Waiting on you" : active ? "Running…" : "No output recorded"} />
      </div>}</Fold>
    </div>
  );
}

/** A thought as one grey line of its opening words; the whole of it opens beneath. */
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
      {(live || !shown) && <span className="shrink-0 text-muted-foreground">{live || !preview ? "Thinking" : "Thought"}</span>}
      <StepTarget text={shown} format="thought" query={query} current={focused} />
    </StepLine>
    {preview && <Fold value={open} animate={expanded}>{() => <div id={contentId}>
      <div className="min-w-0 pb-2 pl-6 text-subhead text-muted-foreground [overflow-wrap:anywhere]">
        <MarkdownText text={text} query={query} current={focused} />
        {truncated && <p className="text-footnote">… truncated</p>}
      </div>
    </div>}</Fold>}
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

/** Whether a step holds the searched words: its fold opens, so find's hit is on screen. */
function stepMatches(step: WorkStep, query: string) {
  return step.part.kind === "tool" ? matches(step.part, query) : containsQuery(step.part.text, query);
}

/** The icon a run's line draws: its calls' kind when they share one, else the generic tool. */
function runIcon(steps: WorkStep[]): StepKind {
  const kinds = new Set(steps.flatMap(({ part }) => part.kind === "tool" ? [part.questions?.length ? "question" : describeTool(part.name).kind] : []));
  return kinds.size === 1 ? [...kinds][0] as StepKind : "tool";
}

/** Each step of a run as its own row; an entry's scroll marker sits on its first row, wherever its run is. */
function StepRows({ steps, query, focusedUuid, active, asked }: { steps: WorkStep[]; query: string; focusedUuid?: string; active: boolean; asked?: string }) {
  const marked = new Set<string>();
  return <ol data-work-log className="min-w-0 select-text">
    {steps.map((step) => {
      const first = !marked.has(step.entry);
      marked.add(step.entry);
      const focused = step.entry === focusedUuid;
      const id = `${step.entry}:${step.index}`;
      return <li key={id} data-turn={first ? step.entry : undefined} className={focused ? "rounded ring-2 ring-inset ring-primary/60" : undefined}>
        {step.part.kind === "tool"
          ? <ToolStep id={id} part={step.part} owner={step.entry} query={query} active={active} focused={focused} waiting={asked === id} />
          : <ThinkingStep text={step.part.text} truncated={step.part.truncated} query={query} focused={focused} />}
      </li>;
    })}
  </ol>;
}

/**
 * The steps between two of the agent's texts. A single call, or thoughts alone, draw as their own rows;
 * several calls fold under one line that says what they did ("Ran 3 commands", the lines its edits
 * changed), with the time they started on a desk. It opens on its own when find's hit or the focused
 * entry is inside.
 *
 * A run drawn as rows stays rows while it is on screen, however many calls join it as the turn runs:
 * folding them then would pull a line in above the rows and hide one the reader may have opened. It
 * folds the next time it is drawn whole.
 */
export function WorkSteps({ steps, query, focusedUuid, active, asked, at }: { steps: WorkStep[]; query: string; focusedUuid?: string; active: boolean; asked?: string; at?: string }) {
  const [expanded, setExpanded] = useState(false);
  // A run whose calls still run is drawn as rows: its line would say "Ran" of what has not finished.
  const [folding] = useState(() => foldsSteps(steps) && !(active && steps.some(({ part }) => part.kind === "tool" && !part.result)));
  const contentId = useId();
  const toolImages = useToolImages();
  if (!folding || !foldsSteps(steps)) return <StepRows steps={steps} query={query} focusedUuid={focusedUuid} active={active} asked={asked} />;
  const open = expanded || steps.some((step) => step.entry === focusedUuid || stepMatches(step, query) || asked === `${step.entry}:${step.index}`);
  const diff = stepsDiff(steps);
  const failures = steps.filter(({ part }) => part.kind === "tool" && part.result?.isError).length;
  const summary = stepsSummary(steps);
  const time = at ? clockTime(Date.parse(at)) : "";
  // Folded, what its calls showed the agent stays in sight under its line; open, each call shows its own.
  const images = open ? [] : relabel(steps.flatMap(({ part, entry }) => part.kind === "tool" ? toolImages(part, entry) : []));
  return <div data-work-steps className="min-w-0">
    <button type="button" data-work-toggle aria-expanded={open} aria-controls={contentId} aria-label={[summary, failures ? `${failures} failed` : ""].filter(Boolean).join(", ")}
      onClick={() => setExpanded(!open)} className={ROW}>
      {/* A failure inside shows as its tinted icon; the row that failed says so once it is open. */}
      <StepIcon kind={runIcon(steps)} failed={failures > 0} />
      <span className="min-w-0 truncate text-muted-foreground">{summary}</span>
      {diff && <DiffStat diff={diff} className="text-caption" />}
      <span className="flex-1" />
      {/* The line is the toggle, as T3 Code draws it: no chevron. Open on a desk, it says when the run began. */}
      {open && time && <time dateTime={at} className="hidden shrink-0 text-footnote text-subtle-foreground pointer-fine:inline">{time}</time>}
    </button>
    <ImageStrip images={images} label="Images these steps returned" className="pb-1 pl-6" />
    <Fold value={open} animate={expanded}>{() => <div id={contentId}>
      <StepRows steps={steps} query={query} focusedUuid={focusedUuid} active={active} asked={asked} />
    </div>}</Fold>
  </div>;
}
