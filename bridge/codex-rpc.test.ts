import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";
import { CodexRpc, CodexRpcError, type CodexListener, type CodexMessage } from "./codex-rpc.ts";
import { CodexLive, codexRequestHint } from "./codex-live.ts";
import type { AgentView, LiveEvent } from "./types.ts";

test("real Unix WebSocket handshakes once and reconnects without replaying failed requests", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-rpc-"));
  const socket = join(dir, "server.sock");
  const server = createServer();
  const websocket = new WebSocketServer({ server });
  const methods: string[] = [];
  websocket.on("connection", (connection) => connection.on("message", (bytes) => {
    const request = JSON.parse(bytes.toString());
    methods.push(request.method);
    if (request.method === "drop") { connection.terminate(); return; }
    if (request.id) connection.send(JSON.stringify({ id: request.id, result: { ok: true } }));
  }));
  const client = new CodexRpc(socket);
  try {
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const results = await Promise.all([client.request("thread/list"), client.request("thread/read")]);
    expect(results).toEqual([{ ok: true }, { ok: true }]);
    expect(methods.filter((method) => method === "initialize")).toHaveLength(1);
    await expect(client.request("drop")).rejects.toThrow("unavailable");
    expect(await client.request("thread/list")).toEqual({ ok: true });
    expect(methods.filter((method) => method === "drop")).toHaveLength(1);
    expect(methods.filter((method) => method === "initialize")).toHaveLength(2);
  } finally {
    client.close();
    for (const connection of websocket.clients) connection.terminate();
    websocket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("dispatches notifications and server requests, never answers them, and opts out of deltas", async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-rpc-"));
  const socket = join(dir, "server.sock");
  const server = createServer();
  const websocket = new WebSocketServer({ server });
  const received: Array<Record<string, unknown>> = [];
  websocket.on("connection", (connection) => connection.on("message", (bytes) => {
    const message = JSON.parse(bytes.toString());
    received.push(message);
    if (message.method === "initialize") connection.send(JSON.stringify({ id: message.id, result: {} }));
    if (message.method === "thread/resume") {
      connection.send(JSON.stringify({ method: "thread/status/changed", params: { threadId: "t", status: { type: "active", activeFlags: ["waitingOnApproval"] } } }));
      connection.send(JSON.stringify({ id: 0, method: "item/commandExecution/requestApproval", params: { threadId: "t", command: "rm -rf build" } }));
      connection.send(JSON.stringify({ id: message.id, result: { thread: {} } }));
    }
    if (message.method === "drop") connection.terminate();
  }));
  const client = new CodexRpc(socket);
  const heard: CodexMessage[] = [];
  let closed = 0;
  const stop = client.listen({ message: (m) => heard.push(m), closed: () => { closed++; } });
  try {
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    await client.request("thread/resume", { threadId: "t" });
    expect(heard).toEqual([
      { method: "thread/status/changed", params: { threadId: "t", status: { type: "active", activeFlags: ["waitingOnApproval"] } } },
      { method: "item/commandExecution/requestApproval", params: { threadId: "t", command: "rm -rf build" }, id: 0 },
    ]);
    const init = received.find((m) => m.method === "initialize") as { params: { capabilities: { optOutNotificationMethods: string[] } } };
    expect(init.params.capabilities.optOutNotificationMethods).toContain("item/agentMessage/delta");
    await Bun.sleep(20);
    // Only requests went out: no reply to the server's approval request (id 0).
    expect(received.every((m) => typeof m.method === "string")).toBe(true);
    await expect(client.request("drop")).rejects.toThrow("unavailable");
    expect(closed).toBe(1);
  } finally {
    stop();
    client.close();
    for (const connection of websocket.clients) connection.terminate();
    websocket.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

// Messages shaped like the 0.162 app-server bindings (v2/ServerNotification.ts, ServerRequest.ts).
describe("CodexLive", () => {
  const thread = "11111111-2222-3333-4444-555555555555";
  const pane: AgentView = { paneId: "p1", workspaceId: "w1", workspaceLabel: "QA", workspaceNumber: 1, tabId: "t1", focused: false, agent: "codex", status: "working", cwd: "/tmp", agentSession: { kind: "id", value: thread } };

  function harness(opts: { status?: string; queued?: number; queueError?: CodexRpcError; resume?: boolean } = {}) {
    let clock = 1_000;
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const events: LiveEvent[] = [];
    let listener: CodexListener | null = null;
    const rpc = {
      listen(l: CodexListener) { listener = l; return () => { listener = null; }; },
      async request(method: string, params?: Record<string, unknown>) {
        calls.push([method, params]);
        if (method === "thread/read") return { thread: { id: thread, status: { type: opts.status ?? "idle" } } };
        if (method === "thread/queue/list") {
          if (opts.queueError) throw opts.queueError;
          return { data: Array.from({ length: opts.queued ?? 0 }, () => ({})), nextCursor: null };
        }
        if (method === "thread/resume") return { thread: { id: thread, status: { type: "active", activeFlags: [] } } };
        return {};
      },
    };
    const changed: string[] = [];
    const live = new CodexLive({ publish: (e) => events.push(e) }, rpc, () => clock, { resume: opts.resume ?? true, changed: (id) => changed.push(id) });
    const methods = () => calls.map(([m]) => m);
    const send = (m: CodexMessage) => listener!.message(m);
    return { live, calls, methods, events, changed, send, tick: (ms: number) => { clock += ms; }, close: () => listener?.closed?.() };
  }
  const settle = () => Bun.sleep(0);

  test("stays dormant unless resuming was enabled, since ADR 0022 forbids it", async () => {
    const h = harness({ resume: false });
    h.live.observe("default", pane);
    await settle();
    expect(h.calls).toEqual([]);
    expect(h.live.view("default", "p1")).toBeNull();
  });

  test("a --no-daemon pane is never resumed or queued against", async () => {
    const h = harness({ status: "notLoaded" });
    h.live.observe("default", pane);
    await settle();
    expect(h.methods()).toEqual(["thread/read"]);
    h.live.observe("default", pane);
    await settle();
    expect(h.methods()).toEqual(["thread/read"]);
    h.tick(30_000);
    h.live.observe("default", pane);
    await settle();
    expect(h.methods()).toEqual(["thread/read", "thread/read"]);
    expect(h.live.view("default", "p1")?.subscribed).toBe(false);
    h.live.close();
  });

  test("never resumes a thread with queued input, since resuming dispatches it", async () => {
    const h = harness({ queued: 1 });
    h.live.observe("default", pane);
    await settle();
    expect(h.methods()).toEqual(["thread/read", "thread/queue/list"]);
    const old = harness({ queueError: new CodexRpcError("Method not found", -32601) });
    old.live.observe("default", pane);
    await settle();
    expect(old.methods()).toContain("thread/resume");
    const broken = harness({ queueError: new CodexRpcError("Internal error", -32603) });
    broken.live.observe("default", pane);
    await settle();
    expect(broken.methods()).not.toContain("thread/resume");
    for (const x of [h, old, broken]) x.live.close();
  });

  test("subscribes to a running thread and turns its events into names, hints and a view", async () => {
    const h = harness();
    h.live.observe("default", pane);
    await settle();
    expect(h.calls.find(([m]) => m === "thread/resume")?.[1]).toEqual({ threadId: thread, excludeTurns: true });
    expect(h.live.view("default", "p1")).toMatchObject({ subscribed: true, status: "active", waitingOn: [] });
    h.events.length = 0;

    h.send({ method: "item/completed", params: { threadId: thread, turnId: "turn", item: { id: "i", type: "agentMessage", text: "hi" } } });
    h.send({ method: "item/completed", params: { threadId: "99999999-2222-3333-4444-555555555555", turnId: "x", item: {} } });
    expect(h.events).toEqual([{ session: "default", topic: "journal", paneId: "p1" }]);
    expect(h.changed).toEqual([thread]);

    h.send({ method: "thread/status/changed", params: { threadId: thread, status: { type: "active", activeFlags: ["waitingOnApproval"] } } });
    h.send({ id: 7, method: "item/commandExecution/requestApproval", params: { threadId: thread, turnId: "turn", itemId: "c", reason: "Needs network", command: "curl example.com" } });
    expect(h.live.view("default", "p1")?.waitingOn).toEqual(["waitingOnApproval"]);
    expect(h.live.hints("default", "p1")).toEqual([{ source: "codex-rpc", observedAt: 1_000, question: "Needs network", detail: "curl example.com" }]);
    expect(h.events.map((e) => e.topic)).toEqual(["journal", "pane", "interaction", "interaction"]);
    h.send({ method: "serverRequest/resolved", params: { threadId: thread, requestId: 7 } });
    expect(h.live.hints("default", "p1")).toEqual([]);

    h.send({ method: "turn/plan/updated", params: { threadId: thread, turnId: "turn", explanation: null, plan: [{ step: "Read", status: "completed" }, { step: "Fix", status: "inProgress" }] } });
    h.send({ method: "turn/diff/updated", params: { threadId: thread, turnId: "turn", diff: "--- a\n+++ b\n" } });
    h.send({ method: "thread/tokenUsage/updated", params: { threadId: thread, turnId: "turn", tokenUsage: {
      total: { totalTokens: 1200, inputTokens: 1000, cachedInputTokens: 400, cacheWriteInputTokens: 0, outputTokens: 200, reasoningOutputTokens: 50 },
      last: { totalTokens: 300, inputTokens: 250, cachedInputTokens: 0, cacheWriteInputTokens: 0, outputTokens: 50, reasoningOutputTokens: 10 },
      modelContextWindow: 258_000 } } });
    const view = h.live.view("default", "p1")!;
    expect(view.plan).toEqual({ turnId: "turn", steps: [{ step: "Read", status: "completed" }, { step: "Fix", status: "inProgress" }] });
    expect(view.diff).toEqual({ turnId: "turn", diff: "--- a\n+++ b\n", truncated: false });
    expect(view.telemetry).toMatchObject({ tokens: { scope: "session", input: 1000, output: 200, cachedInput: 400, total: 1200 }, context: { usedTokens: 300, windowTokens: 258_000 } });
    // Observing never writes to the thread.
    expect(h.methods().filter((m) => !["thread/read", "thread/queue/list", "thread/resume"].includes(m))).toEqual([]);
    h.live.close();
  });

  test("leaves a thread nobody looked at for the grace period, and resubscribes after a reconnect", async () => {
    const h = harness();
    h.live.observe("default", pane);
    await settle();
    h.close();
    expect(h.live.view("default", "p1")?.subscribed).toBe(false);
    h.live.observe("default", pane);
    await settle();
    expect(h.methods().filter((m) => m === "thread/resume")).toHaveLength(2);
    h.tick(61_000);
    await h.live.sweep();
    expect(h.methods().at(-1)).toBe("thread/unsubscribe");
    expect(h.live.view("default", "p1")).toBeNull();
    h.live.close();
  });

  test("ignores shells, Claude panes and panes without a native id", () => {
    const h = harness();
    h.live.observe("default", { ...pane, agent: "claude" });
    h.live.observe("default", { ...pane, agentSession: undefined });
    h.live.observe("default", { ...pane, agentSession: { kind: "id", value: "../etc" } });
    expect(h.calls).toEqual([]);
  });
});

test("approval and question requests become hints with their full text", () => {
  expect(codexRequestHint("item/tool/requestUserInput", { questions: [{ id: "q", header: "H", question: "Which DB?", options: [{ label: "Postgres", description: "" }, { label: "SQLite", description: "" }] }] }, 5))
    .toEqual({ source: "codex-rpc", observedAt: 5, question: "Which DB?", options: ["Postgres", "SQLite"] });
  expect(codexRequestHint("item/fileChange/requestApproval", { threadId: "t" }, 5)).toEqual({ source: "codex-rpc", observedAt: 5, question: "Apply these changes?" });
  expect(codexRequestHint("mcpServer/elicitation/request", { mode: "url", message: "Sign in", url: "https://example.com" }, 5))
    .toEqual({ source: "codex-rpc", observedAt: 5, question: "Sign in", detail: "https://example.com" });
});
