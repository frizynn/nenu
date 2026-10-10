// The whole guarded send in one bridge call (ADR 0010, 0023, 0048).
//
// The browser used to run this choreography itself (web/src/lib/guarded-reply.ts): a pre-flight GET,
// a sweep POST, a type POST, verification GETs and a submit POST, each a phone round trip. Here the
// same steps run next to the socket, where a pane read costs about a millisecond:
//
//   identity (pane.get) → pre-flight read → sweep a stranded draft, bound to the prompt row the
//   pre-flight saw → type (bracketed paste for Codex) → wait for the text (pane.wait_for_output as a
//   trigger only) → the adapter's verdict on a fresh read → one more read right before Enter →
//   Enter → confirm the input box let go of the message.
//
// The adapter stays the only authority for Enter: a trigger match only says "look now", and nothing
// presses the submit key without a read the adapter accepted moments before.

import { parseAnsi } from "../web/src/lib/ansi.ts";
import { lineText, splitLines, trimTrailingBlank, type StyledLine } from "../web/src/lib/blocks.ts";
import { draftCarriesSend } from "../web/src/lib/guarded-reply.ts";
import { adapterFor, type HarnessAdapter } from "../web/src/lib/harness/index.ts";
import { defaultSleep, type Sleep } from "../web/src/lib/harness/poll.ts";
import { detectNoEchoPrompt } from "../web/src/lib/no-echo.ts";
import type { EventPoker } from "./event-poker.ts";
import { herdrErrorCode, type HerdrClient } from "./herdr-client.ts";
import { verifyExpectedPrompt } from "./prompt-binding.ts";
import type { SendOutcome, SendRequest, SendStage } from "./types.ts";

export type SendHerdr = Pick<HerdrClient, "getPane" | "readPane" | "sendPaneText" | "sendPaneKeys" | "waitForOutput">;

export interface GuardedSendDeps {
  herdr: SendHerdr;
  paneId: string;
  /** Lines per read: the same window the pane GET serves, which is where the input box sits. */
  readLines: number;
  submitKeys: string[];
  trigger?: OutputTrigger;
  sleep?: Sleep;
  now?: () => number;
}

/** What earlier attempts with the same request id left behind, when they failed. */
export interface PriorAttempt {
  /** An earlier attempt sent (or tried to send) the text, so it may already be in the box. */
  typeAttempted: boolean;
  /** An earlier attempt knows the text reached the pane: it is in the box, or already submitted. */
  textDelivered: boolean;
}

/** Where a send stopped, in the vocabulary of the `reply.unsent` audit line (send-report.ts). */
export type SendPhase = "preflight" | "pre-type" | "type" | "verify" | "submit" | "confirm";
type VerifyRead = "read-failed" | "unreadable" | "no-composer" | "empty-draft" | "other-draft";

/** Everything the send learned on the way, for the audit line of a send that did not go out. */
export interface SendTrace {
  phase: SendPhase;
  preflight: "skipped" | "read-failed" | "no-composer" | "composer";
  attempts: VerifyRead[];
  /** This request id has sent (or tried to send) the text, in this attempt or an earlier one. */
  typeAttempted: boolean;
  noEcho: boolean;
  draft: string | null;
  screen: string[] | null;
  /** The text went out without an adapter able to read it back (no grammar for this harness). */
  unverified: boolean;
}

export interface GuardedSendResult {
  outcome: SendOutcome;
  trace: SendTrace;
}

const NO_PANE = "The agent's pane is gone. Nothing was typed.";
const NO_BOX = "The agent's input box isn't on screen — a menu or dialog is probably up. Nothing was typed.";
const NO_ECHO =
  "That's a password prompt — it shows nothing as you type, so Send can never confirm the text arrived. Nothing was typed.";
const NO_ECHO_TYPED =
  "That's a password prompt — it shows nothing as you type, so the text can't be confirmed and nothing was submitted. What you typed is already in the pane.";
const UNREAD =
  "Couldn't read the terminal to confirm your message. Nothing was submitted; the text may already be typed, so check Terminal before retrying.";
const UNSEEN = "Your message wasn't seen in the agent's input box. Nothing was submitted; it may still be typed, so check Terminal before retrying.";
const MOVED = "The input box changed right before Enter. Nothing was submitted; check Terminal before retrying.";
const UNCONFIRMED = "Enter went out, but the message is still in the input box. Check Terminal before retrying.";
const UNCHECKED =
  "Couldn't read the terminal to check the earlier try of this message. Nothing was typed; check Terminal before retrying.";
const NO_READBACK =
  "This agent's input box can't be read back, so the earlier try of this message can't be checked. Nothing was typed; check Terminal.";
const MAYBE_SENT =
  "The earlier try of this message is no longer in the input box, so it may already have been sent. Nothing was typed; check Terminal.";
const NOT_SUBMITTED = "Typed into the pane but not submitted — check the pane before resending.";
const ESCAPES = "The message contains terminal escape sequences, which a paste cannot carry. Nothing was typed.";

const SCREEN_LINES = 15;
/** One trigger wait. A miss is followed by a fresh read, so a draft the regex cannot see (windowed,
 *  wrapped mid-word) still verifies within one slice. */
export const TRIGGER_SLICE_MS = 400;
/**
 * The waits before each local read while the send polls (sweep, verify fallback, confirm). A read is
 * a local socket call of about a millisecond, so the steps start much shorter than the browser
 * guard's VERIFY_DELAYS_MS; the window is as long (2.5 s), so a slow terminal gets the same time.
 */
export const LOCAL_DELAYS_MS: readonly number[] = [0, 20, 20, 30, 30, 50, 50, 100, 100, 200, 200, 300, 350, 350, 350, 350];
export const VERIFY_BUDGET_MS = LOCAL_DELAYS_MS.reduce((sum, ms) => sum + ms, 0);

// ── The trigger regex ─────────────────────────────────────────────────────────────────────────────

/** Characters of the message's head the trigger quotes. Short enough to sit on the prompt row of a
 *  narrow pane, long enough that an unrelated row rarely matches. */
export const TRIGGER_PREFIX_MAX = 24;
/** Upper bound on the whole pattern: a quoted character becomes at most four (a space's class). */
export const TRIGGER_PATTERN_MAX = 4 * TRIGGER_PREFIX_MAX + 64;

// Meta characters in both Rust's regex crate and JavaScript. Escaping exactly these keeps the escape
// valid in both: Rust rejects some identity escapes that JavaScript accepts, and the reverse.
const META = /[.*+?^${}()|[\]\\]/g;
// A head character the terminal paints as itself in one cell. Wide (CJK, emoji) and combining
// characters may come back padded or recomposed from the grid, so the head stops before them, and
// at any whitespace but a single plain space.
const PLAIN = /^[\p{L}\p{N}\p{P}\p{S} ]$/u;

/** The head of the message the trigger quotes, before escaping. Exported for the tests. */
export function triggerHead(text: string): string {
  let head = "";
  for (const ch of text.trimStart()) {
    const cp = ch.codePointAt(0)!;
    if (head.length >= TRIGGER_PREFIX_MAX || cp >= 0x1100 || !PLAIN.test(ch) || (ch === " " && head.endsWith(" "))) break;
    head += ch;
  }
  return head.trimEnd();
}

/**
 * The `pane.wait_for_output` pattern that says "our text may be on the input row now": a prompt glyph
 * near the start of a line (Claude paints U+00A0 after `❯`), then the escaped head of the message, or
 * a paste placeholder (Claude `[Pasted text …]`, Codex `[Pasted Content …]`). Herdr matches it on its
 * ANSI-stripped read, line by line, so `(?m)` anchors `^` per row.
 *
 * Bounded and escaped by construction: at most {@link TRIGGER_PREFIX_MAX} quoted characters, every
 * meta character escaped, no nested quantifier. It compiles the same in Rust and JavaScript.
 */
export function triggerPattern(text: string): string {
  const head = triggerHead(text).replace(META, "\\$&").replaceAll(" ", "[ \u00a0]");
  const placeholder = "\\[Pasted ";
  return head ? `(?m)(?:^.{0,8}?[❯›>][  ]+${head}|${placeholder})` : `(?m)${placeholder}`;
}

/**
 * Whether the trigger may be used on a runtime. Off for a while after Herdr refused a regex, whether
 * it was this send's (`invalid_regex`), an old server without the method, or a standing output watch
 * the event poker had to drop: until then sends fall back to bounded polling.
 */
export class OutputTrigger {
  static readonly COOLDOWN_MS = 10 * 60_000;
  private offUntil = 0;
  constructor(private readonly now: () => number = Date.now) {}
  available(): boolean {
    return this.now() >= this.offUntil;
  }
  disable(): void {
    this.offUntil = this.now() + OutputTrigger.COOLDOWN_MS;
  }
}

const triggers = new WeakMap<object, OutputTrigger>();

/** The trigger state of one session runtime, keyed by its event poker. */
export function triggerFor(poker: Pick<EventPoker, "onOutputWatchesRejected">): OutputTrigger {
  let trigger = triggers.get(poker);
  if (!trigger) {
    const created = new OutputTrigger();
    poker.onOutputWatchesRejected(() => created.disable());
    triggers.set(poker, created);
    trigger = created;
  }
  return trigger;
}

// ── The send ──────────────────────────────────────────────────────────────────────────────────────

interface Seen {
  lines: StyledLine[];
  text: string;
  /** null = the adapter cannot tell (no composerReady). */
  composer: boolean | null;
  draft: string | null;
}

class Send {
  readonly trace: SendTrace = {
    phase: "preflight",
    preflight: "skipped",
    attempts: [],
    typeAttempted: false,
    noEcho: false,
    draft: null,
    screen: null,
    unverified: false,
  };
  readonly sleep: Sleep;

  constructor(
    private readonly deps: GuardedSendDeps,
    readonly request: SendRequest,
    private readonly adapter: HarnessAdapter | undefined,
    private readonly prior?: PriorAttempt,
  ) {
    this.sleep = deps.sleep ?? defaultSleep;
    if (prior?.typeAttempted) this.trace.typeAttempted = true;
  }

  /** `textDelivered` is this attempt's; text an earlier attempt delivered may still be there too. */
  fail(error: string, textDelivered: boolean, code?: "prompt_changed" | "not_ready" | "busy"): GuardedSendResult {
    const stage: SendStage = this.trace.phase === "pre-type" ? "preflight" : this.trace.phase;
    const delivered = textDelivered || this.prior?.textDelivered === true;
    return {
      outcome: { ok: false, requestId: this.request.requestId, stage, error, textDelivered: delivered, ...(code ? { code } : {}) },
      trace: this.trace,
    };
  }

  done(): GuardedSendResult {
    return { outcome: { ok: true, requestId: this.request.requestId, ack: "submitted" }, trace: this.trace };
  }

  async read(): Promise<Seen> {
    const fresh = await this.deps.herdr.readPane(this.deps.paneId, "recent", this.deps.readLines, "ansi");
    const lines = splitLines(parseAnsi(fresh.text));
    const draft = this.adapter?.extractInputDraft(lines) ?? null;
    const composer = this.adapter?.composerReady ? this.adapter.composerReady(lines) : null;
    this.trace.draft = draft;
    this.trace.screen = trimTrailingBlank(lines).slice(-SCREEN_LINES).map((line) => lineText(line).trimEnd());
    if (composer !== true && detectNoEchoPrompt(lines) !== null) this.trace.noEcho = true;
    return { lines, text: fresh.text, composer, draft };
  }

  carries(seen: Seen): boolean {
    const { text } = this.request;
    if (draftCarriesSend(text, seen.draft)) return true;
    return seen.draft !== null && this.adapter?.draftCarriesSend?.(text, seen.draft) === true;
  }

  /** A read that throws is a miss; the bounded loops around it are the timeout. */
  async check(): Promise<boolean> {
    let seen: Seen;
    try {
      seen = await this.read();
    } catch {
      this.trace.attempts.push("read-failed");
      return false;
    }
    this.trace.attempts.push(seen.draft !== null ? "other-draft" : seen.composer === false ? "no-composer" : "empty-draft");
    return this.carries(seen);
  }
}

/**
 * Run one guarded send. Never throws: every way it can end is a {@link SendOutcome}, and the trace
 * says enough to audit a send that did not go out. The caller holds the pane's write lock.
 */
export async function guardedSend(deps: GuardedSendDeps, request: SendRequest, prior?: PriorAttempt): Promise<GuardedSendResult> {
  let agent: string | null | undefined;
  try {
    agent = (await deps.herdr.getPane(deps.paneId)).agent;
  } catch (err) {
    const send = new Send(deps, request, undefined, prior);
    return send.fail(herdrErrorCode(err) === "pane_not_found" ? NO_PANE : `herdr pane.get failed: ${message(err)}`, false);
  }
  const adapter = adapterFor(agent ?? undefined);
  const send = new Send(deps, request, adapter, prior);
  const bracketed = adapter?.bracketedPaste === true || request.paste === true;
  if (bracketed && /[\x1b\x9b]/.test(request.text)) return send.fail(ESCAPES, false);
  const wire = bracketed ? `\x1b[200~${request.text}\x1b[201~` : request.text;

  // PRE-FLIGHT: one live read decides whether anything may be typed at all. A read that fails lets
  // the message through without the sweep, as the browser guard did: Enter still waits for a read
  // that shows the text. A prompt binding cannot be checked without it, so that send stops here.
  let seen: Seen | null = null;
  try {
    seen = await send.read();
  } catch (err) {
    send.trace.preflight = "read-failed";
    if (request.expectedPrompt !== undefined) return send.fail(`herdr read failed: ${message(err)}`, false);
  }
  if (request.expectedPrompt !== undefined && seen && !verifyExpectedPrompt(seen.text, request.expectedPrompt).ok) {
    return send.fail("prompt changed", false, "prompt_changed");
  }
  if (!adapter) return prior?.typeAttempted ? send.fail(NO_READBACK, false) : oneShot(send, deps, wire, seen?.text ?? null);
  if (seen && seen.composer !== null) {
    send.trace.preflight = seen.composer ? "composer" : "no-composer";
    if (!seen.composer) return send.fail(send.trace.noEcho ? NO_ECHO : NO_BOX, false, "not_ready");
  }

  // An earlier attempt with this id may have typed before it failed (an ack lost after the bytes
  // reached the PTY). Its text, still in the box, is this send's text: submit it rather than type a
  // second copy. Text it delivered that is no longer in the box may have been submitted by an Enter
  // whose ack was lost, so nothing is typed; neither when the box cannot be read to tell.
  if (prior?.typeAttempted && seen === null) return send.fail(UNCHECKED, false);
  const alreadyTyped = prior?.typeAttempted === true && seen !== null && send.carries(seen);
  if (prior?.textDelivered && !alreadyTyped) return send.fail(MAYBE_SENT, true);

  if (!alreadyTyped && seen?.composer === true && seen.draft !== null) {
    send.trace.phase = "pre-type";
    const swept = await sweep(send, deps, adapter, seen);
    if (swept) return swept;
  }

  if (!alreadyTyped) {
    send.trace.phase = "type";
    send.trace.typeAttempted = true;
    try {
      await deps.herdr.sendPaneText(deps.paneId, wire);
    } catch (err) {
      // The ack can fail after the bytes landed. Look before deciding the text is not there.
      if (!(await send.check())) return send.fail(`herdr send_text failed: ${message(err)}`, false);
    }
  }

  send.trace.phase = "verify";
  if (!(await verify(send, deps))) {
    if (send.trace.noEcho) return send.fail(NO_ECHO_TYPED, true);
    const unread = send.trace.attempts.length > 0 && send.trace.attempts.every((read) => read === "read-failed");
    // The text went out (or an earlier attempt's was already there): a resend could duplicate it.
    return send.fail(unread ? UNREAD : UNSEEN, true);
  }

  // The last word before Enter: a fresh read must still show this message in the input box.
  send.trace.phase = "submit";
  let last: Seen;
  try {
    last = await send.read();
  } catch {
    return send.fail(MOVED, true);
  }
  if (last.composer === false || !send.carries(last)) return send.fail(MOVED, true);
  try {
    await deps.herdr.sendPaneKeys(deps.paneId, deps.submitKeys);
  } catch {
    return send.fail(NOT_SUBMITTED, true);
  }

  send.trace.phase = "confirm";
  for (const delay of LOCAL_DELAYS_MS) {
    if (delay > 0) await send.sleep(delay);
    try {
      if (!send.carries(await send.read())) return send.done();
    } catch {
      // A failed read confirms nothing; the bounded loop is the timeout.
    }
  }
  return send.fail(UNCONFIRMED, true);
}

/**
 * Clear a stranded draft before typing, as the browser composer did (ctrl+k, then Backspaces sized
 * from the draft). The keys are bound to the prompt row the pre-flight saw: a read right before them
 * must still show it. Returns a failure, or null once a read shows an empty composer.
 */
async function sweep(send: Send, deps: GuardedSendDeps, adapter: HarnessAdapter, seen: Seen): Promise<GuardedSendResult | null> {
  const region = adapter.composerPrompt?.(seen.lines) ?? null;
  if (region !== null) {
    let fresh: string;
    try {
      fresh = (await deps.herdr.readPane(deps.paneId, "recent", deps.readLines, "ansi")).text;
    } catch (err) {
      return send.fail(`herdr read failed: ${message(err)}`, false);
    }
    if (!verifyExpectedPrompt(fresh, region).ok) {
      return send.fail("The input box changed while clearing it — nothing was typed. Check the pane.", false, "prompt_changed");
    }
  }
  try {
    await deps.herdr.sendPaneKeys(deps.paneId, ["ctrl+k", ...Array<string>([...seen.draft!].length + 32).fill("Backspace")]);
  } catch (err) {
    return send.fail(`Couldn't clear the terminal input: ${message(err)}`, false);
  }
  for (const delay of LOCAL_DELAYS_MS) {
    if (delay > 0) await send.sleep(delay);
    try {
      const now = await send.read();
      if (now.composer === false) {
        return send.fail("The agent's input box left the screen while its input line was being cleared. Your message wasn't typed.", false, "not_ready");
      }
      if (now.draft === null) return null;
    } catch {
      // Nothing may be typed until a live read confirms the clear finished.
    }
  }
  return send.fail("The terminal draft has not cleared yet. Your message wasn't typed; retry when the terminal is ready.", false);
}

/**
 * Wait until the adapter sees the message in the input box. `pane.wait_for_output` wakes the loop
 * when the trigger regex matches, and every wake (match or miss) ends in a fresh read the adapter
 * judges. A match the adapter rejects (the text elsewhere on screen) hands the rest of the window to
 * plain polling, so a stale row cannot make the wait spin.
 */
async function verify(send: Send, deps: GuardedSendDeps): Promise<boolean> {
  if (await send.check()) return true;
  const trigger = deps.trigger;
  let pattern = trigger?.available() ? triggerPattern(send.request.text) : null;
  let budget = VERIFY_BUDGET_MS;
  const polls = LOCAL_DELAYS_MS.slice(1);
  let next = 0;
  while (budget > 0) {
    if (pattern !== null) {
      const slice = Math.min(TRIGGER_SLICE_MS, budget);
      budget -= slice;
      try {
        const wait = await deps.herdr.waitForOutput(deps.paneId, {
          source: "recent",
          match: { type: "regex", value: pattern },
          timeoutMs: slice,
          lines: deps.readLines,
        });
        if (await send.check()) return true;
        if (wait.matched) pattern = null;
      } catch (err) {
        // Herdr refused the pattern, or predates the method: poll from here on, and on this runtime
        // until the cooldown passes. Any other failure only ends the trigger for this send.
        if (herdrErrorCode(err) === "invalid_regex" || message(err).includes("unknown variant")) trigger?.disable();
        pattern = null;
      }
      continue;
    }
    const delay = polls[next++];
    if (delay === undefined) break;
    budget -= delay;
    await send.sleep(delay);
    if (await send.check()) return true;
  }
  return false;
}

/** How often the adapter-less settle looks at the pane, and how long it may wait at most. */
export const SETTLE_TICK_MS = 25;
export const SETTLE_CAP_MS = 350;

/**
 * Wait for the pane to show a change since `before` and hold it for one tick, at most
 * {@link SETTLE_CAP_MS}. Replaces a fixed 350 ms pause between typing and Enter on a pane nothing can
 * read back: it is not evidence (no adapter can say what the change was), only a shorter wait when
 * the terminal has visibly reacted. A failed read counts as no change.
 */
export async function settleAfterType(read: () => Promise<string>, before: string | null, sleep: Sleep = defaultSleep): Promise<void> {
  let previous: string | null = null;
  for (let waited = 0; waited < SETTLE_CAP_MS; waited += SETTLE_TICK_MS) {
    await sleep(SETTLE_TICK_MS);
    let now: string;
    try {
      now = await read();
    } catch {
      continue;
    }
    if (before !== null && now !== before && now === previous) return;
    previous = now;
  }
}

/**
 * A harness with no adapter: nothing can read its input box back, so nothing can verify the text.
 * Type, let the screen settle, Enter — the long-standing behaviour, marked unverified in the trace.
 */
async function oneShot(send: Send, deps: GuardedSendDeps, wire: string, before: string | null): Promise<GuardedSendResult> {
  send.trace.unverified = true;
  send.trace.phase = "type";
  send.trace.typeAttempted = true;
  try {
    await deps.herdr.sendPaneText(deps.paneId, wire);
  } catch (err) {
    return send.fail(`herdr send_text failed: ${message(err)}`, false);
  }
  const read = async () => (await deps.herdr.readPane(deps.paneId, "recent", deps.readLines, "ansi")).text;
  await settleAfterType(read, before, deps.sleep);
  send.trace.phase = "submit";
  try {
    await deps.herdr.sendPaneKeys(deps.paneId, deps.submitKeys);
  } catch {
    return send.fail(NOT_SUBMITTED, true);
  }
  return send.done();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── The request-id ledger ─────────────────────────────────────────────────────────────────────────

type LedgerEntry<T> = { fingerprint: string; expires: number } & ({ promise: Promise<T> } | { failed: T });

/**
 * Request-id idempotency for terminal writes. A success is replayed for {@link TTL_MS}: a retry whose
 * answer was lost must not type twice. A failure is NOT replayed: the retry runs again and is handed
 * the earlier outcome, so it can re-read the pane before typing instead of trusting either memory. A
 * retry with the same id and a different payload is a conflict.
 */
export class WriteLedger<T> {
  static readonly TTL_MS = 10 * 60_000;
  static readonly MAX = 512;
  private readonly entries = new Map<string, LedgerEntry<T>>();
  constructor(
    private readonly ok: (outcome: T) => boolean,
    private readonly now: () => number = Date.now,
  ) {}

  async run(
    key: string,
    fingerprint: string,
    operation: (prior: T | null) => Promise<T>,
  ): Promise<{ outcome: T; replayed: boolean } | { conflict: true }> {
    const now = this.now();
    for (const [candidate, entry] of this.entries) if (entry.expires <= now) this.entries.delete(candidate);
    const existing = this.entries.get(key);
    if (existing && existing.fingerprint !== fingerprint) return { conflict: true };
    if (existing && "promise" in existing) return { outcome: await existing.promise, replayed: true };
    const prior = existing ? existing.failed : null;
    const promise = operation(prior);
    const entry: LedgerEntry<T> = { fingerprint, promise, expires: now + WriteLedger.TTL_MS };
    this.entries.delete(key);
    this.entries.set(key, entry);
    while (this.entries.size > WriteLedger.MAX) this.entries.delete(this.entries.keys().next().value!);
    let outcome: T;
    try {
      outcome = await promise;
    } catch (err) {
      if (this.entries.get(key) === entry) this.entries.delete(key);
      throw err;
    }
    if (!this.ok(outcome) && this.entries.get(key) === entry) {
      this.entries.set(key, { fingerprint, failed: outcome, expires: entry.expires });
    }
    return { outcome, replayed: false };
  }
}
