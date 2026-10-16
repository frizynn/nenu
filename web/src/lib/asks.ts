// Your asks (ADR 0091): every coordinator's asks, in the groups Herdr Organizations' popup draws. The
// bridge reads them with `asks --json`, which sorts them and says where each one goes (`group`); the
// decisions under each coordinator's `## Needs your decision` join what waits on you, after the asks,
// as in the popup. Nothing here reorders or re-judges an ask. Its text is the person's and the
// coordinator's words, drawn as text.
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
  /** Its answer and what its links confirm, or why it does not close; `decision` for a decision line. */
  detail: string;
}

/** The groups that hold something, in reading order, each in Organizations' order; only projects on screen. */
export function askSections(list: AsksList, projects: readonly ProjectView[]): Array<{ group: AskGroup; label: string; entries: AskEntry[] }> {
  const bySlug = new Map(projects.map((project) => [project.slug, project]));
  const asks = (list.asks ?? []).flatMap((row, index): AskEntry[] => {
    const project = bySlug.get(row.project);
    return project ? [{ key: `ask:${row.project}:${row.coordinator.id}:${row.line}:${index}`, group: row.group, project, coordinator: row.coordinator, text: row.text, detail: askDetail(row) }] : [];
  });
  const decisions = list.decisions.flatMap((decision, index): AskEntry[] => {
    const project = bySlug.get(decision.project);
    return project ? [{ key: `decision:${decision.project}:${decision.coordinator.id}:${index}`, group: "waiting", project, coordinator: decision.coordinator, text: decision.text, detail: "decision" }] : [];
  });
  return ORDER.flatMap((group) => {
    const entries = [...asks.filter((entry) => entry.group === group), ...(group === "waiting" ? decisions : [])];
    return entries.length ? [{ group, label: ASK_GROUP_LABEL[group], entries }] : [];
  });
}

/** `all coordinators · 2 wait on you · 1 does not close · 3 in progress · 1 done`, as the popup heads its list. */
export function asksHeadline(sections: ReturnType<typeof askSections>): string {
  const count = (group: AskGroup) => sections.find((section) => section.group === group)?.entries.length ?? 0;
  const waiting = count("waiting");
  const unclosed = count("unclosed");
  return [
    "all coordinators",
    `${waiting} ${waiting === 1 ? "waits on you" : "wait on you"}`,
    `${unclosed} ${unclosed === 1 ? "does not close" : "do not close"}`,
    `${count("progress")} in progress`,
    `${count("done")} done`,
  ].join(" · ");
}

/** What a row says after the ask, as the popup says it: why it does not close, else its answer and what each link confirms. */
export function askDetail(ask: OrgAsk): string {
  if (ask.mismatch) return `${words(ask.state)} · ${ask.mismatch}`;
  return [ask.answer, ...ask.links.map(linkWords)].filter(Boolean).join(" · ");
}

/** `t-0007 working (PR open)`, `#12 merged`, a page's address. */
export function linkWords(link: AskLink): string {
  const state = link.state ? ` ${words(link.state)}` : "";
  const pr = link.kind === "thread" && link.prState ? ` (PR ${link.prState})` : "";
  return `${link.text}${state}${pr}`;
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
    waiting: [...list.decisions.filter(mine).map((decision: AskDecision) => decision.text), ...rows.filter((row) => row.group === "waiting").map(said)],
    asks: rows.filter((row) => row.group !== "waiting"),
  };
}

/** Organizations' tokens read as words: `waiting-on-you` → `waiting on you`. */
const words = (token: string) => token.replaceAll("-", " ");
