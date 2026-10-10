import type { SendOutcome, SendRequest } from "./types.ts";

// The whole guarded send in one bridge call: preflight, sweep, type, verify against the adapter,
// re-read, Enter, confirm (ADR 0010, 0023, 0048). Stub: no route calls it yet; routes/reply.ts will.
export async function guardedSend(request: SendRequest): Promise<SendOutcome> {
  return { ok: false, requestId: request.requestId, stage: "preflight", error: "Guarded send is not available yet.", textDelivered: false };
}
