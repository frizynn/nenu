// When a chat last moved, and how chats are grouped by it. Kept free of React so the sidebar, the
// home list and the drawer share one definition and the rules stay unit-testable.
import type { AgentView } from "./types";

export type RecencyKey = "today" | "yesterday" | "week" | "month" | "older";
/** Each period names only what it holds: Previous 7 days starts the day before yesterday. */
export const RECENCY_LABEL: Record<RecencyKey, string> = { today: "Today", yesterday: "Yesterday", week: "Previous 7 days", month: "Previous 30 days", older: "Older" };

/** Last time the chat moved or was opened; 0 when an older bridge reports neither. */
export function chatRecency(pane: AgentView): number {
  return Math.max(pane.lastActiveAt ?? 0, pane.lastSeenAt ?? 0);
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function recencyOf(ts: number, now: number): RecencyKey {
  if (!ts) return "older";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (ts >= startOfToday.getTime()) return "today";
  const startOfYesterday = new Date(startOfToday);
  startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  if (ts >= startOfYesterday.getTime()) return "yesterday";
  if (now - ts < 7 * DAY_MS) return "week";
  return now - ts < 30 * DAY_MS ? "month" : "older";
}

export interface RecencyGroup<T> {
  key: RecencyKey;
  label: string;
  items: T[];
}

export function byRecency(panes: readonly AgentView[]): AgentView[] {
  return [...panes].sort((a, b) => chatRecency(b) - chatRecency(a));
}

/** Newest first, under the periods that hold something, in display order: a heading never stands alone. */
export function groupByRecency<T>(items: readonly T[], at: (item: T) => number, now: number): RecencyGroup<T>[] {
  const sorted = [...items].sort((a, b) => at(b) - at(a));
  return (Object.keys(RECENCY_LABEL) as RecencyKey[])
    .map((key) => ({ key, label: RECENCY_LABEL[key], items: sorted.filter((item) => recencyOf(at(item), now) === key) }))
    .filter((group) => group.items.length > 0);
}
