import type { AuditLog } from "./audit.ts";
import { stripAnsi } from "./journal/text.ts";

// The client's account of a guarded send that did NOT end in "sent".
//
// The type-then-verify guard runs in the browser (web/src/lib/guarded-reply.ts): it types, re-reads
// the pane, and withholds the submit key when it can't see the text. The bridge only ever saw the
// unsubmitted type call succeed, so a stalled send left no trace anywhere but the phone's screen.
// This turns that outcome into one `reply.unsent` audit line carrying what is needed to tell the
// causes apart later: which phase gave up, what each verification read saw (or that it failed), the
// last draft the adapter extracted and a short tail of the last screen.
//
// Everything here is client-supplied, so nothing is trusted: enums are checked against the values
// the guard can produce, and every size is bounded again on this side.

/** Largest body accepted. A well-formed report is a few hundred bytes to ~3 KiB. */
export const SEND_REPORT_MAX_BODY = 16 * 1024;

const STATUSES = new Set(["blocked", "stalled", "error"]);
/** Where the send gave up: the pre-flight refused, the pre-type clear failed, the type call failed,
 *  verification ran out of attempts, or the submit key failed. */
const PHASES = new Set(["preflight", "pre-type", "type", "verify", "submit"]);
const PREFLIGHT_READS = new Set(["skipped", "read-failed", "no-composer", "composer"]);
/** One verification read: it threw, its screen could not be parsed, or it succeeded and saw no
 *  composer / an empty input box / a draft that was not the message. */
const VERIFY_READS = new Set(["read-failed", "unreadable", "no-composer", "empty-draft", "other-draft"]);

const MAX_ATTEMPTS = 16;
const MAX_SCREEN_LINES = 15;
const MAX_LINE_CHARS = 120;
const MAX_SCREEN_BYTES = 2048;
const MAX_ELAPSED_MS = 10 * 60_000;

const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

const plain = (value: string): string => stripAnsi(value).replace(CONTROL_CHARS, " ");

/** The last lines of the screen as plain text, newest kept when the byte budget runs out. */
function screenTail(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const lines = value
    .filter((line): line is string => typeof line === "string")
    .slice(-MAX_SCREEN_LINES)
    .map((line) => plain(line).trimEnd().slice(0, MAX_LINE_CHARS));
  let bytes = lines.reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
  while (lines.length > 0 && bytes > MAX_SCREEN_BYTES) bytes -= Buffer.byteLength(lines.shift()!) + 1;
  return lines;
}

/**
 * Validate and bound an untrusted report into the audit `detail`, or null when it is not a report.
 * Pure — the string previews are cut once more by the audit formatter, which also redacts them in
 * `COLLIE_AUDIT_CONTENT=none` mode (only the enum fields are on its metadata allowlist).
 *
 * `noEcho` means a read saw a password prompt: the fact is kept, the message, draft and screen are
 * dropped here regardless of what the client sent.
 */
export function sendReportDetail(body: unknown): Record<string, unknown> | null {
  if (body === null || typeof body !== "object") return null;
  const report = body as Record<string, unknown>;
  if (typeof report.status !== "string" || !STATUSES.has(report.status)) return null;
  if (typeof report.phase !== "string" || !PHASES.has(report.phase)) return null;

  const detail: Record<string, unknown> = {
    status: report.status,
    phase: report.phase,
    error: typeof report.error === "string" ? plain(report.error) : "",
  };
  if (typeof report.preflight === "string" && PREFLIGHT_READS.has(report.preflight)) detail.preflight = report.preflight;
  detail.attempts = (Array.isArray(report.attempts) ? report.attempts : [])
    .filter((read): read is string => typeof read === "string" && VERIFY_READS.has(read))
    .slice(0, MAX_ATTEMPTS);
  if (typeof report.elapsedMs === "number" && Number.isFinite(report.elapsedMs)) {
    detail.elapsedMs = Math.min(MAX_ELAPSED_MS, Math.max(0, Math.round(report.elapsedMs)));
  }
  detail.noEcho = report.noEcho === true;
  if (detail.noEcho) return detail;

  if (typeof report.text === "string") detail.text = report.text;
  if (typeof report.draft === "string") detail.draft = plain(report.draft);
  detail.screen = screenTail(report.screen);
  return detail;
}

/** POST /api/pane/:id/send-report — a write-level route; the caller has already run the gate. */
export async function reportUnsentReply(
  paneId: string,
  req: Request,
  audit: AuditLog,
  device: string | null,
  session: string,
): Promise<Response> {
  if (Number(req.headers.get("content-length") ?? 0) > SEND_REPORT_MAX_BODY) return new Response("report too large", { status: 413 });
  const raw = await req.text();
  if (Buffer.byteLength(raw) > SEND_REPORT_MAX_BODY) return new Response("report too large", { status: 413 });
  let detail: Record<string, unknown> | null;
  try {
    detail = sendReportDetail(JSON.parse(raw));
  } catch {
    detail = null;
  }
  if (!detail) return new Response("bad report", { status: 400 });
  audit.record({ action: "reply.unsent", paneId, session, device, detail });
  return Response.json({ ok: true });
}
