// What a screen no grammar recognised is waiting on. Read only after the adapter has said its
// composer is not ready and no dialog block claims the keyboard, so it never decides what is safe to
// send; it only decides what the chat says about the terminal.

/** A key hint of the kind a modal footer prints ("Enter to confirm", "esc to cancel"). */
const WAIT_HINT = /(?:enter|esc(?:ape)?)\s+(?:to\s+)?(?:confirm|cancel|continue|skip|select|go back)/i;
/** Claude's usage-limit pause: it prints "esc to cancel" but resumes by itself. */
const AUTO_RESUME = /usage limit|limit resets|continuing automatically/i;
/** How far up from the tail a hint still counts as the screen's current state. */
const TAIL_ROWS = 25;

export type TerminalWait =
  /** A key hint nothing explains: the terminal may really want an answer. `hint` is that row. */
  | { kind: "interaction"; hint: string }
  /** Every hint belongs to a pause the agent leaves on its own. `text` is its one-line summary. */
  | { kind: "notice"; text: string };

export function terminalWait(text: string): TerminalWait | null {
  const rows = text.split("\n").slice(-TAIL_ROWS).map((row) => row.trim()).filter(Boolean);
  const hints = rows.filter((row) => WAIT_HINT.test(row));
  if (hints.length === 0) return null;
  const unexplained = hints.findLast((row) => !AUTO_RESUME.test(row));
  if (unexplained !== undefined) return { kind: "interaction", hint: unexplained };
  const summary = rows.findLast((row) => /usage limit|limit resets/i.test(row)) ?? hints.at(-1)!;
  return { kind: "notice", text: withoutKeyHints(summary) };
}

/** Drops the "esc to cancel" segments: the notice is not an invitation to press them. */
function withoutKeyHints(row: string): string {
  return row.replace(/^[^\p{L}\p{N}]+/u, "").split(/\s+·\s+/).filter((segment) => !WAIT_HINT.test(segment)).join(" · ");
}
