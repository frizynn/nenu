import { describe, expect, it } from "bun:test";
import { join } from "node:path";
import { QueueService } from "./queue-service.ts";

const repoFile = (path: string) => Bun.file(join(import.meta.dirname, "..", path)).text();

describe("unavailable queue", () => {
  const service = new QueueService(
    "/tmp/nenu-unavailable-queue-test",
    async () => null,
    async () => {
      throw new Error("Must not write");
    },
  );
  it("reports availability for reads", async () => {
    const response = await service.handle(
      new Request("http://localhost/queue"),
      "session",
      "pane",
      null,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ available: false, messages: [] });
  });
  it("rejects writes so the caller retains its draft", async () => {
    const response = await service.handle(
      new Request("http://localhost/queue", { method: "POST" }),
      "session",
      "pane",
      null,
    );
    expect(response.status).toBe(409);
  });
});

it("refuses a stale conversation scope when the live session changes before enqueue", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { HerdrClient } = await import("./herdr-client");
  const { computeEtag } = await import("./http-cache");
  const dir = await mkdtemp(join(tmpdir(), "nenu-queue-live-"));
  const cached = {
    paneId: "pane",
    workspaceId: "workspace",
    workspaceLabel: "test",
    workspaceNumber: 1,
    tabId: "tab",
    agent: "claude",
    status: "idle" as const,
    cwd: "/tmp",
    focused: true,
    agentSession: { kind: "id" as const, value: "old" },
  };
  const service = new QueueService(
    dir,
    async (_session, _pane, fresh) => ({
      pane: fresh
        ? { ...cached, agentSession: { kind: "id", value: "new" } }
        : cached,
      herdr: new HerdrClient("/tmp/unused-qa.sock"),
      connected: true,
    }),
    async () => ({ ok: true }),
  );
  try {
    const scope = computeEtag(
      JSON.stringify(["session", "pane", "claude:old"]),
    );
    const response = await service.handle(
      new Request("http://localhost/queue", {
        method: "POST",
        body: JSON.stringify({
          action: "add",
          id: "saved",
          scope,
          text: "Preserve this draft",
        }),
      }),
      "session",
      "pane",
      null,
    );
    expect(response.status).toBe(409);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("delivers a saved message when status is blocked but the live composer is empty", async () => {
  const { queueReadiness } = await import("./queue-readiness.ts");
  const text = await repoFile("web/src/fixtures/panes/codex--v0157-idle.txt");
  const herdr = { readPane: async () => ({ pane_id: "pane", text, revision: 1, truncated: false }) };
  expect(await queueReadiness({ paneId: "pane", agent: "codex", status: "blocked" }, herdr, "steer")).toEqual({ ready: true, busy: false });
});

it("does not mistake a blocked-status busy Codex composer for an idle terminal", async () => {
  const { queueReadiness } = await import("./queue-readiness.ts");
  const text = await repoFile("web/src/fixtures/panes/codex--v0159-busy.txt");
  const herdr = { readPane: async () => ({ pane_id: "pane", text, revision: 1, truncated: false }) };
  // Busy, so a next-turn row goes to Codex's own queue (Tab) rather than steering the turn.
  expect(await queueReadiness({ paneId: "pane", agent: "codex", status: "blocked" }, herdr, "afterTurn")).toEqual({ ready: true, busy: true });
});

it("attempts an explicit Codex message immediately while the agent is working", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { HerdrClient } = await import("./herdr-client.ts");
  const dir = await mkdtemp(join(tmpdir(), "nenu-explicit-send-"));
  let reads = 0;
  class Terminal extends HerdrClient {
    override async readPane() {
      reads++;
      return { pane_id: "pane", text: "A dialog owns this terminal", revision: 1, truncated: false };
    }
  }
  const service = new QueueService(dir, async () => ({
    pane: { paneId: "pane", workspaceId: "workspace", workspaceLabel: "QA", workspaceNumber: 1, tabId: "tab", agent: "codex", status: "working", cwd: "/tmp", focused: false, agentSession: { kind: "id", value: "active" } },
    connected: true, herdr: new Terminal("/tmp/unused.sock"),
  }), async () => { throw new Error("Must not type into a dialog"); });
  try {
    const scope = (await (await service.handle(new Request("http://localhost/queue"), "session", "pane", null)).json()).scope;
    await service.handle(new Request("http://localhost/queue", { method: "POST", body: JSON.stringify({ action: "add", id: "saved", scope, text: "An explicit reply" }) }), "session", "pane", null);
    await Bun.sleep(30);
    expect(reads).toBeGreaterThan(0);
    const response = await service.handle(new Request("http://localhost/queue"), "session", "pane", null);
    const body = await response.json();
    expect(body.messages[0].state).toBe("queued");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it("a kick during a delivery pass runs exactly one more pass afterwards", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { MessageQueue } = await import("./message-queue");
  const dir = await mkdtemp(join(tmpdir(), "nenu-queue-kick-"));
  // One queued row in storage, so every pass has something to resolve.
  await new MessageQueue(join(dir, "message-queue.json")).add({ id: "m", scope: "x", session: "s", paneId: "p", conversation: "claude:x", agent: "claude", text: "Hi", device: null });
  let resolves = 0;
  let release = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const service = new QueueService(dir, async () => { resolves++; await gate; return null; }, async () => ({ ok: true }));
  try {
    service.kick();
    await Bun.sleep(20);
    service.kick();
    service.kick();
    release();
    await Bun.sleep(50);
    expect(resolves).toBe(2);
  } finally {
    service.dispose();
    await rm(dir, { recursive: true, force: true });
  }
});

// ── ADR 0056 behaviour through the service, against a scripted terminal ─────────────────────────────

type Status = "idle" | "working" | "blocked" | "done";
const RULE = "─".repeat(60);

/** One agent pane: a Claude- or Codex-shaped screen, Herdr's status and state counter, and a journal. */
async function agentPane(agent: "claude" | "codex", status: Status, { audited = true } = {}) {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { HerdrClient } = await import("./herdr-client.ts");
  const codexBusy = await repoFile("web/src/fixtures/panes/codex--v0159-busy.txt");
  const codexDraft = await repoFile("web/src/lib/harness/codex/fixtures/busy-draft-v0160.txt");
  const pane = {
    status, seq: 1, session: "first", draft: "", events: 0,
    submitted: [] as string[], keys: [] as string[][], journal: [] as import("./journal/types.ts").NativeQueueEvent[],
    audit: [] as import("./audit.ts").AuditEntry[],
  };
  const screen = () => {
    if (agent === "codex") return pane.draft ? codexDraft.replace("Also say BANANA at the end.", pane.draft) : codexBusy;
    const footer = pane.status === "working" ? "  ⏵⏵ auto mode on · esc to interrupt · ← for agents" : "  ⏵⏵ auto mode on · ← for agents";
    return [RULE, `❯ ${pane.draft}`, RULE, footer].join("\n");
  };
  class Terminal extends HerdrClient {
    override async readPane() { return { pane_id: "pane", text: screen(), revision: 1, truncated: false }; }
    override async getPane() { return { pane_id: "pane", agent } as Awaited<ReturnType<InstanceType<typeof HerdrClient>["getPane"]>>; }
    override async sendPaneKeys(_id: string, keys: string[]) {
      pane.keys.push(keys);
      if (keys[0] === "Tab") { pane.submitted.push(`tab:${pane.draft}`); pane.draft = ""; }
    }
    override async waitForOutput(): Promise<never> { throw new Error("no trigger in this test"); }
  }
  const herdr = new Terminal("/tmp/unused-queue.sock");
  const dir = await mkdtemp(join(tmpdir(), "nenu-queue-adr0056-"));
  const service = new QueueService(
    dir,
    async () => ({
      pane: {
        paneId: "pane", workspaceId: "w", workspaceLabel: "QA", workspaceNumber: 1, tabId: "t", agent, cwd: "/tmp", focused: false,
        status: pane.status, stateChangeSeq: pane.seq, agentSession: { kind: "id" as const, value: pane.session },
      },
      herdr, connected: true,
    }),
    async (_row, text, submit) => {
      if (submit) {
        pane.submitted.push(pane.draft);
        if (pane.status === "working") pane.journal.push({ kind: "enqueue", ts: new Date().toISOString(), content: pane.draft });
        pane.draft = "";
      } else pane.draft = text;
      return { ok: true };
    },
    undefined,
    () => { pane.events++; },
    { facts: async () => ({ queue: pane.journal }), audit: audited ? { record: (entry) => { pane.audit.push(entry); } } : null },
  );
  const call = async (body?: Record<string, unknown>) => {
    const res = await service.handle(new Request("http://localhost/queue", body ? { method: "POST", body: JSON.stringify(body) } : {}), "session", "pane", null);
    return { status: res.status, body: await res.json() };
  };
  const scope = async () => (await call()).body.scope as string;
  const add = async (id: string, text: string, deliveryMode?: string) => call({ action: "add", id, scope: await scope(), text, ...(deliveryMode ? { deliveryMode } : {}) });
  const settle = async (test: () => boolean) => {
    for (let i = 0; i < 100 && !test(); i++) await Bun.sleep(10);
  };
  const close = async () => {
    service.dispose();
    const { rm } = await import("node:fs/promises");
    await rm(dir, { recursive: true, force: true });
  };
  return { pane, service, call, add, scope, settle, close };
}

it("Claude 'asap' types into a working Claude, and a second message reaches its queue too", async () => {
  const t = await agentPane("claude", "working");
  try {
    await t.add("one", "First while you work", "asap");
    await t.settle(() => t.pane.submitted.length === 1);
    await t.add("two", "Second while you work", "asap");
    await t.settle(() => t.pane.submitted.length === 2);
    expect(t.pane.submitted).toEqual(["First while you work", "Second while you work"]);
  } finally { await t.close(); }
});

it("a Claude row for after the turn waits, says why, and costs no write while it waits", async () => {
  const t = await agentPane("claude", "working");
  try {
    const added = await t.add("one", "After this turn");
    expect(added.body.messages[0]).toMatchObject({ state: "queued", waitingFor: "working", deliveryMode: "afterTurn", revision: 0 });
    const events = t.pane.events;
    for (let i = 0; i < 10; i++) { t.service.kick(); await Bun.sleep(5); }
    await Bun.sleep(30);
    expect(t.pane.events).toBe(events);
    expect((await t.call()).body.messages[0]).toMatchObject({ waitingFor: "working", revision: 0 });
    expect(t.pane.submitted).toEqual([]);
  } finally { await t.close(); }
});

it("the second Claude row waits for Herdr to see the first one's turn start (state_change_seq)", async () => {
  const t = await agentPane("claude", "idle");
  try {
    const first = await t.add("one", "First");
    // An add to a free agent answers once its row moved, here already typed and sent.
    expect(first.body.delivered.map((row: { id: string }) => row.id)).toEqual(["one"]);
    const second = await t.add("two", "Second");
    expect(second.body.messages[0]).toMatchObject({ id: "two", waitingFor: "turn-start" });
    t.pane.seq = 2; // the turn started
    t.pane.status = "working";
    t.service.kick();
    await Bun.sleep(30);
    expect((await t.call()).body.messages[0]).toMatchObject({ id: "two", waitingFor: "working" });
    t.pane.seq = 3;
    t.pane.status = "idle";
    t.service.kick();
    await t.settle(() => t.pane.submitted.length === 2);
    expect(t.pane.submitted).toEqual(["First", "Second"]);
  } finally { await t.close(); }
});

it("a steer into a working Codex starts no turn, so the next 'after the turn' row goes to Codex's queue at once", async () => {
  const t = await agentPane("codex", "working");
  try {
    await t.add("one", "codex steer", "steer");
    await t.settle(() => t.pane.submitted.length === 1);
    expect(t.pane.submitted).toEqual(["codex steer"]);
    const second = await t.add("two", "codex next turn");
    expect(second.body.messages[0]?.waitingFor).not.toBe("turn-start");
    await t.settle(() => t.pane.submitted.length === 2);
    expect(t.pane.submitted).toEqual(["codex steer", "tab:codex next turn"]);
  } finally { await t.close(); }
});

it("a row whose conversation changed is stranded with its reason, shown on the pane and never sent", async () => {
  const t = await agentPane("claude", "working");
  try {
    await t.add("one", "For the old conversation");
    t.pane.session = "second";
    t.service.kick();
    await Bun.sleep(30);
    t.pane.status = "idle";
    t.service.kick();
    await Bun.sleep(30);
    const listed = (await t.call()).body.messages[0];
    expect(listed).toMatchObject({ id: "one", stranded: { reason: expect.stringContaining("conversation") } });
    expect(listed.error).toContain("conversation");
    expect(t.pane.submitted).toEqual([]);
  } finally { await t.close(); }
});

it("Claude's journal marks a delivered row queued then read, and 'read it now' asks first", async () => {
  const t = await agentPane("claude", "working");
  try {
    await t.add("one", "Look at this when you can", "asap");
    await t.settle(() => t.pane.submitted.length === 1);
    t.service.kick();
    await Bun.sleep(30);
    let delivered = (await t.call()).body.delivered;
    expect(delivered[0]).toMatchObject({ id: "one", native: "enqueued" });
    const scope = await t.scope();
    const unconfirmed = await t.call({ action: "now", id: "one", scope });
    expect(unconfirmed).toMatchObject({ status: 409, body: { code: "confirm_required" } });
    expect(t.pane.keys).toEqual([]);
    const confirmed = await t.call({ action: "now", id: "one", scope, confirm: true });
    expect(confirmed.status).toBe(200);
    expect(t.pane.keys).toEqual([["ctrl+enter"]]);
    expect(t.pane.audit).toEqual([{ action: "queue.now", paneId: "pane", session: "session", device: null, detail: { keys: ["ctrl+enter"], sent: true } }]);
    t.pane.journal.push({ kind: "dequeue", ts: new Date().toISOString() });
    t.service.kick();
    await Bun.sleep(30);
    delivered = (await t.call()).body.delivered;
    expect(delivered[0]).toMatchObject({ id: "one", native: "absorbed" });
  } finally { await t.close(); }
});

// Measured 2026-10-10 on the live bridge: "Read it now" pressed Ctrl+Enter twice 0.9 s apart, before
// Claude's journal showed the message read, and a later tap was answered 409 "unsupported".
it("'read it now' presses Ctrl+Enter once per row: a repeat, before or after Claude reads it, answers the page", async () => {
  const t = await agentPane("claude", "working");
  try {
    await t.add("one", "Look at this when you can", "asap");
    await t.settle(() => t.pane.submitted.length === 1);
    t.service.kick();
    await Bun.sleep(30);
    const scope = await t.scope();
    const now = () => t.call({ action: "now", id: "one", scope, confirm: true });
    expect((await now()).status).toBe(200);
    const repeat = await now();
    expect(repeat.status).toBe(200);
    expect(t.pane.keys).toEqual([["ctrl+enter"]]);
    expect(repeat.body.delivered[0]).toMatchObject({ id: "one", native: "enqueued", readNowAt: expect.any(Number) });
    t.pane.journal.push({ kind: "dequeue", ts: new Date().toISOString() });
    t.service.kick();
    await Bun.sleep(30);
    const afterRead = await now();
    expect(afterRead.status).toBe(200);
    expect(afterRead.body.delivered[0]).toMatchObject({ id: "one", native: "absorbed" });
    expect(t.pane.keys).toEqual([["ctrl+enter"]]);
  } finally { await t.close(); }
});

it("Codex 'afterTurn' while a turn runs goes to Codex's own queue with Tab; 'steer' with Enter", async () => {
  const t = await agentPane("codex", "working");
  try {
    await t.add("later", "After this turn, run the tests.", "afterTurn");
    await t.settle(() => t.pane.submitted.length === 1);
    expect(t.pane.submitted).toEqual(["tab:After this turn, run the tests."]);
    expect(t.pane.audit).toMatchObject([{ action: "queue.submit", paneId: "pane", detail: { keys: ["Tab"], sent: true } }]);
    await t.add("now", "Also check the lint.", "steer");
    await t.settle(() => t.pane.submitted.length === 2);
    expect(t.pane.submitted[1]).toBe("Also check the lint.");
  } finally { await t.close(); }
});

it("rejects an unknown delivery mode", async () => {
  const t = await agentPane("claude", "idle");
  try {
    expect((await t.add("bad", "Hi", "whenever")).status).toBe(400);
  } finally { await t.close(); }
});

it("a Codex row sent without a mode lands after the turn, in Codex's own queue", async () => {
  const t = await agentPane("codex", "working");
  try {
    await t.add("plain", "Then update the docs.");
    await t.settle(() => t.pane.submitted.length === 1);
    expect(t.pane.submitted).toEqual(["tab:Then update the docs."]);
  } finally { await t.close(); }
});

it("without an audit trail the queue presses no key of its own: Codex waits for the turn", async () => {
  const t = await agentPane("codex", "working", { audited: false });
  try {
    const added = await t.add("later", "After this turn.", "afterTurn");
    expect(added.body.messages[0]).toMatchObject({ id: "later", waitingFor: "working" });
    expect(t.pane.keys).toEqual([]);
  } finally { await t.close(); }
});
