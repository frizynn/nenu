import { classifyUserText, unwrapPastes } from "./journal/claude.ts";
import { readAppended, type TailState } from "./journal/lines.ts";

// What Claude itself logged for a message Nenu just submitted (ADR 0067, ADR 0076).
//
// The guarded send verifies a long message by Claude's paste token, which says nothing about what the
// token holds. Measured on Claude Code 2.1.296, 2.1.299 and 2.1.300 under Herdr 0.9.3 on macOS: the
// PTY hands a 1 500-character send to Claude as two reads, 1 022 and 478 bytes; Claude takes the
// first as a paste and about two times in three logs only the second. The box then shows the literal
// tail, a slice of the message like any windowed draft, so the screen said "sent". The log is the
// only witness of what arrived.

/** The newest bytes the first look reads; later looks read only what was appended since. */
const FIRST_LOOK_BYTES = 1024 * 1024;

/** The operator's typed message in one log line, and when Claude logged it; null for any other row. */
export function loggedMessage(line: string): { at: number; text: string } | null {
  let row: Record<string, unknown>;
  try {
    row = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (row.type !== "user" || typeof row.timestamp !== "string") return null;
  const at = Date.parse(row.timestamp);
  const content = (row.message as { content?: unknown } | undefined)?.content;
  let raw: string;
  if (typeof content === "string") raw = content;
  else if (Array.isArray(content) && content.every((block) => (block as { type?: unknown })?.type !== "tool_result")) {
    raw = content.flatMap((block) => ((block as { type?: unknown }).type === "text" ? [String((block as { text?: unknown }).text ?? "")] : [])).join("");
  } else return null;
  const classified = classifyUserText(raw, { origin: row.origin, isMeta: row.isMeta });
  if (classified?.role !== "user" || classified.command !== undefined || classified.text.startsWith("! ")) return null;
  return Number.isNaN(at) ? null : { at, text: raw };
}

/** The text of a message Claude queued at or after `since` (it was busy): its own row comes later. */
function queuedSince(line: string, since: number): string | null {
  if (!line.includes('"queue-operation"')) return null;
  try {
    const row = JSON.parse(line) as Record<string, unknown>;
    const queued = row.type === "queue-operation" && row.operation === "enqueue" && typeof row.timestamp === "string" && Date.parse(row.timestamp) >= since;
    return queued ? String(row.content ?? "") : null;
  } catch {
    return null;
  }
}

export type DeliveryVerdict =
  | { verdict: "complete" }
  | { verdict: "incomplete"; sentChars: number; receivedChars: number }
  | { verdict: "unknown" };

/** A path to an image Claude attaches as `[Image #N]`, which shortens the logged text on purpose. */
const IMAGE_PATH = /(?:^|\s)["']?(?:\/|[A-Za-z]:\\)\S*\.(?:png|jpe?g|gif|webp)\b/i;
const strip = (s: string) => s.replace(/\s+/g, "");

/**
 * Whether `received` (Claude's log of the message) holds all of `sent`. Whitespace is not compared:
 * Claude re-flows it around a paste. A log with fewer characters is incomplete; one Claude rewrites by
 * design (an attached image) or that differs some other way is not judged.
 */
export function deliveryVerdict(sent: string, received: string | null): DeliveryVerdict {
  if (received === null || IMAGE_PATH.test(sent)) return { verdict: "unknown" };
  const want = strip(sent);
  const got = strip(unwrapPastes(received));
  if (got === want) return { verdict: "complete" };
  if (got.length < want.length) return { verdict: "incomplete", sentChars: sent.length, receivedChars: unwrapPastes(received).trim().length };
  return { verdict: "unknown" };
}

/** A picture's path, or the `[Image #N]` Claude logs in its place: neither says which message it is. */
const PICTURE = /\[Image #\d+\]|(?:^|\s)["']?(?:\/|[A-Za-z]:\\)\S*\.(?:png|jpe?g|gif|webp)\b/gi;
const words = (s: string) => strip(unwrapPastes(s).replace(PICTURE, " "));
/** Characters a logged tail needs before it can stand for a message whose head was dropped. */
const TAIL_MIN = 32;

/** Whether `sent` has words its log can be told by; pictures alone do not. */
export function hasWords(sent: string): boolean {
  return words(sent).length > 0;
}

/**
 * Whether `logged` is `sent` as Claude logs it: the same words, pictures aside, or the tail a dropped
 * head leaves (ADR 0076). Another message, the operator's at the terminal or a second device's, is not.
 */
export function sameMessage(sent: string, logged: string): boolean {
  const want = words(sent);
  const got = words(logged);
  // A message of pictures alone has no words to tell it from another: the box decides that one.
  return want.length > 0 && (got === want || (got.length >= TAIL_MIN && want.endsWith(got)));
}

/** What one look at Claude's log found for a message. */
export type LogLook =
  | { kind: "logged"; text: string }
  | { kind: "queued" }
  /** The log, read back to `since`, holds no such message yet. */
  | { kind: "none" }
  /** No log to read, or none that reaches back to `since`: it can say nothing either way. */
  | { kind: "unreadable" };

export type LogReader = (since: number, sent: string) => Promise<LogLook>;

/**
 * Looks at a Claude session's log for one message (ADR 0076, ADR 0116). Each call reads only what was
 * appended since the last one and answers that message logged, or queued, at or after `since`; other
 * messages are skipped. "none" only from a log that is read back to `since`.
 */
export function claudeLogReader(transcript: () => Promise<string | null>): LogReader {
  let path: string | null = null;
  let tail: TailState | undefined;
  // The oldest moment the lines read so far reach back to; -Infinity once a read began at the start.
  let reach = Infinity;
  return async (since, sent) => {
    path ??= await transcript().catch(() => null);
    if (path === null) return { kind: "unreadable" };
    let read: Awaited<ReturnType<typeof readAppended>>;
    try {
      read = await readAppended(path, FIRST_LOOK_BYTES, tail);
    } catch {
      return { kind: "unreadable" };
    }
    tail = read.tail;
    if (read.reset) reach = read.truncated ? Infinity : -Infinity;
    for (const line of read.lines) {
      const at = /"timestamp":"([^"]+)"/.exec(line)?.[1];
      if (reach === Infinity && at) reach = Date.parse(at);
      const queued = queuedSince(line, since);
      if (queued !== null && sameMessage(sent, queued)) return { kind: "queued" };
      const message = loggedMessage(line);
      if (message && message.at >= since && sameMessage(sent, message.text)) return { kind: "logged", text: message.text };
    }
    return reach <= since ? { kind: "none" } : { kind: "unreadable" };
  };
}
