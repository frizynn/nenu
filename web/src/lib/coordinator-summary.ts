// A coordinator's Summary: the work under it by outcome, for a person who reads results instead of
// chats. The tree (org-tree.ts) stays the way Organizations draws it; only this view groups by
// outcome (ADR 0088). Closed facts come first (resolved, merged), then what the agent is doing now,
// then what its last report said, so a report that says "done" never hides an agent that is asking
// you something again, and an old "blocked" never hides one that is back at work.
import { nodeState } from "./org-tree";
import type { ProjectThreadView, ThreadVerdict } from "./types";

export type Outcome = "decide" | "progress" | "done";

export const OUTCOME_LABEL: Record<Outcome, string> = { decide: "Needs your decision", progress: "In progress", done: "Done" };
const ORDER: readonly Outcome[] = ["decide", "progress", "done"];

/** How a report's verdict reads on a card. */
export const VERDICT_LABEL: Record<ThreadVerdict, string> = { done: "Done", "needs-decision": "Asks for your decision", blocked: "Blocked", failed: "Failed" };

export function outcome(thread: ProjectThreadView): Outcome {
  if (thread.status === "resolved" || thread.pr?.state === "merged") return "done";
  const state = nodeState(thread);
  if (state === "needs") return "decide";
  if (state === "working") return "progress";
  if (thread.verdict && thread.verdict !== "done") return "decide";
  return thread.verdict === "done" || state === "review" ? "done" : "progress";
}

const updatedAt = (thread: ProjectThreadView) => Date.parse(thread.updated ?? "") || 0;

/** The sections that hold something, in reading order, each newest first. */
export function summarySections(threads: readonly ProjectThreadView[]): Array<{ outcome: Outcome; label: string; threads: ProjectThreadView[] }> {
  return ORDER.flatMap((section) => {
    const list = threads.filter((thread) => outcome(thread) === section).sort((a, b) => updatedAt(b) - updatedAt(a));
    return list.length ? [{ outcome: section, label: OUTCOME_LABEL[section], threads: list }] : [];
  });
}
