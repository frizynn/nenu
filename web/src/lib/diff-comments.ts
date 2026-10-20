// Comments on a diff's changed lines, for the agent in the pane the diff was read from. They wait in
// this browser (memory, and sessionStorage so a reload keeps them) as chips over that pane's composer,
// and go out first in its next message, through the same guarded send as any other text.
import { useSyncExternalStore } from "react";

import { localSendScope } from "./local-sends";
import { isSlashCommand } from "./message-images";

/** One comment on one changed line. A line holds at most one: saving again replaces it. */
export interface DiffComment {
  /** The file as the diff names it: its new path for a rename. */
  path: string;
  /** "+" for an added line, numbered in the new file; "-" for a removed one, numbered in the old. */
  side: "+" | "-";
  line: number;
  /** The line's text as the diff shows it. */
  quote: string;
  text: string;
}

export type DiffLine = Omit<DiffComment, "text">;

const NONE: readonly DiffComment[] = [];
const KEY = "nenu.diff-comments:";
const memory = new Map<string, readonly DiffComment[]>();
const listeners = new Set<() => void>();

function isComment(value: unknown): value is DiffComment {
  const c = value as DiffComment | null;
  return typeof c === "object" && c !== null && typeof c.path === "string" && (c.side === "+" || c.side === "-")
    && Number.isSafeInteger(c.line) && typeof c.quote === "string" && typeof c.text === "string";
}

function read(scope: string): readonly DiffComment[] {
  let list = memory.get(scope);
  if (list) return list;
  try {
    const stored: unknown = JSON.parse(sessionStorage.getItem(KEY + scope) ?? "[]");
    list = Array.isArray(stored) ? stored.filter(isComment) : NONE;
  } catch {
    list = NONE;
  }
  memory.set(scope, list);
  return list;
}

function write(scope: string, list: readonly DiffComment[]): void {
  memory.set(scope, list);
  try {
    if (list.length) sessionStorage.setItem(KEY + scope, JSON.stringify(list));
    else sessionStorage.removeItem(KEY + scope);
  } catch {
    // Private mode or a full store: they stay in memory, for this page's life.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const sameLine = (a: DiffLine, b: DiffLine) => a.path === b.path && a.side === b.side && a.line === b.line;
const order = (a: DiffComment, b: DiffComment) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line || (a.side < b.side ? -1 : 1));

export function diffCommentsFor(paneId: string, session?: string): readonly DiffComment[] {
  return read(localSendScope(paneId, session));
}

/** The comments waiting for a pane, live; none without a pane. */
export function useDiffComments(paneId: string | undefined, session?: string): readonly DiffComment[] {
  return useSyncExternalStore(subscribe, () => (paneId === undefined ? NONE : diffCommentsFor(paneId, session)));
}

/** Saves `text` on a line, replacing what it held; blank text removes the line's comment. */
export function saveDiffComment(paneId: string, session: string | undefined, at: DiffLine, text: string): void {
  const scope = localSendScope(paneId, session);
  const kept = read(scope).filter((comment) => !sameLine(comment, at));
  const said = text.replace(/\s+/g, " ").trim();
  write(scope, said ? [...kept, { ...at, text: said }].sort(order) : kept);
}

/** Drops the comments a message carried, as they were then: one edited since stays for the next. */
export function forgetDiffComments(paneId: string, session: string | undefined, gone: readonly DiffComment[]): void {
  if (!gone.length) return;
  const scope = localSendScope(paneId, session);
  write(scope, read(scope).filter((comment) => !gone.includes(comment)));
}

/** The comments a message from the composer carries: none for a slash command, which goes alone. */
export function diffCommentsCarried(message: string, comments: readonly DiffComment[]): readonly DiffComment[] {
  return isSlashCommand(message) ? NONE : comments;
}

/** One code span around `text`, fenced past any backticks it holds. */
function code(text: string): string {
  const fence = "`".repeat(Math.max(0, ...(text.match(/`+/g) ?? []).map((run) => run.length)) + 1);
  return text.endsWith("`") ? `${fence} ${text} ${fence}` : fence + text + fence;
}

/** The message: the comments first, one a line with file:line and the line quoted, then the draft. */
export function withDiffComments(comments: readonly DiffComment[], draft: string): string {
  const carried = diffCommentsCarried(draft, comments);
  if (!carried.length) return draft;
  const lines = carried.map(({ path, side, line, quote, text }) => {
    const said = quote.trim();
    return `- ${path}:${line} ${code(`${side} ${said.length > 160 ? `${said.slice(0, 159)}…` : said}`)} ${text}`;
  });
  return ["Comments on the diff:", ...lines].join("\n") + (draft ? `\n\n${draft}` : "");
}
