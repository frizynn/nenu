import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { HerdrClient } from "../herdr-client.ts";
import { FakeHerdr } from "./fake-herdr.ts";

// The fake is only useful if the production socket client accepts it as Herdr, so every case drives
// it through HerdrClient over a real Unix socket.

let dir: string;
let fake: FakeHerdr;
let client: HerdrClient;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nenu-fake-herdr-"));
  fake = new FakeHerdr({ socketPath: join(dir, "herdr.sock"), echoMs: 5 })
    .addWorkspace("w1", "demo")
    .addPane({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", agent: "claude", sessionId: "s-1", lines: ["● Hello"] });
  await fake.start();
  client = new HerdrClient(fake.socketPath, 1000, "bun");
});

afterEach(async () => {
  fake.stop();
  await rm(dir, { recursive: true, force: true });
});

describe("FakeHerdr", () => {
  test("answers the snapshot the bridge polls and counts it by method", async () => {
    const snap = await client.sessionSnapshot();
    expect(snap.protocol).toBe(22);
    expect(snap.workspaces.map((w) => [w.workspace_id, w.label, w.pane_count])).toEqual([["w1", "demo", 1]]);
    expect(snap.panes[0]).toMatchObject({ pane_id: "w1:p1", agent: "claude", agent_status: "idle", agent_session: { kind: "id", value: "s-1" } });
    await client.listPanes();
    expect(fake.counts()).toEqual({ "session.snapshot": 1, "pane.list": 1 });
    expect(fake.writes()).toEqual([]);
  });

  test("echoes typed text into the composer and submits it on Enter, logging both writes", async () => {
    await client.sendPaneText("w1:p1", "ship it");
    await sleep(20);
    expect((await client.readPane("w1:p1", "visible", 40)).text).toContain("❯ ship it");
    await client.sendPaneKeys("w1:p1", ["Enter"]);
    expect(fake.submitted.map((s) => s.text)).toEqual(["ship it"]);
    expect(fake.writes().map((c) => c.method)).toEqual(["pane.send_text", "pane.send_keys"]);
    expect(fake.counts()["pane.read"]).toBe(1);
  });

  test("a working pane repaints on its own, so a mirror read changes revision", async () => {
    fake.setStatus("w1:p1", "working");
    const first = await client.readPane("w1:p1", "visible", 40);
    expect(first.text).toContain("Working…");
    await sleep(300);
    expect((await client.readPane("w1:p1", "visible", 40)).revision).toBeGreaterThan(first.revision);
  });

  test("a dialog swallows text, a digit answers it, and subscribers hear the status change", async () => {
    const events: unknown[] = [];
    let up!: () => void;
    const ready = new Promise<void>((resolve) => (up = resolve));
    const stream = client.subscribeEvents({
      subscriptions: [{ type: "pane.agent_status_changed", pane_id: "w1:p1" }],
      onUp: () => up(),
      onEvent: (_event, data) => events.push(data),
      onDown: () => {},
    });
    await ready;
    fake.setDialog("w1:p1", " Do you want to proceed?\n ❯ 1. Yes\n   2. No");
    await client.sendPaneText("w1:p1", "lost");
    await sleep(20);
    expect((await client.sessionSnapshot()).panes[0]!.agent_status).toBe("blocked");
    await client.sendPaneKeys("w1:p1", ["1"]);
    expect(fake.answered.map((a) => a.key)).toEqual(["1"]);
    expect(fake.submitted).toEqual([]);
    expect((await client.readPane("w1:p1", "visible", 40)).text).not.toContain("lost");
    await sleep(20);
    expect(events).toMatchObject([{ agent_status: "blocked" }, { agent_status: "idle" }]);
    stream.close();
  });

  test("waits for output server-side: a later echo matches, a miss times out, a bad pattern is refused", async () => {
    const hit = client.waitForOutput("w1:p1", { source: "visible", match: { type: "regex", value: "(?m)^.{0,8}?[❯›>][  ]+ship" }, timeoutMs: 500 });
    await client.sendPaneText("w1:p1", "ship it");
    const r = await hit;
    expect(r.matched && r.matchedLine).toBe("❯ ship it");
    expect(r.matched && r.read.text).toContain("❯ ship it");

    const started = Date.now();
    expect(await client.waitForOutput("w1:p1", { source: "visible", match: { type: "substring", value: "never" }, timeoutMs: 60 })).toEqual({ matched: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(55);

    await expect(client.waitForOutput("w1:p1", { source: "visible", match: { type: "regex", value: "(" }, timeoutMs: 60 })).rejects.toThrow("invalid_regex");
    expect(fake.writes().map((c) => c.method)).toEqual(["pane.send_text"]);
  });

  test("closing a tab removes every pane in it and tells tab.closed subscribers", async () => {
    fake.addPane({ paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t2", agent: null });
    const events: unknown[] = [];
    let up!: () => void;
    const ready = new Promise<void>((resolve) => (up = resolve));
    const stream = client.subscribeEvents({
      subscriptions: [{ type: "tab.closed" }],
      onUp: () => up(),
      onEvent: (_event, data) => events.push(data),
      onDown: () => {},
    });
    await ready;
    await client.closeTab("w1:t2");
    const snap = await client.sessionSnapshot();
    expect(snap.tabs.map((t) => t.tab_id)).toEqual(["w1:t1"]);
    expect(snap.panes.map((p) => p.pane_id)).toEqual(["w1:p1"]);
    await expect(client.closeTab("w1:t2")).rejects.toThrow("tab_not_found");
    await sleep(20);
    expect(events).toMatchObject([{ type: "tab_closed", tab_id: "w1:t2", workspace_id: "w1" }]);
    stream.close();
  });

  test("rejects a method it does not implement the way Herdr rejects an unknown variant", async () => {
    await expect(client.closePane("w1:p1")).rejects.toThrow("unknown variant");
    expect(fake.writes().map((c) => c.method)).toEqual(["pane.close"]);
  });
});
