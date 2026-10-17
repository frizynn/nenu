// Your asks (ADR 0091): every coordinator's asks, in the groups Herdr Organizations' popup draws. The
// bridge reads them with `asks --json`, which sorts them and says where each one goes (`group`); the
// decisions under each coordinator's `## Needs your decision` join what waits on you, after the asks,
// as in the popup. Nothing here reorders or re-judges an ask. Its text is the person's and the
// coordinator's words, drawn as text. Its links read as chips (ADR 0093), each naming what it points at
// and the state Organizations confirmed.
import type { AskCoordinator, AskDecision, AskGroup, AskLink, AskRow, AsksList, OrgAsk, ProjectView } from "./types";

export const ASK_GROUP_LABEL: Record<AskGroup, string> = {
  waiting: "Wait on you", unclosed: "Does not close", progress: "In progress", done: "Done", other: "Other lines",
};
const ORDER: readonly AskGroup[] = ["waiting", "unclosed", "progress", "done", "other"];

/** One row of Your asks: an ask, or a decision line that waits on you. */
export interface AskEntry {
  key: string;
  group: AskGroup;
  project: ProjectView;
  coordinator: AskCoordinator;
  /** The ask, or the decision line. */
  text: string;
  /** Its answer, or why it does not close; `decision` for a decision line. */
  detail: string;
  links: AskLink[];
  /** Its line in the coordinator's STATUS.md, which `asks answer` names; 0 where Organizations gave none. */
  line: number;
  /** Organizations takes an answer on it. */
  answerable: boolean;
  /** When the person answered it, until its coordinator changes the line. */
  answeredAt?: string;
}

/** Narrows the list to a project, and within it to one coordinator (`root` for the project's own). */
export interface AskFilter { project?: string; coordinator?: string }

const matches = (filter: AskFilter, item: { project: string; coordinator: AskCoordinator }) =>
  (!filter.project || item.project === filter.project) && (!filter.coordinator || item.coordinator.id === filter.coordinator);

/** The groups that hold something, in reading order, each in Organizations' order; only projects on screen, and only what the filter keeps. */
export function askSections(list: AsksList, projects: readonly ProjectView[], filter: AskFilter = {}): Array<{ group: AskGroup; label: string; entries: AskEntry[] }> {
  const bySlug = new Map(projects.map((project) => [project.slug, project]));
  const asks = (list.asks ?? []).flatMap((row, index): AskEntry[] => {
    const project = bySlug.get(row.project);
    return project && matches(filter, row) ? [{ key: `ask:${row.project}:${row.coordinator.id}:${row.line}:${index}`, group: row.group, project,
      coordinator: row.coordinator, text: row.text, detail: askDetail(row), links: row.links, line: row.line,
      answerable: row.answerable === true, ...(row.answeredAt ? { answeredAt: row.answeredAt } : {}) }] : [];
  });
  const decisions = list.decisions.flatMap((decision, index): AskEntry[] => {
    const project = bySlug.get(decision.project);
    return project && matches(filter, decision) ? [{ key: `decision:${decision.project}:${decision.coordinator.id}:${decision.line}:${index}`,
      group: decision.group ?? "waiting", project, coordinator: decision.coordinator, text: decision.text, detail: "decision",
      links: decision.links ?? [], line: decision.line ?? 0, answerable: decision.answerable === true, ...(decision.answeredAt ? { answeredAt: decision.answeredAt } : {}) }] : [];
  });
  // A decision follows the asks of its group, as the popup lists them.
  return ORDER.flatMap((group) => {
    const entries = [...asks.filter((entry) => entry.group === group), ...decisions.filter((entry) => entry.group === group)];
    return entries.length ? [{ group, label: ASK_GROUP_LABEL[group], entries }] : [];
  });
}

/** `all coordinators · 2 wait on you · 1 does not close · 3 in progress · 1 done`, as the popup heads its list; `scope` names a narrowed one. */
export function asksHeadline(sections: ReturnType<typeof askSections>, scope = "all coordinators"): string {
  const count = (group: AskGroup) => sections.find((section) => section.group === group)?.entries.length ?? 0;
  const waiting = count("waiting");
  const unclosed = count("unclosed");
  return [
    scope,
    `${waiting} ${waiting === 1 ? "waits on you" : "wait on you"}`,
    `${unclosed} ${unclosed === 1 ? "does not close" : "do not close"}`,
    `${count("progress")} in progress`,
    `${count("done")} done`,
  ].join(" · ");
}

/** What a row says after the ask: why it does not close, else its answer. Its links are chips of their own (`linkChip`). */
export function askDetail(ask: OrgAsk): string {
  return ask.mismatch ? `${words(ask.state)} · ${ask.mismatch}` : ask.answer;
}

/** How a link's state reads at a glance: waits on you, still moving, finished, or gone wrong. */
export type ChipTone = "waiting" | "moving" | "review" | "done" | "off";

/** A link as a chip: what it points at, in a few words, and the state Organizations confirmed. */
export interface LinkChip {
  label: string;
  /** Organizations' state in words (`needs you`, `merged`), empty when it knows none. */
  state: string;
  tone: ChipTone;
  /** The thread it opens inside Nenu, or the page or pull request it opens in a new tab. */
  thread?: string;
  href?: string;
}

const TONE: Record<string, ChipTone> = {
  "waiting-on-you": "waiting", working: "moving", landing: "moving", open: "moving", todo: "moving", "ready-for-review": "review",
  idle: "off", resolved: "done", done: "done", merged: "done", failed: "off", closed: "off", missing: "off",
};
const STATE_WORD: Record<string, string> = { "waiting-on-you": "needs you", "ready-for-review": "review" };

/** `t-0007 · working`, `#12 · merged`, `AWA-569 · missing`, a page's host. */
export function linkChip(link: AskLink): LinkChip {
  const state = STATE_WORD[link.state] ?? words(link.state);
  const tone = TONE[link.state] ?? "off";
  const web = /^https?:\/\//.test(link.target) ? link.target : undefined;
  switch (link.kind) {
    case "thread": return { label: link.thread || link.text, state, tone, ...(link.thread ? { thread: link.thread } : {}) };
    case "pr": {
      // A pull request's address reads as its number.
      const number = link.text.match(/\/pull\/(\d+)/)?.[1];
      return { label: number ? `#${number}` : link.text, state, tone, ...(web ? { href: web } : {}) };
    }
    case "task": return { label: link.text.replace(/^task:/, ""), state, tone };
    case "page": return { label: hostOf(link.text), state: "", tone: "off", ...(web ? { href: web } : {}) };
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** The ask with its answer, as a coordinator's card lists what waits on you. */
export function said(ask: OrgAsk): string {
  return ask.answer ? `${ask.text} : ${ask.answer}` : ask.text;
}

/** A coordinator as an ask names it: the project's own is the Coordinator. */
export function coordinatorName(coordinator: AskCoordinator): string {
  return coordinator.id === "root" ? "Coordinator" : coordinator.title || coordinator.id;
}

/**
 * One coordinator's part of the list, for its card: what waits on you (its decisions, then its asks
 * that need one) and its other asks, in Organizations' order. Null when Organizations cannot list asks.
 */
export function coordinatorAsks(list: AsksList | null, project: string, coordinator: string): { waiting: string[]; asks: AskRow[] } | null {
  if (!list?.asks) return null;
  const mine = (item: { project: string; coordinator: AskCoordinator }) => item.project === project && item.coordinator.id === coordinator;
  const rows = list.asks.filter(mine);
  return {
    waiting: [...list.decisions.filter((decision) => mine(decision) && decision.group !== "progress").map((decision: AskDecision) => decision.text),
      ...rows.filter((row) => row.group === "waiting").map(said)],
    asks: rows.filter((row) => row.group !== "waiting"),
  };
}

/** Organizations' tokens read as words: `waiting-on-you` → `waiting on you`. */
const words = (token: string) => token.replaceAll("-", " ");
