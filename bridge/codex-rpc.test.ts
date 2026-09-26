import { expect, test } from "bun:test";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WebSocketServer } from "ws";
import { CodexRpc } from "./codex-rpc.ts";

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
