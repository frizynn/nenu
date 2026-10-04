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
