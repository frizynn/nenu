import type { OrgRun } from "./org-cli.ts";
import { ASK_CONFIRMED, ASK_STATES, type Ask, type AskCoordinator, type AskGroup, type AskLink } from "./org-types.ts";

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

/**
 * `asks --json`: every coordinator's asks in Organizations' order. Null when this Organizations has
 * no such document (it refuses the command, or prints another schema version); thrown when the read
 * itself failed, so the caller can keep what it last read.
 */
export async function readAsks(run: OrgRun, root: string): Promise<OrgAskRow[] | null> {
  const result = await run(["asks", "--json"], { env: { HERDR_PROJECTS_ROOT: root }, timeoutMs: 10_000 });
  if (result.code !== 0) {
    if (/unrecognized subcommand|unexpected argument/i.test(result.stderr)) return null;
    throw new Error(`asks --json failed (${result.code})`);
  }
  const value: unknown = JSON.parse(result.stdout);
  if (!isRecord(value) || value.schema_version !== SCHEMA_VERSION || !Array.isArray(value.asks)) return null;
  return value.asks.flatMap((item): OrgAskRow[] => {
    const ask = isRecord(item) ? parseAsk(item) : null;
    if (!ask || !isRecord(item) || typeof item.project !== "string" || !isRecord(item.coordinator)) return [];
    const { id, title } = item.coordinator;
    if (typeof id !== "string" || !id) return [];
    return [{ project: item.project, coordinator: { id, title: text(title) }, ...ask }];
  }).slice(0, MAX_ROWS);
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
    line: typeof value.line === "number" && Number.isSafeInteger(value.line) && value.line > 0 ? value.line : 0,
    state,
    text: value.text.slice(0, MAX_TEXT),
    answer: text(value.answer),
    links: (Array.isArray(value.links) ? value.links : []).flatMap((link): AskLink[] => {
      const kind = isRecord(link) ? LINK_KINDS.find((candidate) => candidate === link.kind) : undefined;
      if (!kind || !isRecord(link)) return [];
      return [{
        kind, text: text(link.text), target: text(link.target), thread: text(link.thread), title: text(link.title),
        state: text(link.state), pr: text(link.pr), prState: text(link.pr_state),
      }];
    }).slice(0, MAX_LINKS),
    // A value from a newer Organizations confirms nothing this Nenu can name.
    confirmed: ASK_CONFIRMED.find((candidate) => candidate === value.confirmed) ?? "",
    mismatch: text(value.mismatch),
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
export function askGroup(ask: Pick<Ask, "state" | "mismatch">, coordinatorResolved: boolean): AskGroup {
  if (ask.state === "needs-decision" && !coordinatorResolved) return "waiting";
  if (ask.mismatch) return "unclosed";
  if (ask.state === "open" || ask.state === "working" || ask.state === "needs-decision") return "progress";
  if (ask.state === "answered" || ask.state === "done") return "done";
  return "other";
}

function text(value: unknown): string {
  return typeof value === "string" ? value.slice(0, MAX_TEXT) : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
