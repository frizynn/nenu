import type { AuditLog } from "../audit.ts";
import type { Config } from "../config.ts";
import type { HerdrClient, PaneRead } from "../herdr-client.ts";
import {
  DEFAULT_PROMPT_TAIL_LINES,
  verifyExpectedPrompt,
  type PromptBindingResult,
} from "../prompt-binding.ts";
import { reportUnsentReply } from "../send-report.ts";
import type { StateEngine } from "../state-engine.ts";
import type { ActionResponse } from "../types.ts";
import { hasCodexInterruptCue } from "../../web/src/lib/harness/codex/interrupt.ts";
import type { PaneAction, PaneRouteRequest, Services } from "./context.ts";
import { json, jsonError, secure, text } from "./http.ts";
import { MAX_READ_LINES } from "./pane.ts";

const MAX_EXPECTED_PROMPT_CHARS = 8192;
const MAX_REPLY_REQUEST_ID_CHARS = 160;
const PROMPT_BINDING_BLANK_LINE_HEADROOM = 6;

// Terminal writes are serialised per pane with queue delivery (PaneWrites): a saved message being
// typed must not interleave with a direct reply, key or interrupt.
function exclusive(write: (ctx: Services, r: PaneRouteRequest) => Promise<Response>): PaneAction["handle"] {
  return async (ctx, r) => {
    const result = await ctx.input.run(r.rt.name, r.paneId, () => write(ctx, r));
    return result.busy ? jsonError("A saved message is being delivered. Wait before using terminal controls.", 409, null) : result.value;
  };
}

export const replyPaneActions: Record<string, PaneAction> = {
  reply: {
    level: "write",
    marksSeen: true,
    handle: exclusive(({ cfg, audit }, { req, rt, paneId, device }) => replyPane(rt.herdr, cfg, paneId, req, audit, device, rt.name)),
  },
  keys: {
    level: "write",
    marksSeen: true,
    handle: exclusive(({ cfg, audit }, { req, rt, paneId, device }) => keysPane(rt.herdr, cfg, paneId, req, audit, device, rt.name)),
  },
  interrupt: {
    level: "write",
    marksSeen: true,
    handle: exclusive(({ cfg, audit }, { req, rt, paneId, device }) => interruptCodexPane(rt.herdr, rt.engine, cfg, paneId, req, audit, device, rt.name)),
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
/** Pause between typing and Enter so the TUI accepts the submit key (preview-action polls ~350ms). */
const REPLY_SETTLE_MS = 350;

export async function sendReplySteps(
  client: ReplySender,
  paneId: string,
  txt: string,
  submit: boolean,
  submitKeys: string[],
  sleep: SleepFn = defaultSleep,
): Promise<ReplyOutcome> {
  let textDelivered = false;
  try {
    if (txt) {
      await client.sendPaneText(paneId, txt);
      textDelivered = true;
    }
    if (submit) {
      if (txt) await sleep(REPLY_SETTLE_MS);
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

/**
 * Interrupt one active Codex turn through the transport Nenu actually owns: Herdr's terminal key
 * API. This is deliberately narrower than a generic key sender. A stale mobile snapshot must not
 * turn a late Stop tap into Escape at an idle composer or a dialog, so we require both Herdr's
 * Codex identity and a just-read, renderer-shaped interrupt cue before
 * sending. The live pane read is the decisive stale-tap check; the pane classification narrows the
 * action to the intended harness.
 */
export async function interruptCodexPane(
  herdr: HerdrClient,
  engine: StateEngine,
  cfg: Config,
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  const ae = req.headers.get("accept-encoding");
  const pane = engine.current().agents.find((candidate) => candidate.paneId === paneId);
  if (!pane || pane.agent !== "codex") {
    return json({ ok: false, error: "Codex is no longer generating" } satisfies ActionResponse, ae);
  }

  let live: PaneRead;
  try {
    live = await herdr.readPane(
      paneId,
      "recent",
      Math.min(MAX_READ_LINES, Math.max(cfg.readLines, 120)),
      "ansi",
    );
  } catch (err) {
    return json({ ok: false, error: `herdr read failed: ${(err as Error).message}` } satisfies ActionResponse, ae);
  }
  if (!hasCodexInterruptCue(live.text)) {
    return json({ ok: false, error: "Codex is no longer showing an interruptible turn" } satisfies ActionResponse, ae);
  }

  try {
    await herdr.sendPaneKeys(paneId, ["Escape"]);
    audit.record({
      action: "agent.interrupt",
      paneId,
      session,
      device,
      detail: { keys: ["Escape"], sent: true },
    });
    return json({ ok: true } satisfies ActionResponse, ae);
  } catch (err) {
    audit.record({
      action: "agent.interrupt",
      paneId,
      session,
      device,
      detail: { keys: ["Escape"], sent: false },
    });
    return json({ ok: false, error: (err as Error).message } satisfies ActionResponse, ae);
  }
}

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
  const operation = () => sendReplySteps(herdr, paneId, wireText, submit, cfg.submitKeys);
  const fingerprint = JSON.stringify([session, paneId, txt, submit, body.paste === true, expected.present ? expected.value : null]);
  const deduped = requestId === undefined
    ? { outcome: await operation(), replayed: false }
    : await runReplyOnce(`${session}\0${paneId}\0${requestId}`, fingerprint, operation);
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

type ReplyLedgerEntry = { fingerprint: string; promise: Promise<ReplyOutcome>; expires: number };
const replyLedger = new Map<string, ReplyLedgerEntry>();
const REPLY_LEDGER_TTL_MS = 10 * 60_000;
const REPLY_LEDGER_MAX = 512;

async function runReplyOnce(key: string, fingerprint: string, operation: () => Promise<ReplyOutcome>): Promise<{ outcome: ReplyOutcome; replayed: boolean } | { conflict: true }> {
  const now = Date.now();
  for (const [candidate, entry] of replyLedger) if (entry.expires <= now) replyLedger.delete(candidate);
  const existing = replyLedger.get(key);
  if (existing) {
    if (existing.fingerprint !== fingerprint) return { conflict: true };
    return { outcome: await existing.promise, replayed: true };
  }
  const promise = operation();
  replyLedger.set(key, { fingerprint, promise, expires: now + REPLY_LEDGER_TTL_MS });
  while (replyLedger.size > REPLY_LEDGER_MAX) replyLedger.delete(replyLedger.keys().next().value!);
  return { outcome: await promise, replayed: false };
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
