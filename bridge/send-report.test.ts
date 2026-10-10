import { describe, expect, test } from "bun:test";

import { AuditLog } from "./audit.ts";
import { SEND_REPORT_MAX_BODY, reportUnsentReply, sendReportDetail } from "./send-report.ts";

// A guarded send that ends in anything but "sent" used to exist only on the phone's screen. These
// pin what the bridge keeps of it: enough to tell a connection stall from an unseen draft, bounded
// and redacted like the rest of the trail.

const stalled = {
  status: "stalled",
  phase: "verify",
  error: "The message wasn't seen in the agent's input box.",
  text: "deploy the thing",
  preflight: "composer",
  attempts: ["read-failed", "unreadable", "no-composer", "empty-draft", "other-draft"],
  draft: "an unrelated leftover",
  screen: ["some output", "❯ an unrelated leftover"],
  elapsedMs: 2841.6,
};

function recorder(content?: "preview" | "none") {
  const lines: string[] = [];
  const audit = new AuditLog((line) => void lines.push(line), { now: () => 0, content });
  return { audit, entries: () => lines.map((line) => JSON.parse(line) as { action: string; paneId: string; session: string; device?: string; detail: Record<string, unknown> }) };
}

const post = (body: unknown) =>
  new Request("http://127.0.0.1/api/pane/w1%3Ap1/send-report", {
    method: "POST",
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("sendReportDetail", () => {
  test("keeps the cause: status, phase, every read's outcome, last draft and screen tail", () => {
    expect(sendReportDetail(stalled)).toEqual({
      status: "stalled",
      phase: "verify",
      error: stalled.error,
      preflight: "composer",
      attempts: ["read-failed", "unreadable", "no-composer", "empty-draft", "other-draft"],
      elapsedMs: 2842,
      noEcho: false,
      text: "deploy the thing",
      draft: "an unrelated leftover",
      screen: ["some output", "❯ an unrelated leftover"],
    });
  });

  test("accepts the bridge guard's confirm phase: Enter went out and the box kept the text", () => {
    expect(sendReportDetail({ ...stalled, status: "error", phase: "confirm" })).toMatchObject({ status: "error", phase: "confirm" });
  });

  test("refuses a report whose status or phase is not one the guard produces", () => {
    expect(sendReportDetail({ ...stalled, status: "sent" })).toBeNull();
    expect(sendReportDetail({ ...stalled, phase: "somewhere" })).toBeNull();
    expect(sendReportDetail("nope")).toBeNull();
    expect(sendReportDetail(null)).toBeNull();
  });

  test("a password prompt is recorded as a fact and never as content", () => {
    const detail = sendReportDetail({ ...stalled, noEcho: true, text: "hunter2hunter2", screen: ["[sudo] password for fran:"] })!;
    expect(detail.noEcho).toBe(true);
    expect(detail).not.toHaveProperty("text");
    expect(detail).not.toHaveProperty("draft");
    expect(detail).not.toHaveProperty("screen");
  });

  test("bounds the screen tail to its last lines, strips terminal escapes, and caps its bytes", () => {
    const many = Array.from({ length: 40 }, (_, i) => `\x1b[31mline ${i}\x1b[0m\x07`);
    const tail = sendReportDetail({ ...stalled, screen: many })!.screen as string[];
    expect(tail).toHaveLength(15);
    expect(tail[0]).toBe("line 25");
    expect(tail.at(-1)).toBe("line 39");

    const wide = Array.from({ length: 15 }, () => "字".repeat(500));
    const capped = sendReportDetail({ ...stalled, screen: wide })!.screen as string[];
    expect(capped.every((line) => line.length <= 120)).toBe(true);
    expect(Buffer.byteLength(capped.join("\n"))).toBeLessThanOrEqual(2048);
    // The newest lines are the ones that survive a byte squeeze.
    expect(capped.length).toBeGreaterThan(0);
    expect(capped.length).toBeLessThan(15);
  });

  test("drops read outcomes it does not know and caps how many it keeps", () => {
    const detail = sendReportDetail({ ...stalled, preflight: "weird", attempts: [...Array(40).fill("read-failed"), "bogus", 7] })!;
    expect(detail).not.toHaveProperty("preflight");
    expect(detail.attempts).toEqual(Array(16).fill("read-failed"));
  });
});

describe("reportUnsentReply", () => {
  test("appends one reply.unsent entry attributed to the pane, session and device", async () => {
    const { audit, entries } = recorder();
    const res = await reportUnsentReply("w1:p1", post(stalled), audit, "phone", "default");
    expect(res.status).toBe(200);
    expect(entries()).toEqual([
      {
        ts: "1970-01-01T00:00:00.000Z",
        action: "reply.unsent",
        paneId: "w1:p1",
        session: "default",
        device: "phone",
        detail: sendReportDetail(stalled),
      } as never,
    ]);
  });

  test("a redacted trail keeps the diagnosis and none of the content", async () => {
    const { audit, entries } = recorder("none");
    await reportUnsentReply("w1:p1", post(stalled), audit, null, "default");
    expect(entries()[0]!.detail).toMatchObject({
      status: "stalled",
      phase: "verify",
      preflight: "composer",
      attempts: ["read-failed", "unreadable", "no-composer", "empty-draft", "other-draft"],
      text: "⟨redacted⟩",
      draft: "⟨redacted⟩",
      error: "⟨redacted⟩",
      screen: ["⟨redacted⟩", "⟨redacted⟩"],
    });
  });

  test("rejects a malformed or oversized body without writing anything", async () => {
    const { audit, entries } = recorder();
    expect((await reportUnsentReply("w1:p1", post("{not json"), audit, null, "default")).status).toBe(400);
    expect((await reportUnsentReply("w1:p1", post({ status: "sent", phase: "verify" }), audit, null, "default")).status).toBe(400);
    const huge = { ...stalled, screen: ["x".repeat(SEND_REPORT_MAX_BODY)] };
    expect((await reportUnsentReply("w1:p1", post(huge), audit, null, "default")).status).toBe(413);
    expect(entries()).toEqual([]);
  });
});
