import { describe, expect, it } from "bun:test";
import { QueueService } from "./queue-service.ts";

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
  const { join } = await import("node:path");
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
  const text = await Bun.file("web/src/fixtures/panes/codex--v0157-idle.txt").text();
  const herdr = { readPane: async () => ({ pane_id: "pane", text, revision: 1, truncated: false }) };
  expect(await queueReadiness({ paneId: "pane", agent: "codex", status: "blocked" }, herdr)).toBe("ready");
});

it("does not mistake a blocked-status busy Codex composer for an idle terminal", async () => {
  const { queueReadiness } = await import("./queue-readiness.ts");
  const text = await Bun.file("web/src/fixtures/panes/codex--v0159-busy.txt").text();
  const herdr = { readPane: async () => ({ pane_id: "pane", text, revision: 1, truncated: false }) };
  expect(await queueReadiness({ paneId: "pane", agent: "codex", status: "blocked" }, herdr)).toBe("working");
});

it("attempts an explicit Codex message immediately while the agent is working", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
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
  const { join } = await import("node:path");
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
