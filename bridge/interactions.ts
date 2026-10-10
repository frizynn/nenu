import { createHash } from "node:crypto";
import { parseAnsi } from "../web/src/lib/ansi.ts";
import { splitLines, type Block } from "../web/src/lib/blocks.ts";
import { DIALOG_CONTRACT, type DialogKind, type DialogModels } from "../web/src/lib/harness/dialog-contract.ts";
import { adapterFor } from "../web/src/lib/harness/index.ts";
import { multiSelectIdentity, type MultiSelectModel } from "../web/src/lib/harness/multi-select-model.ts";
import { defaultSleep, POLL_ATTEMPTS, POLL_DELAY_MS, type Sleep } from "../web/src/lib/harness/poll.ts";
import { previewStructureEqual, type PreviewSelectModel } from "../web/src/lib/harness/preview-model.ts";
import { promptsSameIdentity, type PromptModel } from "../web/src/lib/harness/prompt-model.ts";
import { WIZARD_CANCEL_KEYS, WIZARD_SUBMIT_KEYS } from "../web/src/lib/harness/wizard-model.ts";
import type { PaneRead } from "./herdr-client.ts";
import type {
  AgentView,
  AnswerOutcome,
  AnswerRequest,
  Interaction,
  InteractionHint,
  InteractionKind,
  InteractionOption,
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
}

/** Interaction as served. The extra fields are wire additions this module owns until types.ts has them. */
export interface DetectedInteraction extends Interaction {
  options: Array<InteractionOption & { checked?: boolean }>;
  /** The full command, file or plan is on the card (a hint carried it and the screen shows it). */
  detailComplete: boolean;
}

/** An answer as POSTed; `confirm` acknowledges a `persistent` option. */
export type AnswerBody = AnswerRequest & { confirm?: boolean };

/** How one option is answered, kept bridge-side: the wire only names the option by index. */
type Recipe =
  | { type: "keys"; keys: string[] }
  /** Multi-select: walk the pointer to Submit/Next, then Enter (the closed loop of multi-select-action). */
  | { type: "advance" }
  /** Preview question: the digit only moves the pointer; Enter selects once the pointer is verified. */
  | { type: "preview"; n: number }
  /** Plan feedback: focus the input, type, verify, Enter (PLAN_FEEDBACK_NOTES.md). */
  | { type: "feedback"; key: string }
  | { type: "unsupported" };

type Dialog = { [K in DialogKind]: { kind: K; model: DialogModels[K] } }[DialogKind];

type Option = DetectedInteraction["options"][number];

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
  choices: Draft[];
}

interface Detection {
  interaction: DetectedInteraction;
  dialog: Dialog;
  choices: Choice[];
}

export type AnswerResult = { status: 200 | 400 | 409 | 422 | 502; outcome: AnswerOutcome; keys?: string[] };

/** Longest plan feedback typed from the phone; the same grammar bound as lib/prompt-action.ts. */
const FEEDBACK_MAX_LENGTH = 240;
/** Settle time between the multi-select walk's pointer moves (multi-select-action.ts). */
const NAV_SETTLE_MS = 250;
/** A matched dialog regex keeps a pane eligible for detection this long even before Herdr says blocked. */
const OUTPUT_MATCH_WINDOW_MS = 30_000;
/** Rows of a prompt's subject kept above its question. */
const CONTEXT_MAX_ROWS = 12;

const DENY = /^(no\b|reject|deny|decline|cancel|exit|quit|request changes|chat about this|skip)/i;
const PERSISTENT = /\b(always|don['’]?t ask again|do not ask again|this session|auto mode|switch to|from this project|remember|as default)\b/i;
const TYPE_SOMETHING = /^type something\b/i;

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

function role(label: string, persistent = false): InteractionOption["role"] {
  if (TYPE_SOMETHING.test(label)) return "freeText";
  if (DENY.test(label)) return "deny";
  return persistent || PERSISTENT.test(label) ? "persistent" : "neutral";
}

const keys = (k: string[]): Recipe => ({ type: "keys", keys: k });
/** A "Type something" row is typed into in the terminal; a digit would only focus or tick it. */
const pick = (label: string, recipe: Recipe, extra: Partial<Option> = {}): Draft => {
  const option = { label, role: role(label), ...extra };
  return { option, recipe: option.role === "freeText" && recipe.type !== "feedback" ? { type: "unsupported" } : recipe };
};

/** Kind, question and the answerable options of a dialog, before hints. */
function describe(dialog: Dialog, agent: string): Described {
  switch (dialog.kind) {
    case "prompt-select": return describePrompt(dialog.model, agent);
    case "wizard": {
      const w = dialog.model;
      if (w.phase === "review") return review(agent, "wizard", w.answers.map((a) => `${a.question} → ${a.answer}`).join("\n"));
      return {
        kind: "wizard", family: agent, question: w.question,
        choices: w.options.map((o) => pick(o.label, keys(o.keys), { ...(o.description ? { description: o.description } : {}), ...(o.escape ? { role: "deny" } : {}) })),
      };
    }
    case "multi-select": {
      const m = dialog.model;
      if (m.phase === "review") return review(agent, "multi-select");
      return {
        kind: "multi-select", family: agent, question: m.question,
        choices: [
          ...m.options.map((o) => pick(o.label, keys([String(o.n)]), { checked: o.checked, ...(o.description ? { description: o.description } : {}) })),
          pick(m.advanceLabel, { type: "advance" }, { role: "primary" }),
          ...(m.escape ? [pick(m.escape.label, keys([String(m.escape.n)]), { role: "deny" })] : []),
        ],
      };
    }
    case "preview-select":
      return { kind: "question", family: agent, question: dialog.model.question, choices: dialog.model.options.map((o) => pick(o.label, { type: "preview", n: o.n })) };
    case "menu":
      return {
        kind: "menu", family: agent, question: dialog.model.title,
        choices: dialog.model.actions.map((a) => pick(a.label, keys(a.keys), a.cancel ? { role: "deny" } : {})),
      };
  }
}

function review(agent: string, kind: "wizard" | "multi-select", context?: string): Described {
  return {
    kind, family: agent, question: "Review your answers", ...(context ? { context } : {}),
    choices: [pick("Submit answers", keys(WIZARD_SUBMIT_KEYS), { role: "primary" }), pick("Cancel", keys(WIZARD_CANCEL_KEYS), { role: "deny" })],
  };
}

function describePrompt(p: PromptModel, agent: string): Described {
  const kind: InteractionKind = p.family === "plan" ? "plan" : p.family === "select" ? "question" : "permission";
  const choices = p.options.map((o) => {
    const choice = pick(o.label, keys(o.keys), { role: role(o.label, p.family === "trust") });
    if (o.description) choice.option.description = o.description;
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
  const context = promptContext(p);
  return { kind, family: p.family, question: p.question, ...(context ? { context } : {}), choices };
}

/**
 * The subject of a prompt from its literal region: the rows under the dialog's top rule and above the
 * question (Claude's command or file), plus the rows between the question and the first option
 * (Codex's `$ command`). Bounded, so a long plan shows its tail here and its whole text via a hint.
 */
function promptContext(p: PromptModel): string | undefined {
  const lines = p.signature.split("\n");
  const q = lines.findIndex((l) => l.includes(p.question.slice(0, 40)));
  if (q < 0) return undefined;
  const first = p.options[0] ? lines.findIndex((l, i) => i > q && l.includes(p.options[0]!.label)) : -1;
  let top = q;
  while (top > 0 && q - top < CONTEXT_MAX_ROWS && !/^\s*[─━▔═]{8,}\s*$/.test(lines[top - 1]!)) top--;
  const rows = [...lines.slice(top, q), ...(first > q ? lines.slice(q + 1, first) : [])]
    .map((l) => l.replace(/^[\s│┃]+|[\s│┃]+$/g, ""))
    .filter((l) => l && !/^[─━▔═╌]+$/.test(l));
  return rows.length ? rows.join("\n") : undefined;
}

const compact = (s: string) => s.replace(/\s+/g, "").replace(/…$/, "");

/** A hint agrees when what it says is what the screen shows; otherwise the screen wins and it is dropped. */
function agrees(hint: InteractionHint, kind: InteractionKind, question: string, labels: string[], region: string): boolean {
  if (kind === "permission") return !!hint.detail && compact(region).includes(compact(hint.detail));
  if (kind === "plan") return !hint.question && !!hint.detail;
  if (hint.question && !compact(hint.question).startsWith(compact(question)) && !compact(question).startsWith(compact(hint.question))) return false;
  return (hint.options ?? []).every((o) => labels.some((l) => compact(o).startsWith(compact(l)) && compact(l).length > 0));
}

/** Build the served interaction for `dialog`: screen first, hints only where they agree. */
export function toInteraction(pane: Pick<AgentView, "paneId" | "agent">, dialog: Dialog, read: Pick<PaneRead, "text" | "revision">, hints: InteractionHint[], now: number): Detection {
  const base = describe(dialog, pane.agent);
  const choices: Choice[] = base.choices.map((c, index) => ({ option: { index, ...c.option }, recipe: c.recipe }));
  const labels = choices.map((c) => c.option.label);
  const kept = hints.filter((h) => agrees(h, base.kind, base.question, labels, read.text));
  const asked = kept.find((h) => h.question && base.kind !== "permission");
  const detail = kept.find((h) => h.detail)?.detail;
  const context = detail ?? base.context;
  const interaction: DetectedInteraction = {
    paneId: pane.paneId,
    agent: pane.agent,
    kind: base.kind,
    family: base.family,
    question: asked?.question && asked.question.length > base.question.length ? asked.question : base.question,
    ...(context ? { context } : {}),
    options: choices.map((c) => c.option),
    signature: dialogSignature(dialog),
    revision: read.revision,
    ...(kept.length ? { hints: kept } : {}),
    detectedAt: now,
    detailComplete: base.kind === "permission" && detail !== undefined,
  };
  return { interaction, dialog, choices };
}

/**
 * The options a notification may answer without opening Nenu: never a persistent or free-text one,
 * only on a question or a permission whose full command/file is on the card, and only when every
 * answer fits in two actions, so the one left out is never an answer. A question's escape row
 * ("Chat about this") is not an answer; a permission's "No" is.
 */
export function pushActions(i: DetectedInteraction): Array<{ optionIndex: number; title: string }> {
  if (i.kind !== "question" && !(i.kind === "permission" && i.detailComplete)) return [];
  const answers = i.options.filter((o) => o.role === "primary" || o.role === "neutral" || (i.kind === "permission" && o.role === "deny"));
  return answers.length > 0 && answers.length <= 2 ? answers.map((o) => ({ optionIndex: o.index, title: o.label })) : [];
}

const paneKey = (session: string, paneId: string) => `${session}\u0000${paneId}`;

interface Entry {
  /** Screen text plus hints the detection was built from; the same input is never re-parsed. */
  input: string;
  detection: Detection | null;
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
  lines?: number;
  now?: () => number;
  sleep?: Sleep;
}

export class Interactions {
  private readonly panes = new Map<string, Entry>();
  private readonly matched = new Map<string, number>();
  private readonly lines: number;
  private readonly now: () => number;
  private readonly sleep: Sleep;

  constructor(readonly live: LivePublisher, opts: Options = {}) {
    this.lines = opts.lines ?? 200;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** The pane's last detected interaction, without reading anything. */
  current(session: string, paneId: string): DetectedInteraction | null {
    return this.panes.get(paneKey(session, paneId))?.detection?.interaction ?? null;
  }

  /** A `pane.output_matched` for a dialog regex: the pane is worth reading even before it is blocked. */
  noteOutputMatched(session: string, paneId: string): void {
    this.matched.set(paneKey(session, paneId), this.now());
  }

  /**
   * Re-detect the session's eligible panes (blocked, or a dialog regex matched lately) and forget the
   * rest. A pane is read every time (one local read, no revision to skip on: pane.read's is 0) but only
   * parsed when its text or hints changed. Publishes `interaction` for every pane whose card changed.
   */
  async refresh(session: string, io: PaneIO, agents: readonly AgentView[], hints?: HintSource, only?: string): Promise<DetectedInteraction[]> {
    const now = this.now();
    const eligible = agents.filter((a) => {
      const matchedAt = this.matched.get(paneKey(session, a.paneId));
      return a.status === "blocked" || (matchedAt !== undefined && now - matchedAt <= OUTPUT_MATCH_WINDOW_MS);
    });
    const live = new Set(eligible.map((a) => a.paneId));
    if (only === undefined) {
      for (const key of [...this.panes.keys()]) {
        const [s, paneId] = key.split("\u0000") as [string, string];
        if (s === session && !live.has(paneId)) this.forget(session, paneId);
      }
    }
    await Promise.all(eligible.filter((a) => only === undefined || a.paneId === only).map(async (pane) => {
      try {
        const read = await io.readPane(pane.paneId, "recent", this.lines, "ansi");
        this.store(session, pane, read, hints ? await hints(session, pane) : []);
      } catch {
        // An unreadable pane keeps its last card; the next refresh tries again.
      }
    }));
    return eligible.map((a) => this.current(session, a.paneId)).filter((i): i is DetectedInteraction => i !== null);
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
    const matching = new Set<string>();
    const detect = (rt: R, only?: string) =>
      void this.refresh(rt.name, rt.herdr, rt.engine.current().agents, hints(rt), only).catch(() => {});
    return events.subscribe(({ session, topic, paneId }) => {
      const rt = registry.get(session);
      if (!rt) return;
      if (rt.poker && !matching.has(session)) {
        matching.add(session);
        rt.poker.onOutputMatched((e) => {
          this.noteOutputMatched(session, e.paneId);
          detect(rt, e.paneId);
        });
      }
      if (topic === "snapshot") detect(rt);
      else if (topic === "pane" && paneId !== undefined) detect(rt, paneId);
    });
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
    if (previous?.input === input) return previous.detection;
    const dialog = dialogOnScreen(pane.agent, read.text);
    const detection = dialog ? toInteraction(pane, dialog, read, hints, this.now()) : null;
    this.panes.set(key, { input, detection });
    const before = previous?.detection?.interaction;
    const after = detection?.interaction;
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
  async answer(session: string, io: PaneIO, pane: AgentView, body: AnswerBody): Promise<AnswerResult> {
    let read: PaneRead;
    try {
      read = await io.readPane(pane.paneId, "recent", this.lines, "ansi");
    } catch (err) {
      return { status: 502, outcome: { ok: false, error: `herdr read failed: ${(err as Error).message}` } };
    }
    const detection = this.store(session, pane, read, this.panes.get(paneKey(session, pane.paneId))?.detection?.interaction.hints ?? []);
    if (!detection || detection.interaction.signature !== body.signature) return changed("The dialog changed. Look again before answering.");
    const choice = detection.choices[body.optionIndex];
    if (!choice) return { status: 400, outcome: { ok: false, error: "unknown option" } };
    if (choice.option.role === "persistent" && body.confirm !== true) {
      return { status: 409, outcome: { ok: false, error: "This option changes a setting beyond this answer. Confirm it.", code: "confirm_required" } };
    }
    const { dialog } = detection;
    // While the dialog's own input row has focus every digit is typed into it (issue #95).
    if (dialog.kind === "prompt-select" && dialog.model.feedback?.focused && choice.recipe.type !== "feedback") {
      return changed("Someone is typing in this dialog.");
    }
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

  /** Bounded polling until `accept`; "drifted" when another dialog (or none) replaced this one. */
  private async poll<K extends DialogKind>(io: PaneIO, pane: AgentView, kind: K, tapped: DialogModels[K], accept: (m: DialogModels[K]) => boolean): Promise<"ok" | "drifted" | "timeout"> {
    const identity = DIALOG_CONTRACT[kind].identity as (a: DialogModels[K], b: DialogModels[K]) => boolean;
    let seen = false;
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      await this.sleep(POLL_DELAY_MS);
      const m = await this.model(io, pane, kind).catch(() => null);
      if (!m) continue;
      seen = true;
      if (accept(m)) return "ok";
      if (!identity(m, tapped)) return "drifted";
    }
    return seen ? "timeout" : "drifted";
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
    return changed();
  }

  /** Preview question: the digit moves the pointer; Enter only once the pointer is verified there. */
  private async preview(io: PaneIO, pane: AgentView, tapped: PreviewSelectModel, n: number): Promise<AnswerResult> {
    await io.sendPaneKeys(pane.paneId, [String(n)]);
    const pointed = await this.poll(io, pane, "preview-select", tapped, (m) => previewStructureEqual(m, tapped) && (m.options.find((o) => o.n === n)?.pointed ?? false));
    if (pointed !== "ok") return changed();
    await io.sendPaneKeys(pane.paneId, ["Enter"]);
    return sent([String(n), "Enter"]);
  }

  /**
   * Deny a plan with feedback: focus the empty input, type, verify our exact words are in it, Enter.
   * Refused unless the box is empty and unfocused: re-entering a filled box prepends at position 0.
   */
  private async feedback(io: PaneIO, pane: AgentView, tapped: PromptModel, key: string, raw: string): Promise<AnswerResult> {
    const row = tapped.feedback;
    if (!row || row.focused || row.text !== "") return changed("Someone is typing in this dialog.");
    const text = raw.replace(/\s+/g, " ").replace(/\p{Cc}/gu, "").trim().slice(0, FEEDBACK_MAX_LENGTH);
    if (!text) return { status: 400, outcome: { ok: false, error: "Nothing to send" } };
    await io.sendPaneKeys(pane.paneId, [key]);
    const focused = (m: PromptModel) => promptsSameIdentity(m, tapped) && (m.feedback?.focused ?? false) && m.feedback?.text === "";
    if ((await this.poll(io, pane, "prompt-select", tapped, focused)) !== "ok") return failed("The feedback box didn't open. Check the pane.");
    await io.sendPaneText(pane.paneId, text);
    const landed = (m: PromptModel) => promptsSameIdentity(m, tapped) && (m.feedback?.focused ?? false) && m.feedback?.text === text;
    if ((await this.poll(io, pane, "prompt-select", tapped, landed)) !== "ok") return failed("The feedback didn't arrive. Nothing was submitted.");
    // The Enter is the irreversible write: one more read right before it.
    const fresh = await this.model(io, pane, "prompt-select");
    if (!fresh || !landed(fresh)) return changed();
    await io.sendPaneKeys(pane.paneId, ["Enter"]);
    return sent([key, "Enter"]);
  }
}

const sent = (keys: string[]): AnswerResult => ({ status: 200, outcome: { ok: true }, keys });
const changed = (error = "The dialog changed. Look again before answering."): AnswerResult =>
  ({ status: 409, outcome: { ok: false, error, code: "interaction_changed" } });
const failed = (error: string): AnswerResult => ({ status: 409, outcome: { ok: false, error } });
const unsupported = (): AnswerResult =>
  ({ status: 422, outcome: { ok: false, error: "Answer this one in the terminal.", code: "unsupported" } });
