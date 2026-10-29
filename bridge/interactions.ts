import { createHash } from "node:crypto";
import { parseAnsi } from "../web/src/lib/ansi.ts";
import { splitLines, type Block } from "../web/src/lib/blocks.ts";
import { DIALOG_CONTRACT, type DialogKind, type DialogModels } from "../web/src/lib/harness/dialog-contract.ts";
import { detectAskNotes } from "../web/src/lib/harness/codex/ask.ts";
import { autoDenyInMs } from "../web/src/lib/harness/claude/markers.ts";
import { adapterFor } from "../web/src/lib/harness/index.ts";
import { multiSelectIdentity, type MultiSelectModel } from "../web/src/lib/harness/multi-select-model.ts";
import { defaultSleep, POLL_ATTEMPTS, POLL_DELAY_MS, type Sleep } from "../web/src/lib/harness/poll.ts";
import { previewStructureEqual, type PreviewSelectModel } from "../web/src/lib/harness/preview-model.ts";
import { promptsSameIdentity, type PromptModel } from "../web/src/lib/harness/prompt-model.ts";
import { WIZARD_BACK_KEYS, WIZARD_CANCEL_KEYS, WIZARD_NEXT_KEYS, WIZARD_SUBMIT_KEYS } from "../web/src/lib/harness/wizard-model.ts";
import { oneTapAnswers } from "../web/src/lib/one-tap-answers.ts";
import { FEEDBACK_MAX_LENGTH, sanitizeTypedText } from "../web/src/lib/typed-text.ts";
import type { PaneRead } from "./herdr-client.ts";
import { PERSISTENT, permissionSubject, promptSubjectText, questionRow, stripKeyHint, terminalOnly } from "./interaction-subject.ts";
import type {
  AgentView,
  AnswerOutcome,
  AnswerRequest,
  Interaction,
  InteractionHint,
  InteractionKind,
  InteractionAnswer,
  InteractionOption,
  InteractionStep,
  InteractionSubject,
  LivePublisher,
  LiveTopic,
} from "./types.ts";

// One detected dialog per pane, read from the screen with the same adapters the web app renders
// with (ADR 0057). The bridge both detects and answers: an answer re-reads the pane, re-derives the
// dialog, refuses a stale signature and only then types the option's keys, so a phone tap costs one
// request and one local read. Hints (a Claude hook, a pending journal row) only enrich the text; the
// screen alone decides which keys answer, and a hint that disagrees with the screen is dropped.

/** What the bridge needs from a Herdr session: one read and the two writes an answer can make. */
export interface PaneIO {
  readPane(paneId: string, source: "recent", lines: number, format: "ansi"): Promise<PaneRead>;
  sendPaneKeys(paneId: string, keys: string[]): Promise<void>;
  sendPaneText(paneId: string, text: string): Promise<void>;
  /** The session's screen text blinks between reads (herdr-core), so an answer re-reads before refusing. */
  readonly screenBlinks?: boolean;
}

/** How one option is answered, kept bridge-side: the wire only names the option by index. */
type Recipe =
  | { type: "keys"; keys: string[] }
  /** Multi-select: walk the pointer to Submit/Next, then Enter (the closed loop of multi-select-action). */
  | { type: "advance" }
  /** Preview question: the digit only moves the pointer; Enter selects once the pointer is verified. */
  | { type: "preview"; n: number }
  /** Plan feedback: focus the input, type, verify, Enter (PLAN_FEEDBACK_NOTES.md). */
  | { type: "feedback"; key: string }
  /** Row `n`'s keys alone, or with text: walk onto it, Tab, type, verify, Enter (PROBES_2026_10_NOTES.md). */
  | { type: "amend"; n: number; keys: string[] }
  /** Claude multi-select "Type something": walk onto the row, type, verify, step off. Never submits. */
  | { type: "typeSomething"; n: number }
  | { type: "unsupported" };

type Dialog = { [K in DialogKind]: { kind: K; model: DialogModels[K] } }[DialogKind];

type Option = InteractionOption;

interface Choice {
  option: Option;
  recipe: Recipe;
}

/** A choice before it is numbered. */
interface Draft {
  option: Omit<Option, "index">;
  recipe: Recipe;
}

interface Described {
  kind: InteractionKind;
  family: string;
  question: string;
  context?: string;
  steps?: InteractionStep[];
  answers?: InteractionAnswer[];
  subject?: InteractionSubject;
  terminalOnly?: string[];
  incomplete?: true;
  choices: Draft[];
}

interface Detection {
  interaction: Interaction;
  dialog: Dialog;
  choices: Choice[];
}

export type AnswerResult = { status: 200 | 400 | 409 | 422 | 502; outcome: AnswerOutcome; keys?: string[] };

/** Settle time between the multi-select walk's pointer moves (multi-select-action.ts). */
const NAV_SETTLE_MS = 250;
/** Reads an answer may take to find the dialog it was tapped on on a blinking screen, and the wait between them. */
const ANSWER_READS = 4;
const ANSWER_REREAD_MS = 350;
/** A matched dialog regex keeps a pane eligible for detection this long even before Herdr says blocked. */
const OUTPUT_MATCH_WINDOW_MS = 30_000;
/** How long a client's list reuses a pane read; follow() re-reads on every herd or screen change. */
const LIST_FRESH_MS = 2_000;
/** Rows of a prompt's subject kept above its question. */
const CONTEXT_MAX_ROWS = 12;
/** Rows above a prompt's question that must hold still while its amend field opens and fills. */
const HEAD_ROWS = 12;
/** Rows of a plan's on-screen tail a plan hint must contain. */
const PLAN_TAIL_ROWS = 3;

const DENY = /^(no\b|reject|deny|decline|cancel|exit|quit|request changes|chat about this|skip|continue without)/i;
const TYPE_SOMETHING = /^type something\b/i;
/** A select question's escape row; Claude's prompt model carries no flag for it (wizard and multi-select do). */
const QUESTION_ESCAPE = /^chat about this$/i;

/** The keyboard-owning dialog at the tail of `text`, through the pane's own adapter. */
export function dialogOnScreen(agent: string, text: string): Dialog | null {
  const adapter = adapterFor(agent);
  if (!adapter) return null;
  const blocks = adapter.buildBlocks(splitLines(parseAnsi(text)));
  for (let i = blocks.length - 1; i >= 0; i--) {
    const dialog = asDialog(blocks[i]!);
    if (dialog) return dialog;
  }
  return null;
}

function asDialog(block: Block): Dialog | null {
  switch (block.kind) {
    case "prompt-select": return { kind: block.kind, model: block.prompt };
    case "wizard": return { kind: block.kind, model: block.wizard };
    case "preview-select": return { kind: block.kind, model: block.preview };
    case "multi-select": return { kind: block.kind, model: block.multi };
    case "menu": return { kind: block.kind, model: block.menu };
    default: return null;
  }
}

/** Identity of the exact dialog state: any change a keystroke could be re-routed by changes it. */
export function dialogSignature(dialog: Dialog): string {
  return createHash("sha256").update(`${dialog.kind}\0${JSON.stringify(dialog.model)}`).digest("base64url").slice(0, 22);
}

/**
 * A dialog that asks the agent's own question has answers, not settings: "No", "Skip tests" or
 * "Always use tabs" are answers like any other, so only the escape row is deny there.
 */
function role(label: string, answers: boolean, persistent = false): InteractionOption["role"] {
  if (TYPE_SOMETHING.test(label)) return "freeText";
  if (answers) return QUESTION_ESCAPE.test(label) ? "deny" : "neutral";
  if (DENY.test(label)) return "deny";
  return persistent || PERSISTENT.test(label) ? "persistent" : "neutral";
}

const keys = (k: string[]): Recipe => ({ type: "keys", keys: k });
/** The recipes that type the answer's `text`; an option carrying one is served with `acceptsText`. */
const TEXT_RECIPES = new Set<Recipe["type"]>(["feedback", "amend", "typeSomething"]);
/** A "Type something" row is typed into in the terminal; a digit would only focus or tick it. */
const pick = (raw: string, recipe: Recipe, extra: Partial<Option> = {}, answers = false): Draft => {
  const label = stripKeyHint(raw);
  const option = { label, role: role(label, answers), ...extra, ...(extra.description ? { description: stripKeyHint(extra.description) } : {}) };
  return { option, recipe: option.role === "freeText" && !TEXT_RECIPES.has(recipe.type) ? { type: "unsupported" } : recipe };
};

/** Kind, question and the answerable options of a dialog, before hints. */
function describe(dialog: Dialog, agent: string): Described {
  switch (dialog.kind) {
    case "prompt-select": return describePrompt(dialog.model, agent);
    case "wizard": {
      const w = dialog.model;
      if (w.phase === "review") {
        const answers = w.answers.map(({ question, answer }) => ({ question, answer }));
        return { ...review(agent, "wizard", w.incomplete, answers, w.answers.map((a) => `${a.question} → ${a.answer}`).join("\n")), ...stepsOf(w.steps) };
      }
      const served = stepsOf(w.steps, true);
      return {
        kind: "wizard", family: agent, question: w.question, ...served,
        choices: [
          ...w.options.map((o) => pick(o.label, keys(o.keys), { ...(o.description ? { description: o.description } : {}), ...(o.escape ? { role: "deny" } : {}) }, true)),
          ...stepNav(served.steps),
        ],
      };
    }
    case "multi-select": {
      const m = dialog.model;
      if (m.phase === "review") return review(agent, "multi-select", m.incomplete, reviewAnswers(m.regionSignature));
      const textRow = agent === "claude" ? emptyTypeSomethingRow(m) : null;
      // No Back here: Left is measured on a wizard's questions and its review (WIZARD_NOTES), never on
      // a checkbox step, and its own advance row is the step forward.
      return {
        kind: "multi-select", family: agent, question: m.question, ...stepsOf(m.steps, true),
        choices: [
          ...m.options.map((o) => pick(o.label, keys([String(o.n)]), { checked: o.checked, ...(o.description ? { description: o.description } : {}) }, true)),
          ...(textRow !== null ? [pick("Type something", { type: "typeSomething", n: textRow }, {}, true)] : []),
          pick(m.advanceLabel, { type: "advance" }, { role: "primary" }),
          ...(m.escape ? [pick(m.escape.label, keys([String(m.escape.n)]), { role: "deny" })] : []),
        ],
      };
    }
    case "preview-select":
      return { kind: "question", family: agent, question: dialog.model.question, ...stepsOf(dialog.model.steps, true), choices: dialog.model.options.map((o) => pick(o.label, { type: "preview", n: o.n }, {}, true)) };
    case "menu":
      return {
        kind: "menu", family: agent, question: dialog.model.title,
        choices: dialog.model.actions.map((a) => pick(a.label, keys(a.keys), a.cancel ? { role: "deny" } : {})),
      };
  }
}

function review(agent: string, kind: "wizard" | "multi-select", incomplete: boolean, answers: InteractionAnswer[], context?: string): Described {
  return {
    kind, family: agent, question: "Review your answers", ...(context ? { context } : {}),
    ...(answers.length ? { answers } : {}), ...(incomplete ? { incomplete: true as const } : {}),
    choices: [
      pick("Submit answers", keys(WIZARD_SUBMIT_KEYS), { role: "primary" }),
      pick("Cancel", keys(WIZARD_CANCEL_KEYS), { role: "deny" }),
      // A wizard's review sits after its last question; a lone multi-select's review has no Back measured.
      ...(kind === "wizard" ? [pick("Back", keys(WIZARD_BACK_KEYS), { role: "nav" })] : []),
    ],
  };
}

/**
 * Back and Next across a wizard's questions: the Left/Right its footer advertises (ADR 0009), only
 * where they lead somewhere. Left clamps on the first question, so there is no Back there.
 */
function stepNav(steps: InteractionStep[] | undefined): Draft[] {
  if (!steps || steps.length < 2) return [];
  const at = steps.findIndex((s) => s.current);
  return [
    ...(at > 0 ? [pick("Back", keys(WIZARD_BACK_KEYS), { role: "nav" })] : []),
    pick("Next", keys(WIZARD_NEXT_KEYS), { role: "nav" }),
  ];
}

/** A multi-select review's echo: `● <question>` over `→ <answer>`, wrapped rows joined. */
function reviewAnswers(region: string): InteractionAnswer[] {
  const answers: InteractionAnswer[] = [];
  let open: InteractionAnswer | null = null;
  for (const row of region.split("\n").map((r) => r.trim())) {
    if (row.startsWith("●")) open = { question: row.replace(/^●\s*/, ""), answer: "" };
    else if (open && row.startsWith("→")) {
      open.answer = row.replace(/^→\s*/, "");
      answers.push(open);
    } else if (open && row && !/^ready to submit/i.test(row) && !/^(?:❯\s*)?\d+\./.test(row)) {
      if (open.answer) open.answer += ` ${row}`;
      else open.question += ` ${row}`;
    }
  }
  return answers;
}

function describePrompt(p: PromptModel, agent: string): Described {
  const kind: InteractionKind = p.family === "plan" ? "plan" : p.family === "select" ? "question" : "permission";
  const choices = p.options.map((o) => {
    const recipe: Recipe = o.amend && AMEND_FIELD[agent] ? { type: "amend", n: Number(o.keys[0]), keys: o.keys } : keys(o.keys);
    const choice = pick(o.label, recipe, { role: role(stripKeyHint(o.label), kind === "question", p.family === "trust") });
    if (o.description) choice.option.description = stripKeyHint(o.description);
    // Claude 2.1.296: a bare "No" rejects AND ends the turn; only Tab-amend keeps it going (PROBES_2026_10).
    else if (agent === "claude" && p.family === "permission" && o.label === "No") choice.option.description = "Stops Claude's turn";
    return choice;
  });
  // The first plain yes is the one-tap answer; a persistent yes always asks to confirm.
  if (kind !== "question") {
    const first = choices.find((c) => c.option.role === "neutral");
    if (first) first.option.role = "primary";
  }
  if (p.feedback && (p.feedback.purpose ?? "plan-change") === "plan-change") {
    choices.push(pick("Tell Claude what to change", { type: "feedback", key: p.feedback.key }, { role: "freeText" }));
  }
  // AskUserQuestion's single-choice "Type something." has no measured recipe: shown, answered in the terminal.
  if (p.textRow) choices.push(pick(p.textRow.label, { type: "unsupported" }, { role: "freeText" }));
  if (kind === "permission") {
    // The rows as plain text stay the context (a push body reads it); the card reads the parts.
    const context = promptSubjectText(p).join("\n");
    const subject = permissionSubject(agent, p);
    const terminal = terminalOnly(p);
    return {
      kind, family: p.family, question: p.question, choices,
      ...(context ? { context } : {}), ...(subject ? { subject } : {}), ...(terminal.length ? { terminalOnly: terminal } : {}),
    };
  }
  const { context, steps } = promptContext(p);
  return { kind, family: p.family, question: p.question, ...(context ? { context } : {}), ...stepsOf(steps), choices };
}

/**
 * The chips as served. On a question step one of them is on screen; a read without colours loses
 * the highlight, so `asking` falls back to the first unanswered one. A review marks none.
 */
function stepsOf(steps: readonly InteractionStep[] | null | undefined, asking = false): { steps?: InteractionStep[] } {
  if (!steps?.length) return {};
  const served = steps.map(({ label, answered, current }) => ({ label, answered, current }));
  const fallback = served.find((s) => !s.answered);
  if (asking && fallback && !served.some((s) => s.current)) fallback.current = true;
  return { steps: served };
}

/** Header chips as Claude draws them above a question: `☐ Fruit`, `☒` once answered. */
const CHIP = /([☐☒☑])\s+([^☐☒☑✔←→]+)/g;

/** The chips of a header row, or null for any other row. A lone chip is the question on screen. */
function headerChips(row: string): InteractionStep[] | null {
  if (!/^(?:←\s*)?[☐☒☑]\s/.test(row)) return null;
  const chips = [...row.matchAll(CHIP)].map(([, glyph, label]) => ({ label: label!.trim(), answered: glyph !== "☐", current: false }));
  if (chips.length === 1) chips[0]!.current = true;
  return chips.length ? chips : null;
}

/**
 * Codex's `Question 2/3 (1 unanswered)` as steps; it names no question, so each is "Question n". It
 * counts the unanswered ones without saying which, so a question is marked answered only once none is left.
 */
function codexProgress(row: string): InteractionStep[] | null {
  const m = /^Question (\d+)\/(\d+) \((\d+) unanswered\)$/.exec(row);
  if (!m) return null;
  const [at, of, open] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return Array.from({ length: of }, (_, k) => ({ label: `Question ${k + 1}`, answered: open === 0, current: k + 1 === at }));
}

/**
 * The detail of a question or plan from its literal region: the rows under the dialog's top rule and
 * above the question, plus the rows between the question and the first option. Bounded, so a long plan
 * shows its tail here and its whole text via a hint. A permission's subject is read in parts instead
 * (interaction-subject.ts).
 */
function promptContext(p: PromptModel): { context?: string; steps?: InteractionStep[] } {
  const lines = p.signature.split("\n");
  const q = questionRow(lines, p.question);
  if (q < 0) return {};
  const first = p.options[0] ? lines.findIndex((l, i) => i > q && l.includes(p.options[0]!.label)) : -1;
  let top = q;
  while (top > 0 && q - top < CONTEXT_MAX_ROWS && !/^\s*[─━▔═]{8,}\s*$/.test(lines[top - 1]!)) top--;
  const rows = [...lines.slice(top, q), ...(first > q ? lines.slice(q + 1, first) : [])]
    .map((l) => l.replace(/^[\s│┃]+|[\s│┃]+$/g, ""))
    .filter((l) => l && !/^[─━▔═╌]+$/.test(l));
  // A select question's header chip (or Codex's "Question 1/2") names it, and a repeat of the
  // question is not the subject. One Codex question is no progress to show.
  let steps: InteractionStep[] | undefined;
  const subject = rows.filter((l) => {
    const chips = p.family === "select" ? headerChips(l) : null;
    const progress = p.family === "select" && !chips ? codexProgress(l) : null;
    if (chips) steps = chips;
    else if (progress && progress.length > 1) steps = progress;
    return !chips && !progress && compact(l) !== compact(p.question);
  });
  return { ...(subject.length ? { context: subject.join("\n") } : {}), ...(steps ? { steps } : {}) };
}

/**
 * The last rows of a plan's body as the dialog's own region shows them, above the question and its
 * rule. A plan hint must contain them; a screen that shows none verifies nothing.
 */
function planTail(p: PromptModel): string {
  const lines = p.signature.split("\n");
  const q = questionRow(lines, p.question);
  const rows = lines.slice(0, Math.max(q, 0)).map((l) => l.trim()).filter((l) => l && !/^[─━▔═╌]+$/.test(l));
  return rows.slice(-PLAN_TAIL_ROWS).join("\n");
}

const compact = (s: string) => s.replace(/\s+/g, "").replace(/…$/, "");
/** The screen renders a plan's markdown, so its markers are not compared. */
const compactPlan = (s: string) => compact(s).replace(/[#*_`>~]/g, "");

/** True when `detail` is exactly a run of whole rows of the dialog's subject (a wrapped command joins up). */
function isWholeRows(detail: string, context: string | undefined): boolean {
  const want = compact(detail);
  const rows = (context ?? "").split("\n").map(compact);
  for (let i = 0; i < rows.length; i++) {
    let run = "";
    for (let j = i; j < rows.length && run.length <= want.length; j++) {
      run += rows[j];
      if (run === want || run === `$${want}`) return true;
    }
  }
  return false;
}

/**
 * A hint agrees when what it says is what the dialog itself shows (never just somewhere in the
 * scrollback above it); otherwise the screen wins and it is dropped.
 */
function agrees(hint: InteractionHint, base: Described, dialog: Dialog, labels: string[]): boolean {
  if (base.kind === "permission") return !!hint.detail && isWholeRows(hint.detail, base.context);
  if (base.kind === "plan") {
    const tail = dialog.kind === "prompt-select" ? compactPlan(planTail(dialog.model)) : "";
    return !hint.question && !!hint.detail && tail.length > 0 && compactPlan(hint.detail).includes(tail);
  }
  const { question } = base;
  if (hint.question && !compact(hint.question).startsWith(compact(question)) && !compact(question).startsWith(compact(hint.question))) return false;
  return (hint.options ?? []).every((o) => labels.some((l) => compact(o).startsWith(compact(l)) && compact(l).length > 0));
}

/** The dialog's own input has focus: every key sent now would land in it as text (issue #95). */
function typing(dialog: Dialog): boolean {
  if (dialog.kind === "prompt-select") return dialog.model.feedback?.focused ?? false;
  if (dialog.kind === "preview-select") return dialog.model.note.state === "editing";
  // Claude's grammar reports the empty "Type something" row as `other`; with the pointer there, keys type into it.
  if (dialog.kind === "multi-select") return dialog.model.phase === "checkbox" && dialog.model.pointer === "other";
  return false;
}

/** Build the served interaction for `dialog`: screen first, hints only where they agree. */
export function toInteraction(pane: Pick<AgentView, "paneId" | "agent">, dialog: Dialog, revision: number, hints: InteractionHint[], now: number): Detection {
  const base = describe(dialog, pane.agent);
  const choices: Choice[] = base.choices.map((c, index) => ({
    option: { index, ...c.option, ...(TEXT_RECIPES.has(c.recipe.type) ? { acceptsText: true as const } : {}) },
    recipe: c.recipe,
  }));
  const labels = choices.map((c) => c.option.label);
  const kept = hints.filter((h) => agrees(h, base, dialog, labels));
  const asked = kept.find((h) => h.question && base.kind !== "permission");
  const detail = kept.find((h) => h.detail)?.detail;
  // A permission hint only agrees when its command is whole rows of the screen's subject, so that
  // subject (tool header, command, description) already shows it in full. A plan hint is longer.
  const context = base.kind === "permission" ? base.context : (detail ?? base.context);
  // An agreeing hint says which rows are the command, and its text is exact where the screen's had to
  // be unwrapped. It completes the card only when it is the command or file the card shows: a hint
  // that matches the description's row instead completes nothing.
  const subject = base.kind === "permission" && detail !== undefined && dialog.kind === "prompt-select"
    ? permissionSubject(pane.agent, dialog.model, detail) : base.subject;
  const shown = subject?.command ?? subject?.file;
  const whole = detail !== undefined && (shown === undefined || compact(shown) === compact(detail));
  const interaction: Interaction = {
    paneId: pane.paneId,
    agent: pane.agent,
    kind: base.kind,
    family: base.family,
    question: asked?.question && asked.question.length > base.question.length ? asked.question : base.question,
    ...(context ? { context } : {}),
    ...(base.steps ? { steps: base.steps } : {}),
    ...(base.answers ? { answers: base.answers } : {}),
    ...(base.incomplete ? { incomplete: true as const } : {}),
    ...(subject ? { subject } : {}),
    ...(base.terminalOnly ? { terminalOnly: base.terminalOnly } : {}),
    options: choices.map((c) => c.option),
    signature: dialogSignature(dialog),
    revision,
    ...(kept.length ? { hints: kept } : {}),
    detectedAt: now,
    detailComplete: base.kind === "permission" ? whole : base.kind === "plan" && detail !== undefined,
    ...(typing(dialog) ? { typing: true as const } : {}),
  };
  return { interaction, dialog, choices };
}

/** A notification's actions: the answers a dialog may take in one tap (`oneTapAnswers`, shared with Home). */
export function pushActions(i: Interaction): Array<{ optionIndex: number; title: string }> {
  return oneTapAnswers(i).map((o) => ({ optionIndex: o.index, title: o.label }));
}

const paneKey = (session: string, paneId: string) => `${session}\u0000${paneId}`;

interface Entry {
  /** Screen text plus hints the detection was built from; the same input is never re-parsed. */
  input: string;
  detection: Detection | null;
  readAt: number;
}

export type HintSource = (session: string, pane: AgentView) => Promise<InteractionHint[]>;

/** The slice of a session runtime {@link Interactions.follow} reads. */
export interface FollowedSession {
  name: string;
  herdr: PaneIO;
  engine: { current(): { agents: AgentView[] } };
  poker?: { onOutputMatched(cb: (event: { paneId: string }) => void): () => void };
}

interface Options {
  /** The CLI's own state says a dialog owns the pane (ADR 0067): read it even before Herdr says blocked. */
  waiting?: (session: string, paneId: string) => boolean;
  lines?: number;
  now?: () => number;
  sleep?: Sleep;
}

/**
 * The exact string to type, or the 400 to answer. Over-long text is refused rather than cut: a cut can
 * end in a space that no trimmed read-back ever matches, and a silent cut submits words nobody chose.
 */
function typedText(raw: string): string | AnswerResult {
  const text = sanitizeTypedText(raw, Infinity);
  if (!text) return { status: 400, outcome: { ok: false, error: "Nothing to send" } };
  if (text.length > FEEDBACK_MAX_LENGTH) return { status: 400, outcome: { ok: false, error: `Keep it under ${FEEDBACK_MAX_LENGTH + 1} characters.` } };
  return text;
}

export class Interactions {
  private readonly panes = new Map<string, Entry>();
  private readonly matched = new Map<string, number>();
  private readonly listing = new Map<string, Promise<Interaction[]>>();
  private readonly lines: number;
  private readonly now: () => number;
  private readonly sleep: Sleep;
  private readonly waiting: (session: string, paneId: string) => boolean;

  constructor(readonly live: LivePublisher, opts: Options = {}) {
    this.waiting = opts.waiting ?? (() => false);
    this.lines = opts.lines ?? 200;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** The pane's last detected interaction, without reading anything. */
  current(session: string, paneId: string): Interaction | null {
    return this.panes.get(paneKey(session, paneId))?.detection?.interaction ?? null;
  }

  /** A `pane.output_matched` for a dialog regex: the pane is worth reading even before it is blocked. */
  noteOutputMatched(session: string, paneId: string): void {
    this.matched.set(paneKey(session, paneId), this.now());
  }

  /**
   * The cards a client asks for. A pane read in the last LIST_FRESH_MS is not read again, and callers
   * that arrive while a list is running share it, so more open phones do not mean more pane reads.
   */
  list(session: string, io: PaneIO, agents: readonly AgentView[], hints?: HintSource): Promise<Interaction[]> {
    const running = this.listing.get(session);
    if (running) return running;
    const run = this.refresh(session, io, agents, hints, undefined, LIST_FRESH_MS).finally(() => this.listing.delete(session));
    this.listing.set(session, run);
    return run;
  }

  /**
   * Re-detect the session's eligible panes (blocked, unknown, or a dialog regex matched lately) and
   * forget the rest. Unknown is read because a dialog Herdr's manifest does not name (Codex's hooks
   * review) leaves the pane there, and only the screen can tell. A pane is read every time (one local
   * read, no revision to skip on: pane.read's is 0) but only parsed when its text or hints changed.
   * Publishes `interaction` for every pane whose card changed.
   */
  async refresh(session: string, io: PaneIO, agents: readonly AgentView[], hints?: HintSource, only?: string, maxAgeMs = 0): Promise<Interaction[]> {
    const now = this.now();
    const eligible = agents.filter((a) => {
      const matchedAt = this.matched.get(paneKey(session, a.paneId));
      return a.status === "blocked" || a.status === "unknown" || this.waiting(session, a.paneId) || (matchedAt !== undefined && now - matchedAt <= OUTPUT_MATCH_WINDOW_MS);
    });
    const live = new Set(eligible.map((a) => a.paneId));
    if (only === undefined) {
      for (const key of [...this.panes.keys()]) {
        const [s, paneId] = key.split("\u0000") as [string, string];
        if (s === session && !live.has(paneId)) this.forget(session, paneId);
      }
    }
    const stale = (paneId: string) => now - (this.panes.get(paneKey(session, paneId))?.readAt ?? -Infinity) >= maxAgeMs;
    await Promise.all(eligible.filter((a) => (only === undefined || a.paneId === only) && stale(a.paneId)).map(async (pane) => {
      try {
        const read = await io.readPane(pane.paneId, "recent", this.lines, "ansi");
        this.store(session, pane, read, hints ? await hints(session, pane) : []);
      } catch {
        // An unreadable pane keeps its last card; the next refresh tries again.
      }
    }));
    return eligible.map((a) => this.current(session, a.paneId)).filter((i): i is Interaction => i !== null);
  }

  /**
   * Keep cards current without a client asking: a herd change re-detects its session, a screen change
   * or a dialog-regex match re-detects its pane. Wired once at startup; returns the unsubscribe.
   */
  follow<R extends FollowedSession>(
    registry: { get(name?: string): R | undefined },
    events: { subscribe(listener: (event: { session: string; topic: string; paneId?: string }) => void): () => void },
    hints: (rt: R) => HintSource,
  ): () => void {
    // The runtime a session name was last seen with: the registry replaces a runtime (and its poker)
    // under the same name, and the old one's cards and match subscription go with it.
    const seen = new Map<string, { rt: R; unsubscribe: () => void }>();
    const detect = (rt: R, only?: string) =>
      void this.refresh(rt.name, rt.herdr, rt.engine.current().agents, hints(rt), only).catch(() => {});
    const unsubscribe = events.subscribe(({ session, topic, paneId }) => {
      const rt = registry.get(session);
      if (!rt) return;
      const known = seen.get(session);
      if (known?.rt !== rt) {
        // Recorded first: forgetting publishes, which re-enters this listener.
        seen.set(session, {
          rt,
          unsubscribe: rt.poker?.onOutputMatched((e) => {
            this.noteOutputMatched(session, e.paneId);
            detect(rt, e.paneId);
          }) ?? (() => {}),
        });
        if (known) {
          known.unsubscribe();
          this.forgetSession(session);
        }
      }
      if (topic === "snapshot") detect(rt);
      else if (topic === "pane" && paneId !== undefined) detect(rt, paneId);
    });
    return () => {
      unsubscribe();
      for (const { unsubscribe: off } of seen.values()) off();
      seen.clear();
    };
  }

  private forgetSession(session: string): void {
    for (const key of new Set([...this.panes.keys(), ...this.matched.keys()])) {
      const [s, paneId] = key.split("\u0000") as [string, string];
      if (s === session) this.forget(session, paneId);
    }
  }

  /** Drop a pane's card (it stopped being blocked, closed, or was just answered). */
  forget(session: string, paneId: string): void {
    const key = paneKey(session, paneId);
    const had = this.panes.get(key)?.detection;
    this.panes.delete(key);
    this.matched.delete(key);
    if (had) this.publish(session, paneId, "interaction");
  }

  private store(session: string, pane: AgentView, read: PaneRead, hints: InteractionHint[]): Detection | null {
    const key = paneKey(session, pane.paneId);
    const input = `${pane.agent}\0${read.text}\0${JSON.stringify(hints)}`;
    const previous = this.panes.get(key);
    const readAt = this.now();
    if (previous?.input === input) {
      previous.readAt = readAt;
      return previous.detection;
    }
    const dialog = dialogOnScreen(pane.agent, read.text);
    const detection = dialog ? toInteraction(pane, dialog, read.revision, hints, readAt) : null;
    const before = previous?.detection?.interaction;
    const after = detection?.interaction;
    if (after?.kind === "permission" && pane.agent === "claude") {
      // Kept from the dialog's first read: the countdown only says whole seconds, so each later read
      // would move the deadline by up to one.
      const left = autoDenyInMs(read.text);
      const kept = before?.signature === after.signature ? before.autoDenyAt : undefined;
      if (left !== null) after.autoDenyAt = kept ?? readAt + left;
    }
    this.panes.set(key, { input, detection, readAt });
    if (before?.signature !== after?.signature || JSON.stringify(before?.hints) !== JSON.stringify(after?.hints)) {
      this.publish(session, pane.paneId, "interaction");
    }
    return detection;
  }

  private publish(session: string, paneId: string, topic: LiveTopic): void {
    this.live.publish({ session, topic, paneId });
  }

  /**
   * Answer the pane's dialog. One fresh read re-derives the dialog; a signature other than the one on
   * screen is refused (409) before any key goes out, and a persistent option needs `confirm`. The
   * caller holds the pane's write lock and has already passed the write gate.
   */
  async answer(session: string, io: PaneIO, pane: AgentView, body: AnswerRequest): Promise<AnswerResult> {
    const hints = this.panes.get(paneKey(session, pane.paneId))?.detection?.interaction.hints ?? [];
    let detection: Detection | null = null;
    // A screen that blinks (Claude's pending-tool bullet comes and goes about every half second,
    // measured on herdr-core) can read as another dialog for a moment. A few re-reads inside one blink
    // period find the dialog the operator saw again; one that really changed never matches.
    const reads = io.screenBlinks ? ANSWER_READS : 1;
    for (let attempt = 0; attempt < reads; attempt++) {
      if (attempt > 0) await this.sleep(ANSWER_REREAD_MS);
      let read: PaneRead;
      try {
        read = await io.readPane(pane.paneId, "recent", this.lines, "ansi");
      } catch (err) {
        return { status: 502, outcome: { ok: false, error: `herdr read failed: ${(err as Error).message}` } };
      }
      detection = this.store(session, pane, read, hints);
      if (!detection || detection.interaction.signature === body.signature) break;
    }
    if (!detection || detection.interaction.signature !== body.signature) return changed("The question changed in the terminal. Nothing was sent.");
    const choice = detection.choices[body.optionIndex];
    if (!choice) return { status: 400, outcome: { ok: false, error: "unknown option" } };
    if (choice.option.role === "persistent" && body.confirm !== true) {
      return { status: 409, outcome: { ok: false, error: "This option changes a setting beyond this answer. Confirm it.", code: "confirm_required" } };
    }
    if (body.text !== undefined && !choice.option.acceptsText) {
      return { status: 400, outcome: { ok: false, error: "This option takes no text." } };
    }
    const { dialog } = detection;
    if (detection.interaction.typing) return changed(TEXT_BOX_IN_USE);
    let result: AnswerResult;
    try {
      result = await this.run(io, pane, dialog, choice.recipe, body.text);
    } catch (err) {
      result = { status: 502, outcome: { ok: false, error: (err as Error).message } };
    }
    if (result.outcome.ok) this.forget(session, pane.paneId);
    return result;
  }

  private async run(io: PaneIO, pane: AgentView, dialog: Dialog, recipe: Recipe, text: string | undefined): Promise<AnswerResult> {
    switch (recipe.type) {
      case "keys":
        await io.sendPaneKeys(pane.paneId, recipe.keys);
        return sent(recipe.keys);
      case "advance":
        return dialog.kind === "multi-select" ? this.advance(io, pane, dialog.model) : unsupported();
      case "preview":
        return dialog.kind === "preview-select" ? this.preview(io, pane, dialog.model, recipe.n) : unsupported();
      case "feedback":
        return dialog.kind === "prompt-select" ? this.feedback(io, pane, dialog.model, recipe.key, text ?? "") : unsupported();
      case "amend":
        if (text === undefined) {
          await io.sendPaneKeys(pane.paneId, recipe.keys);
          return sent(recipe.keys);
        }
        return dialog.kind === "prompt-select" && AMEND_FIELD[pane.agent] ? this.amend(io, pane, dialog.model, recipe.n, text, AMEND_FIELD[pane.agent]!) : unsupported();
      case "typeSomething":
        return dialog.kind === "multi-select" ? this.typeSomething(io, pane, dialog.model, recipe.n, text ?? "") : unsupported();
      case "unsupported":
        return unsupported();
    }
  }

  /** Read once and re-derive `kind` from the fresh screen (null when it is not on screen). */
  private async model<K extends DialogKind>(io: PaneIO, pane: AgentView, kind: K): Promise<DialogModels[K] | null> {
    const read = await io.readPane(pane.paneId, "recent", this.lines, "ansi");
    const dialog = dialogOnScreen(pane.agent, read.text);
    return dialog?.kind === kind ? (dialog.model as DialogModels[K]) : null;
  }

  /** Until `accept` on the dialog `tapped` showed; false once another dialog replaced it or time ran out. */
  private async settles<K extends DialogKind>(io: PaneIO, pane: AgentView, kind: K, tapped: DialogModels[K], accept: (m: DialogModels[K]) => boolean): Promise<boolean> {
    const identity = DIALOG_CONTRACT[kind].identity as (a: DialogModels[K], b: DialogModels[K]) => boolean;
    return (await this.waitFor(io, pane, kind, (m) => identity(m, tapped), accept)) !== null;
  }

  /** Multi-select Submit/Next: move the pointer onto the advance row one verified step at a time, then Enter. */
  private async advance(io: PaneIO, pane: AgentView, tapped: MultiSelectModel): Promise<AnswerResult> {
    if (tapped.phase !== "checkbox") return changed();
    const sentKeys: string[] = [];
    let m: MultiSelectModel | null = tapped;
    for (let step = 0; step < tapped.options.length + 6; step++) {
      if (step > 0) {
        await this.sleep(NAV_SETTLE_MS);
        m = await this.model(io, pane, "multi-select").catch(() => null);
        if (!m) continue;
      }
      if (!multiSelectIdentity(m!, tapped) || m!.phase !== "checkbox") return changed();
      const key = m!.pointer === "advance" ? "Enter" : m!.pointer === "chat" ? "Up" : "Down";
      await io.sendPaneKeys(pane.paneId, [key]);
      sentKeys.push(key);
      if (key === "Enter") return sent(sentKeys);
    }
    return { status: 409, outcome: { ok: false, error: `Couldn't reach ${tapped.advanceLabel} in the terminal. Nothing was submitted.`, code: "not_reached" } };
  }

  /** Preview question: the digit moves the pointer; Enter only once the pointer is verified there. */
  private async preview(io: PaneIO, pane: AgentView, tapped: PreviewSelectModel, n: number): Promise<AnswerResult> {
    await io.sendPaneKeys(pane.paneId, [String(n)]);
    if (!(await this.settles(io, pane, "preview-select", tapped, (m) => previewStructureEqual(m, tapped) && (m.options.find((o) => o.n === n)?.pointed ?? false)))) return changed();
    await io.sendPaneKeys(pane.paneId, ["Enter"]);
    return sent([String(n), "Enter"]);
  }

  /**
   * Deny a plan with feedback: focus the empty input, type, verify our exact words are in it, Enter.
   * Refused unless the box is empty and unfocused: re-entering a filled box prepends at position 0.
   */
  private async feedback(io: PaneIO, pane: AgentView, tapped: PromptModel, key: string, raw: string): Promise<AnswerResult> {
    const row = tapped.feedback;
    if (!row || row.focused || row.text !== "") return changed(TEXT_BOX_IN_USE);
    const text = typedText(raw);
    if (typeof text !== "string") return text;
    await io.sendPaneKeys(pane.paneId, [key]);
    const focused = (m: PromptModel) => promptsSameIdentity(m, tapped) && (m.feedback?.focused ?? false) && m.feedback?.text === "";
    if (!(await this.settles(io, pane, "prompt-select", tapped, focused))) return failed("The feedback box didn't open. Check the pane.");
    await io.sendPaneText(pane.paneId, text);
    const landed = (m: PromptModel) => promptsSameIdentity(m, tapped) && (m.feedback?.focused ?? false) && m.feedback?.text === text;
    if (!(await this.settles(io, pane, "prompt-select", tapped, landed))) return failed("The feedback didn't arrive. Nothing was submitted.");
    // The Enter is the irreversible write: one more read right before it.
    const fresh = await this.model(io, pane, "prompt-select");
    if (!fresh || !landed(fresh)) return changed();
    await io.sendPaneKeys(pane.paneId, ["Enter"]);
    return sent([key, "Enter"]);
  }

  /** Read `kind` until `accept`, giving up after the shared poll budget or when another dialog shows. */
  private waitFor<K extends DialogKind>(io: PaneIO, pane: AgentView, kind: K, same: (m: DialogModels[K]) => boolean, accept: (m: DialogModels[K]) => boolean): Promise<DialogModels[K] | null> {
    return this.until(() => this.model(io, pane, kind), accept, same);
  }

  /** The shared bounded poll: a null or failed read is retried, a read that is not `same` stops it. */
  private async until<T>(read: () => Promise<T | null>, accept: (v: T) => boolean, same: (v: T) => boolean = () => true): Promise<T | null> {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      await this.sleep(POLL_DELAY_MS);
      const v = await read().catch(() => null);
      if (v === null) continue;
      if (accept(v)) return v;
      if (!same(v)) return null;
    }
    return null;
  }

  /**
   * Answer row `n` with text through its Tab field (Claude's "Tab to amend", Codex's notes;
   * PROBES_2026_10_NOTES.md): walk the pointer onto the row one verified Up/Down at a time, Tab, wait
   * for the empty field, type, read our exact words back, and Enter on a fresh read. No Enter goes out
   * unless the field shows our text.
   */
  private async amend(io: PaneIO, pane: AgentView, tapped: PromptModel, n: number, raw: string, field: AmendField): Promise<AnswerResult> {
    const text = typedText(raw);
    if (typeof text !== "string") return text;
    if (tapped.feedback || tapped.pointer === undefined) return changed();
    const sentKeys: string[] = [];
    let at = tapped.pointer;
    for (let step = 0; at !== n; step++) {
      if (step > tapped.options.length) return changed();
      const key = at < n ? "Down" : "Up";
      const want = at < n ? at + 1 : at - 1;
      await io.sendPaneKeys(pane.paneId, [key]);
      sentKeys.push(key);
      // Not promptsSameIdentity: Claude's footer drops `Tab to amend` on the rows that cannot amend.
      const same = (m: PromptModel) => sameAmendDialog(m, tapped) && !m.feedback && sameOptionRows(m, tapped);
      const moved = await this.waitFor(io, pane, "prompt-select", same, (m) => same(m) && m.pointer === want);
      if (!moved) return changed();
      at = want;
    }
    await io.sendPaneKeys(pane.paneId, ["Tab"]);
    sentKeys.push("Tab");
    if (!(await this.fieldHolds(io, pane, field, tapped, n, ""))) return failed("The text field didn't open. Check the pane.");
    await io.sendPaneText(pane.paneId, text);
    if (!(await this.fieldHolds(io, pane, field, tapped, n, text))) return failed("Your text didn't arrive. Nothing was submitted.");
    // The Enter is the irreversible write: one more read right before it.
    const fresh = await io.readPane(pane.paneId, "recent", this.lines, "ansi");
    if (field(fresh.text, tapped, n) !== text) return changed();
    await io.sendPaneKeys(pane.paneId, ["Enter"]);
    return sent([...sentKeys, "Enter"]);
  }

  /** Whether the open field on row `n` comes to hold `want` within the poll budget. */
  private async fieldHolds(io: PaneIO, pane: AgentView, field: AmendField, tapped: PromptModel, n: number, want: string): Promise<boolean> {
    const read = async () => field((await io.readPane(pane.paneId, "recent", this.lines, "ansi")).text, tapped, n);
    return (await this.until(read, (v) => v === want)) !== null;
  }

  /**
   * Fill AskUserQuestion's empty "Type something" row (PROBES_2026_10_NOTES.md, 2.1.296): walk `❯`
   * onto it one verified step at a time, type (Claude ticks the row and shows the text as its label),
   * verify, then `Up` off it. Off, because the field keeps the keyboard while `❯` is on it; Up, because
   * a digit is ignored with `❯` on Submit (measured 2026-10-10) and works on an option row. It submits
   * nothing: Submit stays the operator's tap.
   */
  private async typeSomething(io: PaneIO, pane: AgentView, tapped: MultiSelectModel, n: number, raw: string): Promise<AnswerResult> {
    const text = typedText(raw);
    if (typeof text !== "string") return text;
    if (tapped.phase !== "checkbox" || emptyTypeSomethingRow(tapped) !== n) return changed();
    const same = (m: MultiSelectModel) => sameQuestionRows(m, tapped, n - 1);
    const sentKeys: string[] = [];
    const step = async (key: string, accept: (m: MultiSelectModel) => boolean) => {
      await io.sendPaneKeys(pane.paneId, [key]);
      sentKeys.push(key);
      return this.waitFor(io, pane, "multi-select", same, accept);
    };
    let at = pointedRow(tapped);
    for (let moves = 0; at !== n; moves++) {
      if (moves > n + 2) return changed();
      const next = at === undefined ? "Up" : at < n ? "Down" : "Up";
      const from = at;
      const moved = await step(next, (m) => emptyTypeSomethingRow(m) === n && pointedRow(m) !== from);
      if (!moved) return changed();
      at = pointedRow(moved);
    }
    await io.sendPaneText(pane.paneId, text);
    const filled = (m: MultiSelectModel) => m.phase === "checkbox" && m.options.length === n &&
      m.options[n - 1]!.label === text && m.options[n - 1]!.checked;
    if (!(await this.waitFor(io, pane, "multi-select", same, filled))) return failed("Your text didn't arrive. Nothing was submitted.");
    if (!(await step("Up", (m) => filled(m) && pointedRow(m) === n - 1))) {
      return failed("Your text is in, but the cursor is still in it. Check the pane before tapping a row.");
    }
    return sent(sentKeys);
  }
}

/**
 * The number of AskUserQuestion's "Type something" row while it is EMPTY. Claude's multi-select grammar
 * drops that row, so it shows as the one number missing between the last option and "Chat about this";
 * once typed into, the row reads as an ordinary option and nothing is missing. Single questions only:
 * the wizard's version was not measured.
 */
function emptyTypeSomethingRow(m: MultiSelectModel): number | null {
  if (m.phase !== "checkbox" || m.steps !== null || !m.escape) return null;
  if (!m.options.every((o, i) => o.n === i + 1)) return null;
  return m.escape.n === m.options.length + 2 ? m.options.length + 1 : null;
}

/** What the open Tab field on row `n` of `tapped` holds on this screen, or null when there is none. */
type AmendField = (screen: string, tapped: PromptModel, n: number) => string | null;

const AMEND_FIELD: Record<string, AmendField | undefined> = {
  claude: (screen, tapped, n) => {
    const d = dialogOnScreen("claude", screen);
    const m = d?.kind === "prompt-select" ? d.model : null;
    return m && sameAmendDialog(m, tapped) && m.feedback?.row === n && m.feedback.focused ? m.feedback.text : null;
  },
  codex: (screen, tapped, n) => {
    const notes = detectAskNotes(splitLines(parseAnsi(screen)));
    return notes && notes.question === tapped.question && notes.row === n ? notes.text : null;
  },
};

/** The rows straight above a prompt's question, which move with it when a growing field re-flows the screen. */
function promptHead(p: PromptModel): string {
  const lines = p.signature.split("\n");
  const q = questionRow(lines, p.question);
  return q < 0 ? "" : lines.slice(Math.max(0, q - HEAD_ROWS), q + 1).join("\n");
}

/** Same permission prompt across its amend field opening: the field changes rows, footer and options. */
function sameAmendDialog(a: PromptModel, b: PromptModel): boolean {
  return a.family === b.family && a.question === b.question && promptHead(a) !== "" && promptHead(a) === promptHead(b);
}

const sameOptionRows = (a: PromptModel, b: PromptModel) =>
  a.options.length === b.options.length && a.options.every((o, i) => o.label === b.options[i]!.label && o.keys.join() === b.options[i]!.keys.join());

/** The numbered row under `❯` in a checkbox question's literal region; undefined on Submit/Next. */
function pointedRow(m: MultiSelectModel): number | undefined {
  const row = m.phase === "checkbox" ? /^\s*❯\s*(\d+)\./m.exec(m.regionSignature) : null;
  return row ? Number(row[1]) : undefined;
}

/** Same checkbox question while its "Type something" row fills: earlier rows, escape and steps hold. */
function sameQuestionRows(a: MultiSelectModel, b: MultiSelectModel, rows: number): boolean {
  if (a.phase !== "checkbox" || b.phase !== "checkbox") return false;
  return a.question === b.question && a.advanceLabel === b.advanceLabel && a.escape?.label === b.escape?.label &&
    JSON.stringify(a.steps) === JSON.stringify(b.steps) &&
    a.options.length >= rows && b.options.length >= rows &&
    a.options.slice(0, rows).every((o, i) => o.label === b.options[i]!.label);
}

const sent = (keys: string[]): AnswerResult => ({ status: 200, outcome: { ok: true }, keys });
/** Before any key: the card itself says the box has focus, so the refusal names the same box. */
const TEXT_BOX_IN_USE = "The terminal's text box is in use. Nothing was sent.";
/** A walk that already moved the pointer sent arrows, so its default says nothing was submitted. */
const changed = (error = "The question changed in the terminal. Nothing was submitted."): AnswerResult =>
  ({ status: 409, outcome: { ok: false, error, code: "interaction_changed" } });
const failed = (error: string): AnswerResult => ({ status: 409, outcome: { ok: false, error } });
const unsupported = (): AnswerResult =>
  ({ status: 422, outcome: { ok: false, error: "Answer this one in the terminal.", code: "unsupported" } });
