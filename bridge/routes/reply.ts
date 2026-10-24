import { dirname } from "node:path";

import type { AuditLog } from "../audit.ts";
import type { Config } from "../config.ts";
import type { HerdrClient, PaneRead } from "../herdr-client.ts";
import {
  DEFAULT_PROMPT_TAIL_LINES,
  verifyExpectedPrompt,
  type PromptBindingResult,
} from "../prompt-binding.ts";
import { reportUnsentReply, sendReportDetail } from "../send-report.ts";
import type { ActionResponse, InterruptResponse, SendOutcome, SendRequest, TurnState } from "../types.ts";
import { claudeLogReader } from "../delivery-check.ts";
import { guardedSend, pasteFile, settleDraft, settleAfterType, takeBackQueue, triggerFor, WriteLedger, type GuardedSendDeps, type GuardedSendResult, type SendTrace } from "../guarded-send.ts";
import { adapterFor as journalFor } from "../journal/registry.ts";
import type { PaneWrites } from "../pane-writes.ts";
import { InterruptLedger, interruptTurn } from "../interrupt.ts";
import type { AgentStates } from "../agent-state.ts";
import type { QueueService } from "../queue-service.ts";
import type { SessionRuntime } from "../sessions.ts";
import { parseAnsi } from "../../web/src/lib/ansi.ts";
import { splitLines } from "../../web/src/lib/blocks.ts";
import { draftCarriesSend } from "../../web/src/lib/guarded-reply.ts";
import { adapterFor } from "../../web/src/lib/harness/index.ts";
import { isUploadPath } from "../../web/src/lib/upload-path.ts";
import { uploadDirs } from "../uploads.ts";
import type { PaneAction, PaneRouteRequest, Services } from "./context.ts";
import { json, jsonError, secure, text } from "./http.ts";
import { MAX_READ_LINES } from "./pane.ts";

const MAX_EXPECTED_PROMPT_CHARS = 8192;
const MAX_REPLY_REQUEST_ID_CHARS = 160;
const MAX_CLEAR_DRAFT_CHARS = 64 * 1024;
const PROMPT_BINDING_BLANK_LINE_HEADROOM = 6;

// Terminal writes are serialised per pane with queue delivery (PaneWrites): a saved message being
// typed must not interleave with a direct reply, key or interrupt. A page watching the pane sees what
// the write did on the watcher's typed cadence.
function exclusive(write: (ctx: Services, r: PaneRouteRequest) => Promise<Response>): PaneAction["handle"] {
  return async (ctx, r) => {
    const result = await ctx.input.run(r.rt.name, r.paneId, () => write(ctx, r));
    if (result.busy) return jsonError("A saved message is being delivered. Wait before using terminal controls.", 409, null);
    ctx.paneWatcher.wrote(r.rt.name, r.paneId);
    return result.value;
  };
}

/** Remember a message the operator sent, so the pane's next finish counts as a reply to them. Read off
 *  the body: a refused reply still answers 200 with `ok: false`. */
async function noteSent(res: Response, sent: () => void): Promise<Response> {
  const body = (await res.clone().json().catch(() => null)) as { ok?: unknown } | null;
  if (body?.ok === true) sent();
  return res;
}

export const replyPaneActions: Record<string, PaneAction> = {
  // The whole guarded send in one request. Not wrapped in `exclusive`: the ledger answers a retry of
  // a send already in flight or done before the lock is asked, and the send takes the lock itself.
  send: {
    level: "write",
    marksSeen: true,
    handle: async ({ cfg, audit, input, awaiting, agentStates, journals }, { req, rt, paneId, device }) =>
      noteSent(
        await sendPane(rt, cfg, input, paneId, req, audit, device, () => claudeLog(agentStates, journals, rt.name, paneId), () => agentStates.get(rt.name, paneId)),
        () => awaiting.sent(rt.name, paneId),
      ),
  },
  reply: {
    level: "write",
    marksSeen: true,
    handle: exclusive(async ({ cfg, audit, awaiting }, { req, rt, paneId, device }) =>
      noteSent(await replyPane(rt.herdr, cfg, paneId, req, audit, device, rt.name), () => awaiting.sent(rt.name, paneId))),
  },
  keys: {
    level: "write",
    marksSeen: true,
    handle: exclusive(({ cfg, audit }, { req, rt, paneId, device }) => keysPane(rt.herdr, cfg, paneId, req, audit, device, rt.name)),
  },
  // A file attached while typing into the terminal: its saved path, pasted as the terminal would.
  "paste-file": {
    level: "write",
    marksSeen: true,
    handle: exclusive(({ cfg, audit }, { req, rt, paneId, device }) => pasteFilePane(rt.herdr, cfg, paneId, req, audit, device, rt.name)),
  },
  // A draft in the agent's box, settled from the phone (ADR 0112, ADR 0114): taken over, discarded or
  // sent, only while the box still holds the text the phone showed.
  "clear-draft": {
    level: "write",
    marksSeen: true,
    handle: exclusive(({ cfg, audit }, { req, rt, paneId, device }) => clearDraftPane(rt.herdr, cfg, paneId, req, audit, device, rt.name)),
  },
  // What waits in the CLI's own queue, back to the phone to edit or drop (ADR 0118).
  "take-back": {
    level: "write",
    marksSeen: true,
    handle: exclusive(async ({ cfg, audit, queue }, { req, rt, paneId, device }) => {
      // Which rows wait there is read before Up: Claude logs the recall at once, and the journal may
      // call them recalled before the take-back ends.
      const waiting = await queue.waitingOn(rt.name, paneId).catch(() => null);
      const outcome = await takeBackQueue({ herdr: rt.herdr, paneId, readLines: cfg.readLines });
      // The rows it held are recalled in the same step, so no page draws them as waiting there. The box
      // is already empty: if the queue cannot say which rows they were, the words go back alone.
      const rows = outcome.ok && waiting ? await queue.recallOn(waiting, outcome.text).catch(() => null) : null;
      const answer = outcome.ok ? { ...outcome, ...(rows ?? {}) } : outcome;
      // The words' length, not the words.
      audit.record({ action: "queue.take-back", paneId, session: rt.name, device, detail: { done: outcome.ok, chars: outcome.ok ? outcome.text.length : 0 } });
      return json(answer, req.headers.get("accept-encoding"));
    }),
  },
  // Not wrapped in `exclusive`: a Stop tapped right after Send waits for the turn to start, and must
  // not hold the pane while the queue types that message. It takes the lock for the final read + key.
  interrupt: {
    level: "write",
    marksSeen: true,
    handle: ({ audit, input, queue, agentStates }, { req, rt, paneId, device }) => interruptPane({ rt, input, queue, audit, agentStates }, paneId, req, device),
  },
  "send-report": {
    level: "write",
    marksSeen: true,
    handle: async ({ audit }, { req, rt, paneId, device }) => secure(await reportUnsentReply(paneId, req, audit, device, rt.name)),
  },
};

/** Just the two one-shot RPCs a reply needs — real HerdrClient in the bridge, fake in tests. */
export interface ReplySender {
  sendPaneText(paneId: string, text: string): Promise<void>;
  sendPaneKeys(paneId: string, keys: string[]): Promise<void>;
}

/** Outcome of the two-step send. `textDelivered` is only meaningful on the failure branch. */
export type ReplyOutcome =
  | { ok: true; textDelivered: boolean }
  | { ok: false; error: string; textDelivered: boolean };

/**
 * The reply's two one-shot RPCs — type the text, then send the submit key(s) — as a pure function so
 * the partial-failure branch is unit-testable with a fake client. The important case: if the text
 * lands but the submit keypress fails, we surface a distinct, actionable error and `textDelivered:
 * true` so the client knows NOT to resend (which would duplicate the already-typed text). Pure +
 * exported.
 */
export type SleepFn = (ms: number) => Promise<void>;
const defaultSleep: SleepFn = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Pause between typing and Enter when nothing can watch the pane for the TUI to take the text. */
const REPLY_SETTLE_MS = 350;

/**
 * `observe` reads the pane's screen. With it, the pause between typing and Enter ends once the
 * screen has visibly changed and held (capped at the old 350 ms) instead of always taking 350 ms.
 */
export async function sendReplySteps(
  client: ReplySender,
  paneId: string,
  txt: string,
  submit: boolean,
  submitKeys: string[],
  sleep: SleepFn = defaultSleep,
  observe?: () => Promise<string>,
): Promise<ReplyOutcome> {
  let textDelivered = false;
  try {
    const settles = Boolean(txt && submit);
    const before = settles && observe ? await observe().catch(() => null) : null;
    if (txt) {
      await client.sendPaneText(paneId, txt);
      textDelivered = true;
    }
    if (submit) {
      if (settles) await (observe ? settleAfterType(observe, before, sleep) : sleep(REPLY_SETTLE_MS));
      await client.sendPaneKeys(paneId, submitKeys);
    }
    return { ok: true, textDelivered };
  } catch (err) {
    if (textDelivered && submit) {
      // Text is already in the pane — only the submit failed. Tell the operator to check/submit it
      // by hand rather than resend, and flag textDelivered so a resend-on-error UI can hold off.
      return {
        ok: false,
        textDelivered: true,
        error: "typed into the pane but not submitted — check the pane before resending",
      };
    }
    return { ok: false, textDelivered, error: (err as Error).message };
  }
}

const interruptLedger = new InterruptLedger();

/**
 * Stop the pane's running turn with its CLI's interrupt key (ADR 0066, 0067). The adapter decides
 * whether the agent has one; the pane's structured state (agent-state.ts) says whether a turn runs,
 * and the live screen only when no structured source knows the pane. `interruptTurn` presses once,
 * inside the pane's write lock, and the queue parks what Nenu still holds for that conversation.
 */
export async function interruptPane(
  ctx: {
    rt: Pick<SessionRuntime, "herdr" | "engine" | "name">;
    input: PaneWrites;
    queue: Pick<QueueService, "holdAfterStop">;
    audit: Pick<AuditLog, "record">;
    agentStates?: Pick<AgentStates, "fresh">;
  },
  paneId: string,
  req: Request,
  device: string | null,
  ledger = interruptLedger,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  const { herdr, engine, name: session } = ctx.rt;
  const body: unknown = await req.json().catch(() => null);
  const confirm = typeof body === "object" && body !== null && "confirm" in body && body.confirm === true;
  const pane = engine.current().agents.find((candidate) => candidate.paneId === paneId);
  const interrupt = pane ? adapterFor(pane.agent)?.interrupt : undefined;
  if (!pane || !interrupt) return json({ ok: false, code: "unsupported", error: "Nenu has no safe way to stop this agent." } satisfies InterruptResponse, ae);
  const name = AGENT_NAMES[pane.agent] ?? pane.agent;
  let structured: TurnState | undefined;
  // The first look re-checks which process owns the pane; the polls after it only re-read its files.
  let looks = 0;
  const outcome = await interruptTurn({
    // The screen as it is now, read the way the queue reads a composer (queue-readiness.ts).
    read: async () => (await herdr.readPane(paneId, "visible", 100, "ansi")).text,
    ...(ctx.agentStates ? { state: async () => (structured = await ctx.agentStates!.fresh(session, pane, herdr, { remap: looks++ === 0 })) } : {}),
    exclusive: (operation) => ctx.input.run(session, paneId, operation),
    async press(keys) {
      let sent = false;
      try {
        await herdr.sendPaneKeys(paneId, keys);
        sent = true;
      } finally {
        ctx.audit.record({ action: "agent.interrupt", paneId, session, device, detail: { keys, sent } });
      }
    },
    stopped: () => ctx.queue.holdAfterStop(session, paneId),
    sleep: defaultSleep,
    now: Date.now,
  }, interrupt, { name, confirm, ledger, pane: JSON.stringify([session, paneId]) });
  // Screen fallback only: Claude hides its interrupt hint while the box holds a draft, so a working
  // pane can read as idle when no session file says otherwise.
  if (!outcome.ok && outcome.code === "not_running" && pane.status === "working" && !structured)
    return json({ ...outcome, error: `${name} shows no turn to stop. If its input box holds a draft, clear it or press Esc in the terminal.` } satisfies InterruptResponse, ae);
  return json(outcome, ae);
}

const AGENT_NAMES: Record<string, string> = { claude: "Claude", codex: "Codex" };

export async function replyPane(
  herdr: HerdrClient,
  cfg: Config,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  let body: { text?: string; submit?: boolean; paste?: unknown; expected_prompt?: unknown; request_id?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  const expected = expectedPrompt(body);
  if (!expected.ok) return text("bad expected_prompt", 400);
  const txt = body.text ?? "";
  const submit = body.submit ?? true;
  if (typeof txt !== "string" || (body.paste !== undefined && typeof body.paste !== "boolean")) return text("bad paste body", 400);
  // A closing escape embedded in a paste would turn the remaining content back into keystrokes.
  if (body.paste && /[\x1b\x9b]/.test(txt)) return text("paste contains terminal escape sequences", 400);
  const wireText = body.paste && txt ? `\x1b[200~${txt}\x1b[201~` : txt;
  const requestId = body.request_id;
  if (requestId !== undefined && (typeof requestId !== "string" || requestId.length < 1 || requestId.length > MAX_REPLY_REQUEST_ID_CHARS || !/^[A-Za-z0-9._:-]+$/.test(requestId))) {
    return text("bad request_id", 400);
  }
  const ae = req.headers.get("accept-encoding");
  const binding = expected.present
    ? await checkPromptBinding(herdr, cfg, paneId, expected.value)
    : null;
  if (binding && !binding.ok) {
    audit.record({
      action: "reply",
      paneId,
      session,
      device,
      detail: {
        text: txt,
        submit,
        submitted: false,
        textDelivered: false,
        promptBinding: binding.audit,
      },
    });
    return promptBindingFailure(binding, ae);
  }
  const observe = async () => (await herdr.readPane(paneId, "recent", cfg.readLines, "ansi")).text;
  const operation = async (prior: ReplyOutcome | null): Promise<ReplyOutcome> => {
    // A retry of a failed attempt may find that attempt's text already typed (the ack failed after
    // the bytes reached the PTY). Look before typing a second copy. Text it delivered that is gone
    // from the box may have been submitted by an Enter whose ack was lost: never type it again.
    if (prior && txt) {
      const box = await boxCarries(herdr, cfg, paneId, txt);
      if (box === "carries") return sendReplySteps(herdr, paneId, "", submit, cfg.submitKeys).then((out) => ({ ...out, textDelivered: true }));
      if (box === "unknown") return { ok: false, textDelivered: prior.textDelivered, error: "Couldn't read the terminal to check the earlier attempt. Nothing was typed; check Terminal." };
      if (prior.textDelivered) return { ok: false, textDelivered: true, error: "The earlier attempt is no longer in the input box, so it may already have been sent. Nothing was typed; check Terminal." };
    }
    return sendReplySteps(herdr, paneId, wireText, submit, cfg.submitKeys, defaultSleep, observe);
  };
  const fingerprint = JSON.stringify([session, paneId, txt, submit, body.paste === true, expected.present ? expected.value : null]);
  const deduped = requestId === undefined
    ? { outcome: await operation(null), replayed: false }
    : await replyLedger.run(`${session}\0${paneId}\0${requestId}`, fingerprint, operation);
  if ("conflict" in deduped) return text("request_id payload mismatch", 409);
  const { outcome } = deduped;
  // Audit the attempt regardless of outcome — text may have landed even when the submit failed.
  audit.record({
    action: "reply",
    paneId,
    session,
    device,
    detail: {
      text: txt,
      submit,
      submitted: outcome.ok,
      textDelivered: outcome.textDelivered,
      ...(binding ? { promptBinding: binding.audit } : {}),
    },
  });
  if (outcome.ok) return json({ ok: true, ...(typeof requestId === "string" ? { requestId, ack: submit ? "submitted" as const : "typed" as const, replayed: deduped.replayed } : {}) } satisfies ActionResponse, ae);
  return json(
    { ok: false, error: outcome.error, textDelivered: outcome.textDelivered } satisfies ActionResponse,
    ae,
  );
}

const replyLedger = new WriteLedger<ReplyOutcome>((outcome) => outcome.ok);

/**
 * Whether the pane's input box already holds `txt`, as its adapter reads it. A pane with no adapter
 * cannot be read back, which is "unknown", the same as a read that fails.
 */
async function boxCarries(herdr: HerdrClient, cfg: Config, paneId: string, txt: string): Promise<"carries" | "absent" | "unknown"> {
  try {
    const adapter = adapterFor((await herdr.getPane(paneId)).agent ?? undefined);
    if (!adapter) return "unknown";
    const lines = splitLines(parseAnsi((await herdr.readPane(paneId, "recent", cfg.readLines, "ansi")).text));
    const draft = adapter.extractInputDraft(lines);
    return draftCarriesSend(txt, draft) || (draft !== null && adapter.draftCarriesSend?.(txt, draft)) ? "carries" : "absent";
  } catch {
    return "unknown";
  }
}

// ── POST /api/pane/:id/send ───────────────────────────────────────────────────────────────────────

/** A look at the log of the Claude session the pane runs, when its session file maps one (ADR 0076). */
export function claudeLog(agentStates: Pick<AgentStates, "claudeSessionId">, journals: Services["journals"], session: string, paneId: string): GuardedSendDeps["received"] {
  const sessionId = agentStates.claudeSessionId(session, paneId);
  const source = journals ? journalFor(journals, "claude")?.source : undefined;
  return sessionId && source ? claudeLogReader(() => source.resolve({ kind: "id", value: sessionId })) : undefined;
}

type SendRun = GuardedSendResult & { elapsedMs: number };
const sendLedger = new WriteLedger<SendRun>((run) => run.outcome.ok);

/** The body of a send, validated, or why it is not one. */
export function parseSendRequest(body: unknown): SendRequest | string {
  if (body === null || typeof body !== "object") return "bad body";
  const b = body as Record<string, unknown>;
  if (typeof b.text !== "string" || !b.text.trim()) return "bad text";
  if (typeof b.requestId !== "string" || b.requestId.length > MAX_REPLY_REQUEST_ID_CHARS || !/^[A-Za-z0-9._:-]+$/.test(b.requestId)) return "bad requestId";
  if (b.paste !== undefined && typeof b.paste !== "boolean") return "bad paste";
  if (b.expectedPrompt !== undefined && (typeof b.expectedPrompt !== "string" || b.expectedPrompt.length > MAX_EXPECTED_PROMPT_CHARS)) return "bad expectedPrompt";
  if (b.force !== undefined && typeof b.force !== "boolean") return "bad force";
  return {
    text: b.text,
    requestId: b.requestId,
    ...(b.paste !== undefined ? { paste: b.paste as boolean } : {}),
    ...(b.expectedPrompt !== undefined ? { expectedPrompt: b.expectedPrompt as string } : {}),
    ...(b.force === true ? { force: true } : {}),
  };
}

/**
 * One request, the whole guarded send (guarded-send.ts). A refusal is an answer, not a transport
 * failure: it comes back as a SendOutcome body on 409, which the client reads instead of throwing.
 * Waiting for a turn is the queue's job, so /send always types.
 */
export async function sendPane(
  rt: Pick<SessionRuntime, "name" | "herdr" | "poker">,
  cfg: Config,
  input: PaneWrites,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  log?: () => GuardedSendDeps["received"],
  turn?: GuardedSendDeps["turn"],
): Promise<Response> {
  let request: SendRequest | string;
  try {
    request = parseSendRequest(await req.json());
  } catch {
    request = "bad body";
  }
  if (typeof request === "string") return text(request, 400);
  const send = request;
  const ae = req.headers.get("accept-encoding");
  const key = `${rt.name}\0${paneId}\0send\0${send.requestId}`;
  const fingerprint = JSON.stringify([send.text, send.paste === true, send.expectedPrompt ?? null]);
  const result = await sendLedger.run(key, fingerprint, async (prior) => {
    const started = Date.now();
    const delivered = prior !== null && !prior.outcome.ok && prior.outcome.textDelivered;
    const received = log?.();
    const locked = await input.run(rt.name, paneId, () =>
      guardedSend(
        { herdr: rt.herdr, paneId, readLines: cfg.readLines, submitKeys: cfg.submitKeys, trigger: triggerFor(rt.poker), ...(received ? { received } : {}), ...(turn ? { turn } : {}) },
        send,
        prior ? { typeAttempted: prior.trace.typeAttempted, textDelivered: delivered, ...(prior.trace.typedAt !== undefined ? { typedAt: prior.trace.typedAt } : {}) } : undefined,
      ),
    );
    if (locked.busy) {
      return {
        outcome: { ok: false, requestId: send.requestId, stage: "preflight", error: "A saved message is being delivered. Wait before sending.", textDelivered: delivered, code: "busy" },
        trace: { ...(prior?.trace ?? emptyTrace()), phase: "preflight" },
        elapsedMs: Date.now() - started,
      } satisfies SendRun;
    }
    const run = { ...locked.value, elapsedMs: Date.now() - started };
    auditSend(audit, run, send.text, paneId, rt.name, device);
    return run;
  });
  if ("conflict" in result) return text("request_id payload mismatch", 409);
  const outcome: SendOutcome = result.outcome.outcome.ok && result.replayed ? { ...result.outcome.outcome, replayed: true } : result.outcome.outcome;
  return json(outcome, ae, outcome.ok ? 200 : 409);
}

function emptyTrace(): SendTrace {
  return { phase: "preflight", preflight: "skipped", attempts: [], typeAttempted: false, noEcho: false, draft: null, screen: null, unverified: false };
}

/**
 * One `reply` line per attempt, plus the `reply.unsent` account of one that did not go out. At a
 * password prompt the text is likely a secret, so only the fact is kept, as sendReportDetail does.
 */
function auditSend(audit: AuditLog, run: SendRun, txt: string, paneId: string, session: string, device: string | null): void {
  const { outcome, trace } = run;
  audit.record({
    action: "reply",
    paneId,
    session,
    device,
    detail: {
      ...(trace.noEcho ? { noEcho: true } : { text: txt }),
      submit: true,
      submitted: outcome.ok,
      textDelivered: outcome.ok || outcome.textDelivered,
      phase: trace.phase,
      ...(trace.unverified ? { unverified: true } : {}),
    },
  });
  if (outcome.ok) return;
  const detail = sendReportDetail({
    status: outcome.code === "not_ready" || trace.phase === "preflight" || trace.phase === "pre-type" ? "blocked" : trace.phase === "verify" ? "stalled" : "error",
    phase: trace.phase,
    error: outcome.error,
    preflight: trace.preflight,
    attempts: trace.attempts,
    elapsedMs: run.elapsedMs,
    noEcho: trace.noEcho,
    text: txt,
    ...(trace.draft !== null ? { draft: trace.draft } : {}),
    ...(trace.screen !== null ? { screen: trace.screen } : {}),
  });
  if (detail) audit.record({ action: "reply.unsent", paneId, session, device, detail });
}

/** POST `{ draft, action? }`: take over, discard or send the box's draft while it holds exactly `draft` (guarded-send.ts settleDraft). */
export async function clearDraftPane(
  herdr: HerdrClient,
  cfg: Config,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  let body: { draft?: unknown; action?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  if (typeof body.draft !== "string" || !body.draft.trim() || body.draft.length > MAX_CLEAR_DRAFT_CHARS) return text("bad draft", 400);
  const action = body.action ?? "take";
  if (action !== "take" && action !== "discard" && action !== "send") return text("bad action", 400);
  const outcome = await settleDraft({ herdr, paneId, readLines: cfg.readLines }, body.draft, action, cfg.submitKeys);
  // The draft's length, not its words: the box may hold what was never meant to be sent.
  audit.record({ action: action === "send" ? "draft.send" : "draft.clear", paneId, session, device, detail: { chars: body.draft.length, action, done: outcome.ok } });
  return json(outcome satisfies ActionResponse, req.headers.get("accept-encoding"));
}

/**
 * POST `{ path }`: paste one file Nenu saved (bridge/uploads.ts) into the pane while the operator types
 * into it (guarded-send.ts pasteFile). Only a path straight under an uploads directory: the route pastes
 * Nenu's own uploads, not text of the client's choosing.
 */
export async function pasteFilePane(
  herdr: HerdrClient,
  cfg: Config,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  let body: { path?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  const path = body.path;
  if (typeof path !== "string" || !isUploadPath(path) || !uploadDirs(cfg.stateDir).includes(dirname(path))) return text("bad path", 400);
  const outcome = await pasteFile({ herdr, paneId, readLines: cfg.readLines }, path);
  audit.record({ action: "paste-file", paneId, session, device, detail: { path, done: outcome.ok } });
  return json(outcome satisfies ActionResponse, req.headers.get("accept-encoding"));
}

export async function keysPane(
  herdr: HerdrClient,
  cfg: Config,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  let body: { keys?: unknown; expected_prompt?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return text("bad body", 400);
  }
  const expected = expectedPrompt(body);
  if (!expected.ok) return text("bad expected_prompt", 400);
  const keys = Array.isArray(body.keys) ? body.keys.filter((k): k is string => typeof k === "string") : [];
  if (keys.length === 0) return text("no keys", 400);
  const ae = req.headers.get("accept-encoding");
  const binding = expected.present
    ? await checkPromptBinding(herdr, cfg, paneId, expected.value)
    : null;
  if (binding && !binding.ok) {
    audit.record({
      action: "keys",
      paneId,
      session,
      device,
      detail: { keys, promptBinding: binding.audit },
    });
    return promptBindingFailure(binding, ae);
  }
  try {
    await herdr.sendPaneKeys(paneId, keys);
    audit.record({
      action: "keys",
      paneId,
      session,
      device,
      detail: { keys, ...(binding ? { promptBinding: binding.audit } : {}) },
    });
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    if (binding) {
      audit.record({
        action: "keys",
        paneId,
        session,
        device,
        detail: { keys, sent: false, promptBinding: binding.audit },
      });
    }
    return json({ ok: false, error: (err as Error).message } satisfies ActionResponse, ae);
  }
}

type ExpectedPrompt =
  | { ok: true; present: false }
  | { ok: true; present: true; value: string }
  | { ok: false };

function expectedPrompt(body: object): ExpectedPrompt {
  if (!Object.prototype.hasOwnProperty.call(body, "expected_prompt")) {
    return { ok: true, present: false };
  }
  const value = (body as { expected_prompt?: unknown }).expected_prompt;
  if (typeof value !== "string" || value.length > MAX_EXPECTED_PROMPT_CHARS) {
    return { ok: false };
  }
  return { ok: true, present: true, value };
}

type PromptBindingCheck =
  | {
      ok: true;
      audit: { checked: true; passed: true; expected: string };
    }
  | {
      ok: false;
      error: string;
      status: 409 | 502;
      code?: "prompt_changed";
      audit: {
        checked: true;
        passed: false;
        expected: string;
        reason: Extract<PromptBindingResult, { ok: false }>["reason"] | "read_failed";
      };
    };

// There is deliberately no expected_blocked flag. agent_status is not carried by pane.read, only by
// session.snapshot, so checking it would cost a second RPC before the write and widen the very
// window this feature exists to shrink. The region check already subsumes it: if the exact prompt
// text is still on screen, that prompt is still what the pane is showing.
async function checkPromptBinding(
  herdr: HerdrClient,
  cfg: Config,
  paneId: string,
  expected: string,
): Promise<PromptBindingCheck> {
  let fresh: PaneRead;
  try {
    const expectedRawLines = expected.split(/\r\n?|\n/).length;
    const bindingReadLines = Math.min(
      MAX_READ_LINES,
      Math.max(
        cfg.readLines,
        expectedRawLines + DEFAULT_PROMPT_TAIL_LINES + PROMPT_BINDING_BLANK_LINE_HEADROOM,
      ),
    );
    // Keep this coupled to readPane(): use its recent source and ANSI format so the bridge verifies
    // the same kind of pane data the GET handler serves. The line count deliberately does not follow
    // cfg.readLines alone because a small legal setting may not contain the expected region; include
    // room for the accepted tail and for blank separator lines that normalization drops.
    fresh = await herdr.readPane(paneId, "recent", bindingReadLines, "ansi");
  } catch (err) {
    return {
      ok: false,
      error: `herdr read failed: ${(err as Error).message}`,
      status: 502,
      audit: { checked: true, passed: false, expected, reason: "read_failed" },
    };
  }

  const result = verifyExpectedPrompt(fresh.text, expected);
  if (!result.ok) {
    return {
      ok: false,
      error: "prompt changed",
      status: 409,
      code: "prompt_changed",
      audit: { checked: true, passed: false, expected, reason: result.reason },
    };
  }

  // This is a mitigation, not a guarantee. The re-read and the send_keys are two separate herdr
  // RPCs, so a TOCTOU window remains by construction; it shrinks from seconds (poll interval + push
  // latency + human reaction time) to the few milliseconds between two local RPCs. It removes the
  // human-latency portion of the window, which is where essentially all of the real risk lives.
  // Closing the window completely would need a conditional-input primitive in herdr (send_keys with
  // a precondition rejected atomically server-side), which does not exist today.
  return { ok: true, audit: { checked: true, passed: true, expected } };
}

function promptBindingFailure(
  result: Extract<PromptBindingCheck, { ok: false }>,
  acceptEncoding: string | null,
): Response {
  return json(
    {
      ok: false,
      error: result.error,
      ...(result.code ? { code: result.code } : {}),
    } satisfies ActionResponse,
    acceptEncoding,
    result.status,
  );
}
