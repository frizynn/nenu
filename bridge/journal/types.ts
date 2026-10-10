// The journal's shared vocabulary — the shape every harness adapter must produce, and the seams the
// store drives them through. Nothing agent-specific lives here.
//
// WHY A JOURNAL EXISTS AT ALL. A pane running an agent usually sits on the terminal's ALTERNATE
// SCREEN, which has no scrollback ring — Herdr's terminal core keeps nothing behind the viewport, so
// `pane.read` can never return more than one screenful (see journal/claude.ts for the measurements).
// The history does exist, though: every harness writes its own session log. This module's job is to
// make "read that log" a per-harness decision behind one interface, so a new harness is an adapter
// rather than a fork of the reader.

import type { InteractionHint } from "../types.ts";

/**
 * How an agent named its session, straight off Herdr's `agent_session` record.
 *
 * Two kinds are in the wild and they are NOT interchangeable:
 *  - `id`   — an opaque session id (Claude, Codex). The adapter must find the file itself, so the
 *             value never touches a path until the adapter has validated its shape.
 *  - `path` — an absolute path to the log, reported by the agent (pi). Convenient, but it is
 *             attacker-shaped input by construction: it arrives over the socket from a process we
 *             do not control, so the adapter must still confine it to its own root.
 */
export interface AgentSessionRef {
  kind: "id" | "path";
  value: string;
}

/** One renderable piece of a turn. Deliberately small — the phone renders these as text nodes. */
export type TranscriptPart =
  | { kind: "text"; text: string; truncated?: boolean }
  /**
   * Extended-thinking text. Whether this ever carries anything is per-harness: Claude Code persists
   * `thinking` blocks with the text stripped (empty every time), while Codex and pi both write real
   * reasoning summaries. The branch is universal; only the harnesses that fill it differ.
   */
  | { kind: "thinking"; text: string; truncated?: boolean }
  /** A tool call. `result` is filled in from the result row that answers it, when one exists. */
  | {
      kind: "tool";
      name: string;
      /** One-line gist of the call's input (the file read, the command run) — never the whole input. */
      summary: string;
      questions?: Array<{ title: string; options: string[] }>;
      result?: { text: string; truncated?: boolean; isError?: boolean; attachments?: ToolAttachment[] };
    }
  | TranscriptImagePart;

/**
 * An image the journal holds inline (a pasted screenshot), as a marker only. The bytes are fetched on
 * demand from the journal-image route by entry uuid and `index` — never by path, never inlined into
 * /history, where one image is routinely 100-600 KB of base64.
 */
export interface TranscriptImagePart {
  kind: "image";
  /** Zero-based index among the images of its entry, tool-result images included. */
  index: number;
  mediaType?: string;
}

/**
 * What a tool call produced or showed: an inline image (addressed like {@link TranscriptImagePart},
 * by its entry and index) or a file the harness itself reports delivering (Claude's SendUserFile).
 */
export type ToolAttachment =
  | { kind: "image"; index: number; mediaType?: string }
  | { kind: "file"; path: string };

/** One row of a harness's own input queue, as its journal records it (Claude's `queue-operation`). */
export interface NativeQueueEvent {
  /**
   * The native operation. `queued_command` is the attachment Claude writes when a queued message is
   * absorbed into the running turn; the rest are `queue-operation` rows. P0 measured, on 2.1.296:
   * enqueue on Enter, then either remove(absorbed_mid_turn) + queued_command or dequeue + a new user
   * row; popAll when Up recalls the queue into the input box.
   */
  kind: "enqueue" | "dequeue" | "remove" | "popAll" | "queued_command";
  ts: string;
  content?: string;
  reason?: string;
  commandUuid?: string;
  deliveryId?: string;
}

/** Structured facts a journal carries beside the conversation itself. */
export interface JournalFacts {
  /** The name the operator gave the session (Claude's `/rename`, a `custom-title` row). */
  title?: string;
  /** Oldest-first, the newest {@link MAX_QUEUE_EVENTS} only. */
  queue: NativeQueueEvent[];
  /** The newest question or plan the agent asked that has no answer in the journal yet. */
  pendingQuestion?: InteractionHint;
}

export const MAX_QUEUE_EVENTS = 100;

/** Where the bytes of one inline image sit: the log line holding it, and its position in that row. */
export interface ImageLocator {
  offset: number;
  bytes: number;
  /** Index among the row's images, in the order {@link JournalAdapter.rowImages} returns them. */
  nth: number;
}

/**
 * A resumable parse. The store feeds it complete lines in file order — the whole window on a first
 * read, then only what was appended — so a growing log costs the size of its growth. Feeding a log in
 * any split must leave exactly the state one feed of the whole log would.
 */
export interface JournalParser {
  /** One complete line, and where its bytes sit in the file (so images can be found again). */
  line(text: string, offset: number, bytes: number): void;
  /** Every entry so far, oldest first. Entries already returned may be updated in place later. */
  entries(): TranscriptEntry[];
  facts(): JournalFacts;
  usage(): Omit<SessionTelemetry, "fileTruncated"> | undefined;
  /** The images of one entry, indexed as its image parts and attachments are. */
  images(entryUuid: string): readonly ImageLocator[];
}

/**
 * One turn of the conversation.
 *
 * `user`/`assistant` are speech. The other two are NOT, and are rendered set apart so they can't be
 * mistaken for it: `summary` is a compaction summary the agent wrote about its own history, and
 * `note` is machine-injected content that still belongs on screen (a background task finishing, a
 * local command's output).
 */
export interface TranscriptEntry {
  /**
   * The paging cursor (`?before=`), and it must be stable across reads of the same log.
   *
   * Where a harness gives rows their own id (Claude, pi) this IS that id. Codex rows carry none, so
   * its adapter synthesises one — see journal/codex.ts for why that synthetic form has to be
   * anchored to the END of the file.
   */
  uuid: string;
  /** ISO timestamp from the log; empty when the row carried none. */
  ts: string;
  role: "user" | "assistant" | "summary" | "note";
  parts: TranscriptPart[];
  /** Native turn id, or a Claude group anchored to its human/continuation message uuid. */
  turnId?: string;
  /** Present only when the journal explicitly distinguishes narration from a final answer. */
  phase?: "commentary" | "final_answer";
  turn?: TranscriptTurn;
}

export interface TranscriptTurn {
  status: "running" | "completed" | "aborted";
  startedAt?: string;
  completedAt?: string;
  /** Native reported work duration; never calculated from message timestamps. */
  durationMs?: number;
}

/** Last reported provider metrics. Missing values are unknown, never inferred model limits. */
export interface SessionTelemetry {
  source: "journal" | "statusline";
  observedAt?: string;
  model?: string;
  effort?: string;
  tokens?: {
    input?: number;
    output?: number;
    cachedInput?: number;
    total?: number;
    scope: "session" | "last-message";
  };
  context?: { usedTokens?: number; windowTokens?: number; usedPercent?: number };
  rateLimits?: Array<{
    name: "primary" | "secondary";
    usedPercent: number;
    windowMinutes?: number;
    /** Epoch seconds, as reported by the provider. */
    resetsAt?: number;
  }>;
  /** The parsed log was tail-capped; metadata from its missing head may be unavailable. */
  fileTruncated: boolean;
}

/** What the history endpoint answers with, minus the pane id the route adds. */
export interface TranscriptPage {
  paneId: string;
  /** Oldest-first, ready to render top-down. */
  entries: TranscriptEntry[];
  /** True when older turns exist before `entries[0]` — drives "load older". */
  hasMore: boolean;
  /** Total turns available in the parsed window (after sidechain filtering). */
  total: number;
  /** True when the on-disk log exceeded the byte cap and we kept only its tail. */
  fileTruncated: boolean;
  telemetry?: SessionTelemetry;
}

/**
 * The fs seam. Real implementations live beside each adapter; tests inject a fake so no temp files
 * are needed (the repo convention — see sessions.test.ts / state-engine.test.ts).
 */
export interface TranscriptSource {
  /** Absolute path of the log this ref names, or null when it isn't on disk / isn't ours to read. */
  resolve(ref: AgentSessionRef): Promise<string | null>;
  /**
   * Size + mtime of a log, WITHOUT reading it — the store's cache-validity check.
   *
   * Split out from `load` on purpose: a journal can be 32 MB, and paging back through a long
   * conversation asks for the same file over and over. Reading it to discover the cache was already
   * valid made every "load older" tap a full re-read.
   */
  stat(path: string): Promise<{ size: number; mtimeMs: number; ino?: number } | null>;
  /** Tail-read a log. `complete` is false when the byte cap clipped the head. */
  load(path: string): Promise<{ text: string; complete: boolean; size: number; mtimeMs: number }>;
  /**
   * Bytes `[start, end)` of a log — the incremental path. Only file-backed sources have it; a source
   * without it (OpenCode's database) is always re-read whole. Its `stat` then also reports `ino`, so
   * a log replaced under the same name is never mistaken for one that grew.
   */
  read?(path: string, start: number, end: number): Promise<Uint8Array>;
}

/**
 * One harness's journal support: how to find its log, and how to read its grammar.
 *
 * `agent` is matched against the Herdr snapshot's `agent` string, and it is also the registry key —
 * the map is built FROM this field so the two can never drift (journal/registry.ts). An agent with
 * no adapter simply has no journal, which the route reports as an ordinary "no-session".
 *
 * `parse` is PURE — no fs, no clock — so every harness's grammar is table-testable under `bun test`.
 */
export interface JournalAdapter {
  readonly agent: string;
  readonly source: TranscriptSource;
  parse(text: string): TranscriptEntry[];
  /** Runs only when the cached log changes, over the same contained read as the transcript. */
  parseUsage?(text: string): Omit<SessionTelemetry, "fileTruncated"> | undefined;
  /** A resumable parser, for a harness whose log is append-only. Without one every change re-parses. */
  parser?(): JournalParser;
  /** The inline images of one parsed row, in the order an {@link ImageLocator}'s `nth` counts. */
  rowImages?(row: unknown): Array<{ mediaType?: string; data: string }>;
}
