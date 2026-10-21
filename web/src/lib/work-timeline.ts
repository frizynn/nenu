import { parseInline, type MdSpan } from "./markdown";
import type { AgentStatus, TranscriptEntry, TranscriptPart } from "./types";

export interface WorkTurn {
  kind: "work";
  id: string;
  entries: TranscriptEntry[];
  activity: TranscriptEntry[];
  answer: TranscriptEntry | null;
  active: boolean;
  /** The CLI's turn this work belongs to still runs, though a message it read cut this part off. */
  alive: boolean;
  /** This work follows a message the CLI read mid-turn: it continues the turn above it. */
  continued: boolean;
  settled: boolean;
  interrupted: boolean;
  startedAt?: string;
  durationMs?: number;
}
export type WorkTimelineRow = { kind: "message"; entry: TranscriptEntry } | WorkTurn;
const validTime = (value: string | undefined) => value && Number.isFinite(Date.parse(value)) ? value : undefined;

export function formatWorkDuration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Group work without rewriting journal entries or moving user/system content into an agent fold. */
export function buildWorkTimeline(entries: TranscriptEntry[], status?: AgentStatus): WorkTimelineRow[] {
  const rows: WorkTimelineRow[] = [];
  let group: TranscriptEntry[] = [];
  let userBoundary: TranscriptEntry | undefined;
  // The user row that opened the current group was read by the CLI mid-turn (it carries that turn's id).
  let continuing = false;
  let systemBoundary = "";
  const usedTurnIds = new Set<string>();
  const lastAssistant = entries.findLast((entry) => entry.role === "assistant");

  function flush(bounded: boolean, cutMidTurn = false) {
    if (!group.length) return;
    const original = group;
    const continued = continuing;
    group = [];
    continuing = false;
    const first = original[0]!;
    const last = original.at(-1)!;
    const native = original.findLast((entry) => entry.turn)?.turn;
    const isLatest = last.uuid === lastAssistant?.uuid && !bounded;
    const active = isLatest && status === "working" && native?.status !== "completed" && native?.status !== "aborted";
    // Work a message cut off while the turn still runs keeps saying so; its live steps are below it.
    const alive = active || (cutMidTurn && status === "working" && native?.status === "running" && last.turnId === lastAssistant?.turnId);
    const explicitFinal = original.findLast((entry) => entry.phase === "final_answer" && entry.parts.some((part) => part.kind === "text"));
    const settled = !!explicitFinal || native?.status === "completed" || native?.status === "aborted" || (bounded && native?.status !== "running") ||
      (isLatest && native?.status !== "running" && status !== undefined && status !== "working" && status !== "blocked" && status !== "unknown");
    const hasWork = original.some((entry) => entry.phase === "commentary" || entry.parts.some((part) => part.kind !== "text"));
    // Old logs with only unclassified prose do not give us permission to hide earlier answers.
    if (!hasWork) { rows.push(...original.map((entry) => ({ kind: "message" as const, entry }))); return; }
    const terminal = explicitFinal ?? (!active && settled ? original.findLast((entry) =>
      entry.phase !== "commentary" && entry.parts.some((part) => part.kind === "text") && !entry.parts.some((part) => part.kind === "tool"),
    ) : undefined);
    const answer = terminal ? { ...terminal, parts: terminal.parts.filter((part) => part.kind === "text") } : null;
    const activity = original.flatMap((entry) => {
      if (entry !== terminal) return [entry];
      const parts = entry.parts.filter((part) => part.kind !== "text");
      return parts.length ? [{ ...entry, parts }] : [];
    });
    // The part after a message read mid-turn counts from that message; the turn's line counts it all.
    const startedAt = continued ? validTime(userBoundary?.ts) : validTime(native?.startedAt) ?? validTime(userBoundary?.ts);
    const end = validTime(native?.completedAt) ?? (settled ? validTime(last.ts) : undefined);
    const measured = !continued && typeof native?.durationMs === "number" && Number.isFinite(native.durationMs) && native.durationMs >= 0 ? native.durationMs : undefined;
    const elapsed = startedAt && end ? Date.parse(end) - Date.parse(startedAt) : undefined;
    const durationMs = measured ?? (elapsed !== undefined && elapsed >= 0 ? elapsed : undefined);
    const baseId = first.turnId ?? userBoundary?.uuid ?? `orphan:${first.uuid}`;
    const id = usedTurnIds.has(baseId) ? `${baseId}:after:${systemBoundary || first.uuid}` : baseId;
    usedTurnIds.add(baseId);
    rows.push({ kind: "work", id,
      entries: original, activity, answer, active, alive, continued, settled, interrupted: native?.status === "aborted",
      ...(startedAt ? { startedAt } : {}), ...(durationMs !== undefined ? { durationMs } : {}) });
  }

  for (const entry of entries) {
    if (entry.role !== "assistant") {
      // A message Claude read from its queue mid-turn carries that turn's id: it sits between the work
      // it split, and the work after it continues the same turn (as T3 Code draws a steer).
      const midTurn = entry.role === "user" && !!entry.turnId && group.at(-1)?.turnId === entry.turnId;
      flush(true, midTurn);
      rows.push({ kind: "message", entry });
      userBoundary = entry.role === "user" ? entry : undefined;
      continuing = midTurn;
      systemBoundary = entry.uuid;
      continue;
    }
    const before = group.at(-1);
    if (before && (before.phase === "final_answer" || before.turnId !== entry.turnId || (!entry.turnId && before.ts.slice(0, 10) !== entry.ts.slice(0, 10)))) {
      flush(true);
      userBoundary = undefined;
    }
    // Only work that follows the message at once continues its turn.
    if (!group.length && continuing && userBoundary?.turnId !== entry.turnId) continuing = false;
    group.push(entry);
  }
  flush(false);
  return rows;
}

/** What a tool call is to the reader: its icon, and the verbs a row says it with. */
export type StepKind = "terminal" | "read" | "edit" | "write" | "search" | "web" | "agent" | "plan" | "question" | "tool";
export interface ToolStepDescription {
  kind: StepKind;
  /** Past tense for a finished step ("Ran"), present for the one in progress ("Running"). */
  done: string;
  doing: string;
  /** The request, while a dialog asks the operator about the call ("Run"): it has not run yet. */
  ask: string;
  /** How the call's summary is drawn: a path keeps its file name whole, code stays monospace, a document by its title. */
  target: "path" | "code" | "text" | "title";
}

// Names across harnesses: Claude Code, Codex and pi spell the same few tools differently.
const TOOL_STEPS: Array<[RegExp, ToolStepDescription]> = [
  [/^(bash|shell|exec|exec_command|local_shell|run_shell_command)$/, { kind: "terminal", done: "Ran", doing: "Running", ask: "Run", target: "code" }],
  [/^(read|read_file|view|notebookread)$/, { kind: "read", done: "Read", doing: "Reading", ask: "Read", target: "path" }],
  [/^(edit|multiedit|edit_file|notebookedit|str_replace_editor|str_replace_based_edit_tool)$/, { kind: "edit", done: "Edited", doing: "Editing", ask: "Edit", target: "path" }],
  [/^apply_patch$/, { kind: "edit", done: "Edited", doing: "Editing", ask: "Edit", target: "text" }],
  [/^(write|write_file|create_file)$/, { kind: "write", done: "Wrote", doing: "Writing", ask: "Write", target: "path" }],
  [/^(grep|glob|find|rg|search|search_files|codebase_search)$/, { kind: "search", done: "Searched", doing: "Searching", ask: "Search", target: "code" }],
  [/^(ls|list_dir|list_directory)$/, { kind: "search", done: "Listed", doing: "Listing", ask: "List", target: "path" }],
  [/^(webfetch|web_fetch|fetch)$/, { kind: "web", done: "Fetched", doing: "Fetching", ask: "Fetch", target: "text" }],
  [/^(websearch|web_search)$/, { kind: "web", done: "Searched the web", doing: "Searching the web", ask: "Search the web", target: "text" }],
  [/^(task|agent|spawn_agent)$/, { kind: "agent", done: "Ran agent", doing: "Running agent", ask: "Run agent", target: "text" }],
  [/^(todowrite|update_plan)$/, { kind: "plan", done: "Updated the plan", doing: "Updating the plan", ask: "Update the plan", target: "text" }],
  // Claude's plan, shown to the operator to approve: the line says Plan once, with the plan's title.
  [/^exitplanmode$/, { kind: "plan", done: "Plan", doing: "Plan", ask: "Plan", target: "title" }],
];

/** A call the bridge read questions from (its `questions`) reads as the question it asks. */
export const QUESTION_STEP: ToolStepDescription = { kind: "question", done: "Question", doing: "Question", ask: "Question", target: "text" };

// Claude Code's spelling of an MCP tool: mcp__<server>__<tool>.
const MCP_TOOL = /^mcp__.+?__(.+)$/;

/** A tool call as a step; a tool it does not know keeps its own name (an MCP tool's, without its server) as the verb. */
export function describeTool(name: string): ToolStepDescription {
  const key = name.toLowerCase();
  const own = MCP_TOOL.exec(name)?.[1] ?? name;
  return TOOL_STEPS.find(([pattern]) => pattern.test(key))?.[1] ?? { kind: "tool", done: own, doing: own, ask: own, target: "text" };
}

/** The words the renderer draws for `spans`, without their formatting. */
function plain(spans: MdSpan[]): string {
  return spans.map((span) => "text" in span ? span.text : span.kind === "image" ? span.alt : plain(span.spans)).join("");
}

// A heading's hashes and a quote's marker are syntax the renderer never prints.
const BLOCK_MARK = /^(?:#{1,6}\s+|>\s?)/;

/**
 * The first line of `text` that has words, as the rendered thought reads it: Codex and pi open a
 * thought with a `**bold title**`, and a preview must not show the asterisks.
 */
export function firstLine(text: string): string {
  return text.split("\n").map((line) => plain(parseInline(line.trim().replace(BLOCK_MARK, ""))).trim()).find(Boolean) ?? "";
}

/** A command's first line with words, exactly as it ran: a shell line is never read as Markdown. */
export function commandLine(text: string): string {
  return text.split("\n").find((line) => line.trim()) ?? "";
}

/**
 * What a running turn is doing now: a call still waiting for its result, or the thought being
 * written. `entry` and `index` name that part, so the timeline marks it live where it sits in its run.
 */
export interface LiveStep {
  part: Extract<TranscriptPart, { kind: "tool" | "thinking" }>;
  entry: string;
  index: number;
  since?: string;
}

export function liveStep(turn: WorkTurn): LiveStep | null {
  if (!turn.active) return null;
  const at = (entry: TranscriptEntry, index: number) => ({ entry: entry.uuid, index, ...(validTime(entry.ts) ? { since: entry.ts } : {}) });
  // Parallel calls finish in any order, so the latest call still waiting for its result is the one
  // in progress, wherever it sits; only with none does the turn's last part say what happens now.
  for (const entry of turn.activity.toReversed()) {
    const index = entry.parts.findLastIndex((part) => part.kind === "tool" && !part.result);
    const part = entry.parts[index];
    if (part?.kind === "tool") return { part, ...at(entry, index) };
  }
  // Between steps there is nothing to name, and the turn's own line already says it is working.
  const last = turn.activity.at(-1);
  const index = last ? last.parts.findLastIndex((part) => part.kind !== "image") : -1;
  const part = last?.parts[index];
  return last && part?.kind === "thinking" ? { part, ...at(last, index) } : null;
}

/** A step of a turn's work: a call or a thought, where it sits in the journal. */
export interface WorkStep {
  part: Extract<TranscriptPart, { kind: "tool" | "thinking" }>;
  entry: string;
  index: number;
}

/**
 * A turn as it reads: the agent's words, and between two of them the run of steps it took. `id` names a
 * run by its first step, the live one included, so a run keeps its id (and its fold its state) however
 * its calls finish and whatever older page goes in above it; `at` is when it started.
 */
export type WorkSegment =
  | { kind: "prose"; entry: TranscriptEntry; parts: Array<{ part: TranscriptPart; index: number }> }
  | { kind: "steps"; id: string; at: string; steps: WorkStep[] };

/**
 * `activity` cut at the agent's words. The step in progress sits in its run where it will stay, so it
 * turns from running to done in place.
 */
export function workSegments(activity: TranscriptEntry[]): WorkSegment[] {
  const segments: WorkSegment[] = [];
  for (const entry of activity) {
    entry.parts.forEach((part, index) => {
      if (part.kind === "image") return;
      const last = segments.at(-1);
      if (part.kind === "tool" || part.kind === "thinking") {
        let run = last?.kind === "steps" ? last : null;
        if (!run) segments.push(run = { kind: "steps", id: `${entry.uuid}:${index}`, at: entry.ts, steps: [] });
        run.steps.push({ part, entry: entry.uuid, index });
      } else if (last?.kind === "prose" && last.entry === entry) last.parts.push({ part, index });
      else segments.push({ kind: "prose", entry, parts: [{ part, index }] });
    });
  }
  return segments;
}

/**
 * Whether a run folds under one line: only when it holds several calls. One call reads best as itself,
 * and a thought is already one line, so neither hides behind a second tap.
 */
export function foldsSteps(steps: WorkStep[]): boolean {
  return steps.filter(({ part }) => part.kind === "tool").length > 1;
}

// What a run of steps did, by the verb its steps share: "Ran 3 commands, read 2 files".
const COUNTED: Record<string, [verb: string, noun: string]> = {
  Ran: ["ran", "command"], Read: ["read", "file"], Edited: ["edited", "file"], Wrote: ["wrote", "file"], Searched: ["searched", "pattern"],
  Listed: ["listed", "folder"], Fetched: ["fetched", "page"], "Searched the web": ["searched the web", "time"], "Ran agent": ["ran", "agent"],
  Question: ["asked", "question"],
};

/** A run of steps as its fold's one line, in the order the steps first did each thing. */
export function stepsSummary(steps: WorkStep[]): string {
  const groups = new Map<string, { phrase: string; noun?: string; targets: Set<string>; count: number }>();
  for (const { part } of steps) {
    if (part.kind === "thinking") continue;
    const step = part.questions?.length ? QUESTION_STEP : describeTool(part.name);
    const counted = COUNTED[step.done];
    const key = step.kind === "tool" ? "tool" : step.done;
    const phrase = counted?.[0] ?? (key === "tool" ? "used" : step.kind === "plan" && step.target === "title" ? "proposed a plan" : step.done.toLowerCase());
    const group = groups.get(key) ?? { phrase, noun: counted?.[1] ?? (key === "tool" ? "tool" : undefined), targets: new Set(), count: 0 };
    group.count++;
    group.targets.add(part.summary);
    groups.set(key, group);
  }
  const phrases = [...groups].map(([key, { phrase, noun, targets, count }]) => {
    // A file edited twice is one file edited.
    const n = key === "Edited" || key === "Wrote" ? targets.size : count;
    if (!noun) return phrase;
    if (noun === "time") return n === 1 ? phrase : `${phrase} ${n} times`;
    return `${phrase} ${n} ${noun}${n === 1 ? "" : "s"}`;
  });
  const line = phrases.join(", ") || "thought";
  return line[0]!.toUpperCase() + line.slice(1);
}

/** The lines a run of steps added and removed, from the edits that went through; null when none. */
export function stepsDiff(steps: WorkStep[]): { additions: number; deletions: number } | null {
  const edits = steps.flatMap(({ part }) => part.kind === "tool" && part.diff && !part.result?.isError ? [part.diff] : []);
  return edits.length ? { additions: edits.reduce((sum, d) => sum + d.added, 0), deletions: edits.reduce((sum, d) => sum + d.removed, 0) } : null;
}

// Claude opens a failed command's result with its exit code, on a line of its own.
const EXIT_CODE = /^Exit code (\d+)\n?/;

/** A command's output split from the exit code it opens with, when it opens with one. */
export function commandOutput(text: string): { code?: number; output: string } {
  const match = EXIT_CODE.exec(text);
  return match ? { code: Number(match[1]), output: text.slice(match[0].length) } : { output: text };
}
