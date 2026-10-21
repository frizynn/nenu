import { describe, expect, it, setSystemTime, test } from "bun:test";
import { join } from "node:path";
import { freshAgentView, QueueService } from "./queue-service.ts";
import type { HerdrClient } from "./herdr-client.ts";
import type { AgentView } from "./types.ts";

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

it("trusts Codex's rollout over its painted cue when the bridge knows the rollout (ADR 0067)", async () => {
  const { queueReadiness } = await import("./queue-readiness.ts");
  const text = await repoFile("web/src/fixtures/panes/codex--v0159-busy.txt");
  const herdr = { readPane: async () => ({ pane_id: "pane", text, revision: 1, truncated: false }) };
  const closed = { running: false, source: "codex-rollout" as const };
  expect(await queueReadiness({ paneId: "pane", agent: "codex", status: "blocked", turn: closed }, herdr, "afterTurn")).toEqual({ ready: true, busy: false });
  const open = { running: true, source: "codex-rollout" as const };
  const idle = await repoFile("web/src/fixtures/panes/codex--v0157-idle.txt");
  const idleHerdr = { readPane: async () => ({ pane_id: "pane", text: idle, revision: 1, truncated: false }) };
  expect(await queueReadiness({ paneId: "pane", agent: "codex", status: "blocked", turn: open }, idleHerdr, "afterTurn")).toEqual({ ready: true, busy: true });
});

// Captured 2026-10-12 in a disposable Herdr 0.9.3: Claude 2.1.296 after its turn ended, a background
// agent still running. Herdr said working, the session file busy, and Enter started a new turn at once.
it("does not hold a row for background work alone: only a running turn holds it (ADR 0067)", async () => {
  const { queueReadiness } = await import("./queue-readiness.ts");
  const text = await repoFile("web/src/lib/harness/claude/fixtures/background-agent-v2296.txt");
  const herdr = { readPane: async () => ({ pane_id: "pane", text, revision: 1, truncated: false }) };
  const background = { running: false, background: true, source: "claude-session" as const };
  expect(await queueReadiness({ paneId: "pane", agent: "claude", status: "working", turn: background }, herdr, "afterTurn")).toEqual({ ready: true, busy: false });
  expect(await queueReadiness({ paneId: "pane", agent: "claude", status: "working", turn: background }, herdr, "asap")).toEqual({ ready: true, busy: false });
  const running = { running: true, source: "claude-session" as const };
  expect(await queueReadiness({ paneId: "pane", agent: "claude", status: "working", turn: running }, herdr, "afterTurn")).toEqual({ ready: false, reason: "working" });
});

it("holds a row while Claude's own state reports a dialog, without reading the screen", async () => {
  const { queueReadiness } = await import("./queue-readiness.ts");
  const herdr = { readPane: async () => { throw new Error("must not read"); } };
  const waiting = { running: false, waiting: "permission prompt", source: "claude-session" as const };
  expect(await queueReadiness({ paneId: "pane", agent: "claude", status: "working", turn: waiting }, herdr, "asap")).toEqual({ ready: false, reason: "dialog" });
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
async function agentPane(
  agent: "claude" | "codex",
  status: Status,
  { audited = true, logs }: { audited?: boolean; logs?: (typed: string) => string } = {},
) {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { HerdrClient } = await import("./herdr-client.ts");
  const codexBusy = await repoFile("web/src/fixtures/panes/codex--v0159-busy.txt");
  const codexDraft = await repoFile("web/src/lib/harness/codex/fixtures/busy-draft-v0160.txt");
  const pane = {
    status, seq: 1, session: "first", draft: "", events: 0, turn: undefined as import("./types.ts").TurnState | undefined,
    submitted: [] as string[], keys: [] as string[][], journal: [] as import("./journal/types.ts").NativeQueueEvent[],
    audit: [] as import("./audit.ts").AuditEntry[],
    /** What Claude's log holds for the last submitted message, when `logs` says what it keeps. */
    logged: null as string | null,
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
        ...(pane.turn ? { turn: pane.turn } : {}),
      },
      herdr, connected: true,
    }),
    async (_row, text, submit) => {
      if (submit) {
        pane.submitted.push(pane.draft);
        if (logs) pane.logged = logs(pane.draft);
        if (pane.status === "working") pane.journal.push({ kind: "enqueue", ts: new Date().toISOString(), content: pane.draft });
        pane.draft = "";
      } else pane.draft = text;
      return { ok: true };
    },
    undefined,
    () => { pane.events++; },
    {
      facts: async () => ({ queue: pane.journal }),
      audit: audited ? { record: (entry) => { pane.audit.push(entry); } } : null,
      ...(logs ? { log: () => async () => (pane.logged === null ? { kind: "none" as const } : { kind: "logged" as const, text: pane.logged }) } : {}),
    },
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

// ADR 0076 measured Claude 2.1.296 to 2.1.300 logging only the last 478 of 1 500 characters. A queued
// row is checked against the log as a direct send is.
it("a queued row Claude logs without its head stays in the queue as incomplete, not delivered", async () => {
  const long = "Keep the whole message. ".repeat(63);
  const t = await agentPane("claude", "idle", { logs: (typed) => typed.slice(1022) });
  try {
    const added = await t.add("one", long);
    expect(t.pane.submitted).toEqual([long]);
    expect(added.body.delivered).toEqual([]);
    expect(added.body.messages[0]).toMatchObject({ id: "one", state: "paused" });
    expect(added.body.messages[0].error).toContain(`incomplete: it logged ${long.slice(1022).trim().length} of ${long.length} characters`);
  } finally { await t.close(); }
});

it("a queued row Claude logs whole is delivered", async () => {
  const long = "Keep the whole message. ".repeat(63);
  const t = await agentPane("claude", "idle", { logs: (typed) => `\n\n<pasted_content id="75ce">\n${typed}\n</pasted_content id="75ce">\n` });
  try {
    const added = await t.add("one", long);
    expect(added.body.messages).toEqual([]);
    expect(added.body.delivered.map((row: { id: string }) => row.id)).toEqual(["one"]);
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

// Measured 2026-10-12: while a background agent runs, Herdr stays working and its state counter does
// not move when a delivered message starts a turn, so the second row waited the whole cap (~22 s).
it("the second Claude row sees the first one's turn start in Claude's own state when Herdr's counter stays put", async () => {
  const t = await agentPane("claude", "working");
  const background = { running: false, background: true, source: "claude-session" as const };
  t.pane.turn = background;
  try {
    await t.add("one", "First");
    await t.settle(() => t.pane.submitted.length === 1);
    const second = await t.add("two", "Second");
    expect(second.body.messages[0]).toMatchObject({ id: "two", waitingFor: "turn-start" });
    t.pane.turn = { running: true, source: "claude-session" }; // the turn started; seq and status did not move
    t.service.kick();
    await Bun.sleep(30);
    expect((await t.call()).body.messages[0]).toMatchObject({ id: "two", waitingFor: "working" });
    t.pane.turn = background;
    t.service.kick();
    await t.settle(() => t.pane.submitted.length === 2);
    expect(t.pane.submitted).toEqual(["First", "Second"]);
    expect(t.pane.seq).toBe(1);
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

describe("freshAgentView", () => {
  const original = { paneId: "w1:p1", agent: "claude", status: "idle", agentSession: { kind: "id", value: "old" } } as AgentView;
  const herdrWith = (pane: Record<string, unknown> | Error) => ({
    calls: 0,
    async getPane(paneId: string) {
      this.calls++;
      expect(paneId).toBe("w1:p1");
      if (pane instanceof Error) throw pane;
      return pane as unknown as Awaited<ReturnType<HerdrClient["getPane"]>>;
    },
  });

  test("reads the one pane and carries Herdr's status and session ref", async () => {
    const herdr = herdrWith({ pane_id: "w1:p1", agent: "claude", agent_status: "working", agent_session: { kind: "id", value: "new", agent: "claude" } });
    expect(await freshAgentView(herdr, original)).toMatchObject({ status: "working", agentSession: { kind: "id", value: "new" } });
    expect(herdr.calls).toBe(1);
  });

  test("drops a session ref another agent reported", async () => {
    const herdr = herdrWith({ pane_id: "w1:p1", agent: "claude", agent_status: "idle", agent_session: { kind: "id", value: "x", agent: "codex" } });
    expect((await freshAgentView(herdr, original))?.agentSession).toBeUndefined();
  });

  test("is null when the pane is gone or now runs another agent", async () => {
    expect(await freshAgentView(herdrWith(new Error("herdr pane.get: pane_not_found: no pane w1:p1")), original)).toBeNull();
    expect(await freshAgentView(herdrWith({ pane_id: "w1:p1", agent: "codex", agent_status: "idle" }), original)).toBeNull();
  });

  test("any other Herdr failure still rejects", async () => {
    await expect(freshAgentView(herdrWith(new Error("herdr pane.get: timed out after 5000ms")), original)).rejects.toThrow("timed out");
  });
});

// ADR 0118: a take-back brought Claude's queue back into its box. The rows it held are recalled in the
// same step, so no page draws them as waiting in Claude's queue while the journal catches up.
it("recalls the rows Claude's queue held on a take-back, and says whether the words are exactly theirs", async () => {
  const t = await agentPane("claude", "working");
  try {
    await t.add("one", "primero", "asap");
    await t.settle(() => t.pane.submitted.length === 1);
    await t.add("two", "segundo\ncon dos líneas", "asap");
    await t.settle(() => t.pane.submitted.length === 2);
    t.service.kick();
    await Bun.sleep(30);
    expect((await t.call()).body.delivered.map((row: { native?: string }) => row.native)).toEqual(["enqueued", "enqueued"]);
    // Claude hands them back on one line each; the box reads them joined by spaces.
    const back = await t.service.recallOn((await t.service.waitingOn("session", "pane"))!, "primero segundo con dos líneas");
    expect(back).toEqual({ ours: true, messages: [{ id: "one", text: "primero" }, { id: "two", text: "segundo\ncon dos líneas" }] });
    expect((await t.call()).body.delivered.filter((row: { native?: string }) => row.native === "enqueued")).toEqual([]);
    expect(await t.service.waitingOn("session", "pane")).toEqual([]);
  } finally { await t.close(); }
});

it("recalls a row Claude's queue held for longer than ten minutes, and only rows whose words came back", async () => {
  const t = await agentPane("claude", "working");
  try {
    await t.add("one", "primero", "asap");
    await t.settle(() => t.pane.submitted.length === 1);
    await t.add("two", "segundo", "asap");
    await t.settle(() => t.pane.submitted.length === 2);
    t.service.kick();
    await Bun.sleep(30);
    // A long build: Claude reads its queue only after the step it is on.
    setSystemTime(new Date(Date.now() + 11 * 60_000));
    // Claude had read "primero" already; only "segundo" came back.
    expect(await t.service.recallOn((await t.service.waitingOn("session", "pane"))!, "segundo")).toEqual({ ours: true, messages: [{ id: "two", text: "segundo" }] });
    const natives = (await t.call()).body.delivered.map((row: { id: string; native?: string }) => [row.id, row.native]);
    expect(natives).toEqual([["one", "enqueued"], ["two", "recalled"]]);
  } finally {
    setSystemTime();
    await t.close();
  }
});

// Claude's queue is first in, first out: what came back ends with the newest rows that waited.
it("matches what came back from its end, newest first, and never past the rows that waited", async () => {
  const t = await agentPane("claude", "working");
  try {
    for (const [id, text] of [["one", "ok"], ["two", "si"], ["three", "decisión final"], ["four", "ok"]] as const) {
      await t.add(id, text, "asap");
      await t.settle(() => t.pane.submitted.includes(text) && t.pane.submitted.filter((s) => s === text).length === (id === "four" ? 2 : 1));
    }
    t.service.kick();
    await Bun.sleep(30);
    const waiting = (await t.service.waitingOn("session", "pane"))!;
    // "ok" and "si" were read long ago and never confirmed; the queue held the last two.
    expect(await t.service.recallOn(waiting, "decisión final ok")).toEqual({ ours: true, messages: [{ id: "three", text: "decisión final" }, { id: "four", text: "ok" }] });
    const natives = Object.fromEntries((await t.call()).body.delivered.map((row: { id: string; native?: string }) => [row.id, row.native]));
    expect(natives).toEqual({ one: "enqueued", two: "enqueued", three: "recalled", four: "recalled" });
  } finally { await t.close(); }
});

// Claude logs popAll as Up lands; the journal may call the rows recalled before the take-back reads
// them. The rows read before Up are still the take-back's.
it("keeps the rows read before Up when the journal recalled them first", async () => {
  const t = await agentPane("claude", "working");
  try {
    await t.add("one", "primero", "asap");
    await t.settle(() => t.pane.submitted.length === 1);
    t.service.kick();
    await Bun.sleep(30);
    const waiting = (await t.service.waitingOn("session", "pane"))!;
    t.pane.journal.push({ kind: "popAll", ts: new Date().toISOString() });
    t.service.kick();
    await Bun.sleep(30);
    expect((await t.call()).body.delivered[0]).toMatchObject({ id: "one", native: "recalled" });
    expect(await t.service.recallOn(waiting, "primero")).toEqual({ ours: true, messages: [{ id: "one", text: "primero" }] });
  } finally { await t.close(); }
});

// Delivered a moment ago, the row's enqueue is not in the journal yet: its words still say it came back.
it("takes back a row Claude's queue holds before the journal says so, and never one it read", async () => {
  const t = await agentPane("claude", "working");
  try {
    await t.add("one", "leído", "asap");
    await t.settle(() => t.pane.submitted.length === 1);
    t.pane.journal.push({ kind: "dequeue", ts: new Date().toISOString() });
    t.service.kick();
    await Bun.sleep(30);
    await t.add("two", "recién", "asap");
    await t.settle(() => t.pane.submitted.length === 2);
    const waiting = (await t.service.waitingOn("session", "pane"))!;
    expect(waiting.map((row) => row.id)).toContain("two");
    expect(await t.service.recallOn(waiting, "recién")).toEqual({ ours: true, messages: [{ id: "two", text: "recién" }] });
    const natives = Object.fromEntries((await t.call()).body.delivered.map((row: { id: string; native?: string }) => [row.id, row.native]));
    expect(natives.two).toBe("recalled");
    expect(natives.one).not.toBe("recalled");
  } finally { await t.close(); }
});
