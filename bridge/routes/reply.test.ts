import { describe, expect, test } from "bun:test";

import { AuditLog } from "../audit.ts";
import type { Config } from "../config.ts";
import type { HerdrClient, PaneRead } from "../herdr-client.ts";
import { PaneWrites } from "../pane-writes.ts";
import type { SessionRuntime } from "../sessions.ts";
import { replyPane, sendPane } from "./reply.ts";

// The two write routes as the phone uses them: the one-request send, and the older reply route that
// the browser guard and the queue still call. Each test uses its own pane id, because the request-id
// ledgers live for the bridge's lifetime.

const RULE = "─".repeat(60);
const cfg = { readLines: 200, submitKeys: ["Enter"] } as Config;

/** A Claude input box in memory, recording every Herdr call. */
class Box {
  agent = "claude";
  draft = "";
  dialog: string | null = null;
  /** Typed text shows up at the next read, the way a TUI repaints after the write. */
  pending = "";
  failKeys = 0;
  /** Enter lands, then the ack is lost. */
  failKeysAfterLanding = 0;
  readonly submitted: string[] = [];
  failTextAfterLanding = 0;
  failReads = false;
  readonly calls: Array<{ method: string; arg?: unknown }> = [];

  screen(): string {
    if (this.dialog) return ["output", RULE, this.dialog].join("\n");
    return ["output", "", RULE, `❯ ${this.draft}`, RULE, "  Opus 5.5 | Context 13% used"].join("\n");
  }
  async getPane(paneId: string) {
    this.calls.push({ method: "pane.get" });
    return { pane_id: paneId, agent: this.agent };
  }
  async readPane(paneId: string): Promise<PaneRead> {
    this.calls.push({ method: "pane.read" });
    if (this.failReads) throw new Error("herdr request timed out");
    this.draft += this.pending;
    this.pending = "";
    return { pane_id: paneId, text: this.screen(), truncated: false, revision: 0 };
  }
  async sendPaneText(_paneId: string, text: string) {
    this.calls.push({ method: "pane.send_text", arg: text });
    if (!this.dialog) this.pending += text;
    if (this.failTextAfterLanding-- > 0) throw new Error("herdr request timed out");
  }
  async sendPaneKeys(_paneId: string, keys: string[]) {
    this.calls.push({ method: "pane.send_keys", arg: keys });
    if (this.failKeys-- > 0) throw new Error("herdr pane.send_keys: internal: lost");
    if (keys.includes("Enter") && !this.dialog) {
      if (this.draft) this.submitted.push(this.draft);
      this.draft = "";
    }
    if (this.failKeysAfterLanding-- > 0) throw new Error("herdr request timed out");
  }
  async waitForOutput() {
    this.calls.push({ method: "pane.wait_for_output" });
    return { matched: false as const };
  }
  count(method: string): number {
    return this.calls.filter((c) => c.method === method).length;
  }
}

function recorder() {
  const lines: Array<{ action: string; detail: Record<string, unknown> }> = [];
  return { audit: new AuditLog((line) => void lines.push(JSON.parse(line))), lines };
}

const post = (body: unknown) =>
  new Request("http://127.0.0.1/api/pane/x/send", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

const runtime = (box: Box) =>
  ({ name: "default", herdr: box as unknown as HerdrClient, poker: { onOutputWatchesRejected: () => () => {} } }) as unknown as SessionRuntime;

describe("POST send", () => {
  test("one request types, verifies and submits", async () => {
    const box = new Box();
    const { audit, lines } = recorder();
    const res = await sendPane(runtime(box), cfg, new PaneWrites(), "w1:send-ok", post({ text: "ship the release", requestId: "a1" }), audit, "phone");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, requestId: "a1", ack: "submitted" });
    expect(box.count("pane.send_text")).toBe(1);
    expect(box.calls.filter((c) => c.method === "pane.send_keys").map((c) => c.arg)).toEqual([["Enter"]]);
    expect(lines.map((l) => l.action)).toEqual(["reply"]);
    expect(lines[0]?.detail).toMatchObject({ submitted: true, textDelivered: true });
  });

  test("a retry of a delivered send is answered from the ledger and types nothing", async () => {
    const box = new Box();
    const { audit } = recorder();
    const writes = new PaneWrites();
    await sendPane(runtime(box), cfg, writes, "w1:send-replay", post({ text: "ship the release", requestId: "a2" }), audit, null);
    const retry = await sendPane(runtime(box), cfg, writes, "w1:send-replay", post({ text: "ship the release", requestId: "a2" }), audit, null);
    expect(await retry.json()).toEqual({ ok: true, requestId: "a2", ack: "submitted", replayed: true });
    expect(box.count("pane.send_text")).toBe(1);
    expect(box.count("pane.send_keys")).toBe(1);
  });

  test("a refused send is a 409 answer, audited, and a retry with the same id runs again", async () => {
    const box = new Box();
    box.dialog = "Do you want to proceed?\n❯ 1. Yes\n  2. No";
    const { audit, lines } = recorder();
    const writes = new PaneWrites();
    const refused = await sendPane(runtime(box), cfg, writes, "w1:send-retry", post({ text: "ship the release", requestId: "a3" }), audit, null);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ ok: false, requestId: "a3", stage: "preflight", code: "not_ready", textDelivered: false });
    expect(lines.map((l) => l.action)).toEqual(["reply", "reply.unsent"]);
    expect(lines[1]?.detail).toMatchObject({ status: "blocked", phase: "preflight", preflight: "no-composer" });
    box.dialog = null;
    const retry = await sendPane(runtime(box), cfg, writes, "w1:send-retry", post({ text: "ship the release", requestId: "a3" }), audit, null);
    expect(await retry.json()).toEqual({ ok: true, requestId: "a3", ack: "submitted" });
    expect(box.count("pane.send_text")).toBe(1);
  });

  test("a send refused at a password prompt never writes the typed text to the audit log", async () => {
    const box = new Box();
    box.dialog = "[sudo] password for user:";
    const { audit, lines } = recorder();
    const res = await sendPane(runtime(box), cfg, new PaneWrites(), "w1:send-noecho", post({ text: "MyS3cretPass", requestId: "a12" }), audit, "phone");
    expect(await res.json()).toMatchObject({ ok: false, stage: "preflight", textDelivered: false });
    expect(box.count("pane.send_text")).toBe(0);
    expect(lines.map((l) => l.action)).toEqual(["reply", "reply.unsent"]);
    expect(lines[0]?.detail).toMatchObject({ noEcho: true, submitted: false });
    expect(JSON.stringify(lines)).not.toContain("MyS3cretPass");
  });

  test("a retry after an Enter whose ack was lost does not submit the message twice", async () => {
    const box = new Box();
    box.failKeysAfterLanding = 1;
    const { audit } = recorder();
    const writes = new PaneWrites();
    const first = await sendPane(runtime(box), cfg, writes, "w1:send-lost-enter", post({ text: "deploy now", requestId: "a10" }), audit, null);
    expect(await first.json()).toMatchObject({ ok: false, stage: "submit", textDelivered: true });
    const retry = await sendPane(runtime(box), cfg, writes, "w1:send-lost-enter", post({ text: "deploy now", requestId: "a10" }), audit, null);
    expect(await retry.json()).toMatchObject({ ok: false, textDelivered: true });
    expect(box.submitted).toEqual(["deploy now"]);
    expect(box.count("pane.send_text")).toBe(1);
  });

  test("a retry on a pane with no adapter does not type the message again", async () => {
    const box = new Box();
    box.agent = "pi";
    box.failKeys = 1;
    const { audit } = recorder();
    const writes = new PaneWrites();
    const first = await sendPane(runtime(box), cfg, writes, "w1:send-pi", post({ text: "deploy now", requestId: "a11" }), audit, null);
    expect(await first.json()).toMatchObject({ ok: false, textDelivered: true });
    const retry = await sendPane(runtime(box), cfg, writes, "w1:send-pi", post({ text: "deploy now", requestId: "a11" }), audit, null);
    expect(await retry.json()).toMatchObject({ ok: false, textDelivered: true });
    expect(box.count("pane.send_text")).toBe(1);
  });

  test("a stall records every read in the unsent line", async () => {
    const box = new Box();
    box.agent = "claude";
    box.sendPaneText = async (_p: string, text: string) => void box.calls.push({ method: "pane.send_text", arg: text });
    const { audit, lines } = recorder();
    const res = await sendPane(runtime(box), cfg, new PaneWrites(), "w1:send-stall", post({ text: "ship the release", requestId: "a4" }), audit, null);
    expect(await res.json()).toMatchObject({ ok: false, stage: "verify", textDelivered: true });
    expect(box.count("pane.send_keys")).toBe(0);
    const unsent = lines.find((l) => l.action === "reply.unsent")!;
    expect(unsent.detail).toMatchObject({ status: "stalled", phase: "verify", text: "ship the release" });
    expect((unsent.detail.attempts as string[]).length).toBeGreaterThan(1);
  });

  test("the same id with another text is a conflict; a malformed body is a 400", async () => {
    const box = new Box();
    const { audit } = recorder();
    const writes = new PaneWrites();
    await sendPane(runtime(box), cfg, writes, "w1:send-conflict", post({ text: "first", requestId: "a5" }), audit, null);
    const conflict = await sendPane(runtime(box), cfg, writes, "w1:send-conflict", post({ text: "second", requestId: "a5" }), audit, null);
    expect(conflict.status).toBe(409);
    for (const body of ["nope", { text: "", requestId: "a6" }, { text: "x", requestId: "bad id" }, { text: "x", requestId: "a8", expectedPrompt: "y".repeat(8193) }]) {
      expect((await sendPane(runtime(box), cfg, writes, "w1:send-conflict", post(body), audit, null)).status).toBe(400);
    }
    expect(box.count("pane.send_text")).toBe(1);
  });

  test("a pane already being written answers busy without touching it, and is not cached", async () => {
    const box = new Box();
    const { audit } = recorder();
    const writes = new PaneWrites();
    let release = () => {};
    const holding = writes.run("default", "w1:send-busy", () => new Promise<void>((resolve) => (release = resolve)));
    const busy = await sendPane(runtime(box), cfg, writes, "w1:send-busy", post({ text: "ship it now", requestId: "a9" }), audit, null);
    expect(busy.status).toBe(409);
    expect(await busy.json()).toMatchObject({ ok: false, code: "busy", textDelivered: false });
    expect(box.calls).toEqual([]);
    release();
    await holding;
    const retry = await sendPane(runtime(box), cfg, writes, "w1:send-busy", post({ text: "ship it now", requestId: "a9" }), audit, null);
    expect((await retry.json()).ok).toBe(true);
  });
});

describe("POST reply (kept for the browser guard and the queue)", () => {
  const reply = (box: Box, paneId: string, body: unknown) =>
    replyPane(box as unknown as HerdrClient, cfg, paneId, post(body), recorder().audit, null, "default");

  test("a failed submit retried with the same id presses the key again", async () => {
    const box = new Box();
    box.draft = "ready to go";
    box.failKeys = 1;
    const first = await reply(box, "w1:reply-submit", { text: "", submit: true, request_id: "d1:submit" });
    expect(await first.json()).toMatchObject({ ok: false });
    const retry = await reply(box, "w1:reply-submit", { text: "", submit: true, request_id: "d1:submit" });
    expect(await retry.json()).toMatchObject({ ok: true, ack: "submitted", replayed: false });
    expect(box.count("pane.send_keys")).toBe(2);
  });

  test("a failed type retried with the same id reads the box first and does not type a second copy", async () => {
    const box = new Box();
    box.failTextAfterLanding = 1;
    const first = await reply(box, "w1:reply-type", { text: "one durable message", submit: false, request_id: "d2:type" });
    expect(await first.json()).toMatchObject({ ok: false });
    const retry = await reply(box, "w1:reply-type", { text: "one durable message", submit: false, request_id: "d2:type" });
    expect(await retry.json()).toMatchObject({ ok: true, ack: "typed" });
    expect(box.count("pane.send_text")).toBe(1);
    expect(box.draft).toBe("one durable message");
  });

  test("a failed type whose text never landed is typed again on retry", async () => {
    const box = new Box();
    box.dialog = "Do you want to proceed?\n❯ 1. Yes";
    box.failTextAfterLanding = 1;
    await reply(box, "w1:reply-retype", { text: "one durable message", submit: false, request_id: "d3:type" });
    box.dialog = null;
    const retry = await reply(box, "w1:reply-retype", { text: "one durable message", submit: false, request_id: "d3:type" });
    expect(await retry.json()).toMatchObject({ ok: true, ack: "typed" });
    expect(box.count("pane.send_text")).toBe(2);
  });

  test("a retry after an Enter whose ack was lost does not submit the message twice", async () => {
    const box = new Box();
    box.failKeysAfterLanding = 1;
    const first = await reply(box, "w1:reply-lost-enter", { text: "deploy now", submit: true, request_id: "d5" });
    expect(await first.json()).toMatchObject({ ok: false, textDelivered: true });
    const retry = await reply(box, "w1:reply-lost-enter", { text: "deploy now", submit: true, request_id: "d5" });
    expect(await retry.json()).toMatchObject({ ok: false, textDelivered: true });
    expect(box.submitted).toEqual(["deploy now"]);
    expect(box.count("pane.send_text")).toBe(1);
  });

  test("a failed submit retried on a pane with no adapter does not type the message again", async () => {
    const box = new Box();
    box.agent = "pi";
    box.failKeys = 1;
    const first = await reply(box, "w1:reply-pi", { text: "deploy now", submit: true, request_id: "d6" });
    expect(await first.json()).toMatchObject({ ok: false, textDelivered: true });
    const retry = await reply(box, "w1:reply-pi", { text: "deploy now", submit: true, request_id: "d6" });
    expect(await retry.json()).toMatchObject({ ok: false, textDelivered: true });
    expect(box.count("pane.send_text")).toBe(1);
  });

  test("a failed submit retried while the text is still in the box presses Enter without retyping", async () => {
    const box = new Box();
    box.failKeys = 1;
    await reply(box, "w1:reply-resubmit", { text: "deploy now", submit: true, request_id: "d7" });
    const retry = await reply(box, "w1:reply-resubmit", { text: "deploy now", submit: true, request_id: "d7" });
    expect(await retry.json()).toMatchObject({ ok: true, ack: "submitted" });
    expect(box.submitted).toEqual(["deploy now"]);
    expect(box.count("pane.send_text")).toBe(1);
  });

  test("a failed type is not retyped while the box cannot be read", async () => {
    const box = new Box();
    box.failTextAfterLanding = 1;
    await reply(box, "w1:reply-unread", { text: "one durable message", submit: false, request_id: "d4:type" });
    box.failReads = true;
    const retry = await reply(box, "w1:reply-unread", { text: "one durable message", submit: false, request_id: "d4:type" });
    expect(await retry.json()).toMatchObject({ ok: false, textDelivered: false });
    expect(box.count("pane.send_text")).toBe(1);
  });

  test("text plus submit presses Enter once the screen shows the text, well inside the old 350 ms", async () => {
    const box = new Box();
    box.agent = "pi";
    const started = performance.now();
    const res = await reply(box, "w1:reply-oneshot", { text: "hello pi", submit: true });
    const elapsed = performance.now() - started;
    expect(await res.json()).toMatchObject({ ok: true });
    expect(box.calls.map((c) => c.method)).toEqual(["pane.read", "pane.send_text", "pane.read", "pane.read", "pane.send_keys"]);
    expect(elapsed).toBeLessThan(250);
  });
});
