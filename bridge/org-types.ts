// What Herdr Organizations prints of the operator's asks and of an agent's token use
// (docs/json.md: Asks, Usage), as the bridge hands them to a client (ADR 0091). Parsed in
// org-asks.ts and org-report.ts; mirrored in web/src/lib/types.ts.

/**
 * A coordinator's STATUS.md as Organizations reads it: what the operator asked and where each thing
 * stands, in the agent's own Markdown, up to 8,000 characters. Read on demand with the summaries; the
 * snapshot carries only `updated`, so a page knows when to read it again. The text is data.
 */
export interface StatusFile {
  text: string;
  /** RFC 3339, or empty when Organizations printed none that parses. */
  updated: string;
  /**
   * Its `Objective:` line and the lines under `## Needs your decision`, as Organizations reads them
   * (ADR 0091); absent from one that predates them, or when the file has none.
   */
  objective?: string;
  needsDecision?: string[];
}

/** What a coordinator wrote in an ask's brackets; `unknown` for a line that does not follow the format. */
export type AskState = "open" | "working" | "needs-decision" | "answered" | "done" | "unknown";
export const ASK_STATES: readonly AskState[] = ["open", "working", "needs-decision", "answered", "done", "unknown"];
/** What an ask's links confirm, the least finished one winning; empty when no link has a state the records know. */
export type AskConfirmed = "in-progress" | "stopped" | "failed" | "done" | "";
export const ASK_CONFIRMED: readonly AskConfirmed[] = ["in-progress", "stopped", "failed", "done", ""];

/** One link of an ask, as Organizations confirmed it. Every string may be empty. */
export interface AskLink {
  kind: "thread" | "pr" | "task" | "page";
  text: string;
  target: string;
  /** The thread it names, or whose pull request it is, and that thread's title. */
  thread: string;
  title: string;
  /** A thread's group, `failed` or `missing`; a PR's `open`, `merged` or `closed`; a task's `todo`, `done` or `missing`. */
  state: string;
  pr: string;
  prState: string;
}

/**
 * One line under a coordinator's `## Asked`, with the state its links confirm. The text and the
 * answer are the operator's and the coordinator's words: drawn as text, and never put in a prompt.
 */
export interface Ask {
  line: number;
  state: AskState;
  text: string;
  answer: string;
  links: AskLink[];
  confirmed: AskConfirmed;
  /** Why `state` does not close with what the links confirm, in Organizations' fixed words; empty when it closes. */
  mismatch: string;
}

/** Where Your asks lists an ask: Organizations' order (`Ask::rank`), as its coordinator stands. */
export type AskGroup = "waiting" | "unclosed" | "progress" | "done" | "other";

/** A coordinator, as an ask names it: `root` with an empty title for the project's own. */
export interface AskCoordinator { id: string; title: string }

/** One ask of `asks --json`, in Organizations' order. */
export interface AskRow extends Ask {
  project: string;
  coordinator: AskCoordinator;
  group: AskGroup;
}

/** A `## Needs your decision` line of a coordinator that still takes an answer. */
export interface AskDecision {
  project: string;
  coordinator: AskCoordinator;
  text: string;
}

/** Every coordinator's asks and open decisions (`/api/org/asks`), read when the page opens. */
export interface AsksList {
  asks: AskRow[];
  decisions: AskDecision[];
}

/** An agent's token use as Organizations read it from its transcripts. */
export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** How full its context is now: the last request's prompt. */
  context: number;
  peakContext: number;
  compactions: number;
  /** RFC 3339, or empty. */
  updated: string;
  /** The caps it was at or above at that read (`context_warn`, `compaction_warn`, `tokens_warn`). */
  overCap: string[];
}
