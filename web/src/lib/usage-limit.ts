import { clockTime } from "@/lib/format";
import type { TurnState } from "@/lib/types";

// A Claude held by its account's usage limit (ADR 0118): the bridge reads it from Claude's own log
// and drops it once the reset passed or a reply came through on the account.

export type UsageLimit = NonNullable<TurnState["limit"]>;

/** The limit holding a pane, if one does. */
export const usageLimitOf = (pane: { turn?: TurnState } | null | undefined): UsageLimit | undefined => pane?.turn?.limit;

/** When it resets, on the phone's clock: "6:40 PM", with the weekday once it is not today. */
export function resetTime(resetsAt: number, now = Date.now()): string {
  const at = new Date(resetsAt);
  const day = at.toDateString() === new Date(now).toDateString() ? "" : `${at.toLocaleDateString(undefined, { weekday: "short" })} `;
  return `${day}${clockTime(resetsAt)}`;
}

/** The line that names the state wherever a pane shows one: "Usage limit · resets 6:40 PM". */
export const limitLine = (limit: UsageLimit, now?: number): string => `Usage limit · resets ${resetTime(limit.resetsAt, now)}`;

/**
 * What "Continue now" types: Claude's own automatic continue (2.1.307, read in code) without its claim
 * that the limit reset, since the operator may have switched the account instead.
 */
export const CONTINUE_PROMPT = "Continue the task you were working on when the usage limit was reached; do not repeat work that is already complete.";
