// Your asks (ADR 0091): every coordinator's asks, in the groups Herdr Organizations' popup draws. The
// bridge reads them with `asks --json`, which sorts them and says where each one goes (`group`); the
// decisions under each coordinator's `## Needs your decision` join what waits on you, after the asks,
// as in the popup. Nothing here reorders or re-judges an ask. Its text is the person's and the
// coordinator's words, drawn as text. Its links read as chips (ADR 0093), each naming what it points at
// and the state Organizations confirmed. Rows of one coordinator about the same thread or task read as
// one question with its parts, and a row that does not close says what is still open (ADR 0096).
import type { AskCoordinator, AskDecision, AskGroup, AskLink, AskRow, AskState, AsksList, OrgAsk, ProjectView } from "./types";

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
  /** What the coordinator wrote in its brackets, and why that does not close with its links; an ask's only. */
  state?: AskState;
  mismatch?: string;
  /** The rows of the same coordinator about the same thread or task, folded under this one (`foldRelated`). */
  parts: AskEntry[];
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
      coordinator: row.coordinator, text: row.text, detail: row.answer, links: row.links, line: row.line, state: row.state, mismatch: row.mismatch,
      answerable: row.answerable === true, ...(row.answeredAt ? { answeredAt: row.answeredAt } : {}), parts: [] }] : [];
  });
  const decisions = list.decisions.flatMap((decision, index): AskEntry[] => {
    const project = bySlug.get(decision.project);
    return project && matches(filter, decision) ? [{ key: `decision:${decision.project}:${decision.coordinator.id}:${decision.line}:${index}`,
      group: decision.group ?? "waiting", project, coordinator: decision.coordinator, text: decision.text, detail: "decision",
      links: decision.links ?? [], line: decision.line ?? 0, answerable: decision.answerable === true, ...(decision.answeredAt ? { answeredAt: decision.answeredAt } : {}), parts: [] }] : [];
  });
  // A decision follows the asks of its group, as the popup lists them.
  return ORDER.flatMap((group) => {
    const listed = [...asks.filter((entry) => entry.group === group), ...decisions.filter((entry) => entry.group === group)];
    // Each row that does not close has its own reason and its own ask of the coordinator: none folds.
    const entries = group === "unclosed" ? listed : foldRelated(listed);
    return entries.length ? [{ group, label: ASK_GROUP_LABEL[group], entries }] : [];
  });
}

/** What a row that waits on you is: a decision its coordinator put to you, or something you asked that now needs your call. */
export type AskKind = "decision" | "ask";

export const ASK_KIND_LABEL: Record<AskKind, string> = { decision: "Decision", ask: "Your ask" };

export function askKind(entry: Pick<AskEntry, "group" | "detail">): AskKind | undefined {
  if (entry.group !== "waiting") return undefined;
  return entry.detail === "decision" ? "decision" : "ask";
}

/**
 * A waiting row as two lines: what it asks of you, then what its coordinator says about it. A decision
 * is written `<what goes to the user> : <recommendation>` (Organizations' skill/COORDINATOR.md), so it
 * splits at the first ` : `; an ask's second line is its coordinator's answer.
 */
export function askHeadline(entry: Pick<AskEntry, "text" | "detail">): { title: string; body: string } {
  if (entry.detail !== "decision") return { title: entry.text, body: entry.detail };
  const at = entry.text.indexOf(" : ");
  return at > 0 ? { title: entry.text.slice(0, at).trim(), body: entry.text.slice(at + 3).trim() } : { title: entry.text, body: "" };
}

/** The threads and tasks a row's links name: what it is about. A page names nothing Organizations confirmed. */
function subjects(entry: Pick<AskEntry, "links">): string[] {
  return entry.links.flatMap((link) => link.thread ? [`thread:${link.thread}`] : link.kind === "task" && link.target ? [`task:${link.target}`] : []);
}

/** The task ids a row's links name. */
const taskIds = (entry: Pick<AskEntry, "links">) => entry.links.flatMap((link) => link.kind === "task" && link.target ? [link.target] : []);

/** The task id a line opens with, among `ids`: `ACM-12 cuotas: …` opens with ACM-12. */
function opensWith(text: string, ids: readonly string[]): string | undefined {
  return ids.find((id) => text.startsWith(id) && (text.length === id.length || /[\s:,.;·-]/.test(text[id.length]!)));
}

/**
 * One question with its parts. Within a group, a row joins an earlier row of the same coordinator when
 * their links name the same thread or task, or when it links no thread or task itself and its text
 * opens with the id of a task that row links. The earlier row (an ask comes before the decisions)
 * heads it, and each part keeps its own line and Answer. Nothing joins across coordinators or
 * groups, and a task id counts only when Organizations confirmed it as a link.
 */
export function foldRelated(entries: readonly AskEntry[]): AskEntry[] {
  const heads: AskEntry[] = [];
  for (const entry of entries) {
    const own = subjects(entry);
    const head = heads.find((candidate) => {
      if (candidate.project.slug !== entry.project.slug || candidate.coordinator.id !== entry.coordinator.id) return false;
      const theirs = [candidate, ...candidate.parts];
      if (own.length) return theirs.some((part) => subjects(part).some((subject) => own.includes(subject)));
      return opensWith(entry.text, theirs.flatMap(taskIds)) !== undefined;
    });
    if (head) head.parts.push(entry);
    else heads.push({ ...entry, parts: [] });
  }
  return heads;
}

/** A part's words under its question: without the task id the question already names. */
export function partText(head: AskEntry, part: AskEntry): string {
  const id = opensWith(part.text, [head, ...head.parts].flatMap(taskIds));
  return id ? part.text.slice(id.length).replace(/^[\s:,.;·-]+/, "") || part.text : part.text;
}

/** The thread whose report explains a question: the first its links, or its parts' links, name. */
export function contextThread(entry: AskEntry): string | undefined {
  return [entry, ...entry.parts].flatMap((part) => part.links).find((link) => link.thread)?.thread;
}

/** Why a row does not close, in plain words, and what Nenu may ask its coordinator about it. */
export interface Unclosed {
  /** `Marked done, but task ACM-9 is still to do.` */
  said: string;
  /** The open task's or thread's title, when Organizations knows it. */
  title: string;
  /** The sentence its coordinator is sent on the person's tap: ids and states only, never the ask's words. */
  request: string;
}

/** A link as the sentence names it: a thread by its title (`byId`: its id), a pull request by its number, a task by its id. */
function named(link: AskLink, pr: boolean, byId = false): string {
  if (!pr) return link.kind === "thread" ? (byId ? "" : link.title) || link.thread || link.text : linkChip(link).label;
  const url = link.kind === "pr" ? link.text : link.pr;
  const number = url.match(/\/pull\/(\d+)/)?.[1];
  return number ? `#${number}` : url || link.text;
}

/** Each fixed reason of `mismatch` (docs/json.md, Asks): which link it is about, and what to say of it. */
const UNCLOSED: Record<string, { pr?: true; link: (link: AskLink) => boolean; what: (name: string) => string }> = {
  "a linked task is still to do": { link: (link) => link.kind === "task" && link.state === "todo", what: (name) => `task ${name} is still to do` },
  "a linked PR is still open": { pr: true, link: (link) => (link.kind === "pr" && link.state === "open") || link.prState === "open", what: (name) => `PR ${name} is still open` },
  "a linked thread is still working": { link: (link) => link.kind === "thread" && ["working", "waiting-on-you", "landing", "ready-for-review", "idle"].includes(link.state), what: (name) => `thread ${name} is still working` },
  "a linked thread failed": { link: (link) => link.kind === "thread" && link.state === "failed", what: (name) => `thread ${name} failed` },
  "a linked PR is closed": { pr: true, link: (link) => (link.kind === "pr" && link.state === "closed") || link.prState === "closed", what: (name) => `PR ${name} was closed without merging` },
  "a linked thread is resolved": { link: (link) => link.kind === "thread" && link.state === "resolved", what: (name) => `thread ${name} is already resolved` },
  "a linked PR is merged": { pr: true, link: (link) => (link.kind === "pr" && link.state === "merged") || link.prState === "merged", what: (name) => `PR ${name} is already merged` },
  "a linked task is done": { link: (link) => link.kind === "task" && link.state === "done", what: (name) => `task ${name} is already done` },
  "no thread, PR or task is linked": { link: () => true, what: () => "it links no thread, PR or task that shows the work" },
};

/** What does not close and where, from Organizations' reason and the link it names; null when it closes. */
export function unclosed(entry: Pick<AskEntry, "state" | "mismatch" | "links" | "line">): Unclosed | null {
  if (!entry.mismatch || !entry.state) return null;
  const state = words(entry.state);
  const reason = UNCLOSED[entry.mismatch];
  const link = reason && (entry.mismatch === "no thread, PR or task is linked" ? undefined : entry.links.find(reason.link));
  // A reason this Nenu does not know, or one whose link it cannot find, is said in Organizations' words.
  const known = reason && (link || entry.mismatch === "no thread, PR or task is linked");
  const what = (byId: boolean) => known ? reason.what(link ? named(link, reason.pr === true, byId) : "") : entry.mismatch;
  return {
    said: `Marked ${state}, but ${what(false)}.`,
    title: link?.kind === "thread" ? "" : link?.title ?? "",
    request: `In your STATUS.md, line ${entry.line} under "## Asked" is marked ${state}, but ${what(true)}. Close what is still open, or update the line and say why it stays as it is. (Sent from Nenu.)`,
  };
}

/**
 * A report as a question's context draws it: without the `Status:` line above its first section (the
 * verdict says it) and without its `## Captures` list, which the gallery under it shows as pictures.
 */
export function reportBody(text: string): string {
  const lines = text.split("\n");
  const first = lines.findIndex((line) => line.startsWith("## "));
  const kept = first > 0 && lines.slice(0, first).every((line) => !line.trim() || /^status:/i.test(line.trim())) ? lines.slice(first) : lines;
  const out: string[] = [];
  let skipping = false;
  for (const line of kept) {
    if (line.startsWith("## ")) skipping = /^##\s+captures\s*$/i.test(line);
    if (!skipping) out.push(line);
  }
  return out.join("\n").trim();
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
  "waiting-on-you": "waiting", working: "moving", landing: "moving", "awaiting-merge": "moving", open: "moving", todo: "moving", "ready-for-review": "review",
  idle: "off", resolved: "done", done: "done", merged: "done", failed: "off", closed: "off", missing: "off",
};
const STATE_WORD: Record<string, string> = { "waiting-on-you": "needs you", "ready-for-review": "review", "awaiting-merge": "awaiting merge" };

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
