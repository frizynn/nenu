import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";
import { CodexRpc, type CodexMessage } from "./codex-rpc.ts";

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
