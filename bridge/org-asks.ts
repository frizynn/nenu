import type { OrgRun } from "./org-cli.ts";
import { ASK_CONFIRMED, ASK_STATES, type Ask, type AskCoordinator, type AskDecision, type AskGroup, type AskLink } from "./org-types.ts";

// The operator's asks as Organizations reads them out of each coordinator's STATUS.md (docs/json.md,
// Asks): the state the coordinator wrote, the one its links confirm, and why they disagree. Nenu only
// shows them. Their text is the operator's and the coordinator's words, so it is drawn as text and
// never reaches a prompt or a terminal. Like the report fields, every value is read within bounds: a
// malformed one reads as none, and a longer list is cut, never refused.

const SCHEMA_VERSION = 1;
const MAX_ROWS = 500;
const MAX_LINKS = 10;
const MAX_DECISIONS = 50;
const MAX_TEXT = 1_000;
const LINK_KINDS: ReadonlyArray<AskLink["kind"]> = ["thread", "pr", "task", "page"];

/** One ask of `asks --json`, before the registry places it (`askGroup`). */
export interface OrgAskRow extends Ask {
  project: string;
  coordinator: AskCoordinator;
}

/** One `## Needs your decision` row of `asks --json`, before the registry places it (`decisionGroup`). */
export type OrgDecisionRow = Omit<AskDecision, "group">;

/**
 * `asks --json`: every coordinator's asks in Organizations' order, and its decision rows, undefined
 * from an Organizations that prints none (it prints them only from the release that answers them, and
 * leaves the field out when there is none). Null when this Organizations has no such document (it
 * refuses the command, or prints another schema version); thrown when the read itself failed, so the
 * caller can keep what it last read.
 */
export async function readAsks(run: OrgRun, root: string): Promise<{ asks: OrgAskRow[]; decisions?: OrgDecisionRow[] } | null> {
  const result = await run(["asks", "--json"], { env: { HERDR_PROJECTS_ROOT: root }, timeoutMs: 10_000 });
  if (result.code !== 0) {
    if (/unrecognized subcommand|unexpected argument/i.test(result.stderr)) return null;
    throw new Error(`asks --json failed (${result.code})`);
  }
  const value: unknown = JSON.parse(result.stdout);
  if (!isRecord(value) || value.schema_version !== SCHEMA_VERSION || !Array.isArray(value.asks)) return null;
  const asks = value.asks.flatMap((item): OrgAskRow[] => {
    const ask = isRecord(item) ? parseAsk(item) : null;
    const whose = isRecord(item) ? owner(item) : null;
    return ask && whose ? [{ ...whose, ...ask }] : [];
  }).slice(0, MAX_ROWS);
  if (!Array.isArray(value.decisions)) return { asks };
  const decisions = value.decisions.flatMap((item): OrgDecisionRow[] => {
    const whose = isRecord(item) ? owner(item) : null;
    if (!whose || !isRecord(item) || typeof item.text !== "string" || placeholder(item.text) || !lineOf(item.line)) return [];
    return [{ ...whose, text: item.text.slice(0, MAX_TEXT), line: lineOf(item.line), links: parseLinks(item.links), ...answered(item) }];
  }).slice(0, MAX_DECISIONS * 10);
  return { asks, decisions };
}

/** The project and coordinator a row of `asks --json` belongs to; null without them. */
function owner(item: Record<string, unknown>): { project: string; coordinator: AskCoordinator } | null {
  if (typeof item.project !== "string" || !isRecord(item.coordinator)) return null;
  const { id, title } = item.coordinator;
  return typeof id === "string" && id ? { project: item.project, coordinator: { id, title: text(title) } } : null;
}

/** A line number from 1, or 0. */
function lineOf(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : 0;
}

/** When the person answered the line, and whether Organizations takes an answer on it (`actions` lists `answer`). */
function answered(item: Record<string, unknown>): Pick<Ask, "answeredAt" | "answerable"> {
  const at = typeof item.answered_at === "string" && Number.isFinite(Date.parse(item.answered_at)) ? item.answered_at : "";
  const answerable = Array.isArray(item.actions) && item.actions.includes("answer");
  return { ...(at ? { answeredAt: at } : {}), ...(answerable ? { answerable: true } : {}) };
}

/** The links of a final parenthesis, as Organizations read them; a kind this Nenu does not know is dropped. */
function parseLinks(value: unknown): AskLink[] {
  return (Array.isArray(value) ? value : []).flatMap((link): AskLink[] => {
    const kind = isRecord(link) ? LINK_KINDS.find((candidate) => candidate === link.kind) : undefined;
    if (!kind || !isRecord(link)) return [];
    return [{
      kind, text: text(link.text), target: text(link.target), thread: text(link.thread), title: text(link.title),
      state: text(link.state), pr: text(link.pr), prState: text(link.pr_state),
    }];
  }).slice(0, MAX_LINKS);
}

/**
 * A line that is only a parenthesis, such as `(nothing for now; …)`: a coordinator's placeholder under a
 * heading, neither an ask nor a decision, so it neither lists nor counts as waiting on the person.
 */
export function placeholder(text: string): boolean {
  const line = text.trim();
  return line.startsWith("(") && line.endsWith(")");
}

/** One ask, from a status file's `asks` or a row of `asks --json`; null without a known state or text, or for a placeholder. */
export function parseAsk(value: unknown): Ask | null {
  if (!isRecord(value)) return null;
  const state = ASK_STATES.find((candidate) => candidate === value.state);
  if (!state || typeof value.text !== "string" || placeholder(value.text)) return null;
  return {
    line: lineOf(value.line),
    state,
    text: value.text.slice(0, MAX_TEXT),
    answer: text(value.answer),
    links: parseLinks(value.links),
    // A value from a newer Organizations confirms nothing this Nenu can name.
    confirmed: ASK_CONFIRMED.find((candidate) => candidate === value.confirmed) ?? "",
    mismatch: text(value.mismatch),
    ...answered(value),
  };
}

/** A status file's `needs_decision` lines, placeholders left out; none when the field is missing or malformed. */
export function parseDecisions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((line) => typeof line === "string" && line.trim() && !placeholder(line) ? [line.slice(0, MAX_TEXT)] : []).slice(0, MAX_DECISIONS);
}

/**
 * Where Your asks lists an ask, by Organizations' own order (asks.rs `Ask::rank`): what waits on the
 * person, what does not close, what is in progress, what is done, then lines that do not follow the
 * format. A resolved coordinator takes no answer, so its `needs-decision` waits on no one.
 */
export function askGroup(ask: Pick<Ask, "state" | "mismatch" | "answeredAt">, coordinatorResolved: boolean): AskGroup {
  // An answered `needs-decision` no longer waits on the person: it sorts with `open` and `working`.
  if (ask.state === "needs-decision" && !coordinatorResolved && !ask.answeredAt) return "waiting";
  if (ask.mismatch) return "unclosed";
  if (ask.state === "open" || ask.state === "working" || ask.state === "needs-decision") return "progress";
  if (ask.state === "answered" || ask.state === "done") return "done";
  return "other";
}

/** A decision waits on the person until answered, then is in progress until its coordinator moves it to `## Decisions`. */
export function decisionGroup(decision: Pick<AskDecision, "answeredAt">): AskDecision["group"] {
  return decision.answeredAt ? "progress" : "waiting";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_TEXT) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
