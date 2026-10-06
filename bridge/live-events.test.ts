import { describe, expect, it } from "bun:test";

import { LiveEvents, liveEventStream, snapshotWatcher, type LiveEvent } from "./live-events.ts";
import type { EngineSnapshot } from "./state-engine.ts";
import { structuralFixture } from "./structural-fixture.test-support.ts";
import type { AgentView } from "./types.ts";

const pane = (paneId: string, status: AgentView["status"]): AgentView => ({
  paneId, workspaceId: "w", workspaceLabel: "w", workspaceNumber: 1, tabId: "t", agent: "claude", status, cwd: "/", focused: false,
});
const snap = (...agents: AgentView[]): EngineSnapshot => ({ agents, shellPanes: [], workspaces: [], tabs: [], bridge: "connected" });

describe("snapshotWatcher", () => {
  it("names the herd and only the panes that changed", () => {
    const events: LiveEvent[] = [];
    const watch = snapshotWatcher("s", (event) => events.push(event));
    watch(snap(pane("a", "working"), pane("b", "idle")));
    watch(snap(pane("a", "working"), pane("b", "idle")));
    expect(events).toEqual([]);
    watch(snap(pane("a", "idle"), pane("b", "idle")));
    expect(events).toEqual([
      { session: "s", topic: "snapshot" },
      { session: "s", topic: "pane", paneId: "a" },
      { session: "s", topic: "journal", paneId: "a" },
    ]);
  });
});

const decoder = new TextDecoder();
async function frames(stream: ReadableStream<Uint8Array>, count: number): Promise<string[]> {
  const reader = stream.getReader();
  let text = "";
  while (text.split("\n\n").length - 1 < count) {
    const { value, done } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  reader.releaseLock();
  return text.split("\n\n").filter(Boolean);
}

describe("liveEventStream", () => {
  it("opens with a ready frame, keeps to its session and coalesces a burst", async () => {
    const hub = new LiveEvents();
    const stream = liveEventStream(hub, "s", { flushMs: 5 });
    hub.publish({ session: "other", topic: "snapshot" });
    hub.publish({ session: "s", topic: "queue", paneId: "a" });
    hub.publish({ session: "s", topic: "queue", paneId: "a" });
    hub.publish({ session: "s", topic: "snapshot" });
    expect(await frames(stream, 3)).toEqual([
      "retry: 2000\nevent: ready\ndata: {}",
      'data: {"topic":"queue","paneId":"a"}',
      'data: {"topic":"snapshot"}',
    ]);
  });

  it("drops its subscription when the request goes away", async () => {
    const hub = new LiveEvents();
    const abort = new AbortController();
    const stream = liveEventStream(hub, "s", { signal: abort.signal });
    const reader = stream.getReader();
    await reader.read();
    abort.abort();
    hub.publish({ session: "s", topic: "snapshot" });
    expect((await reader.read()).done).toBe(true);
  });
});

describe("GET /api/events", () => {
  it("streams a pane change to a same-origin page and refuses a cross-origin one", async () => {
    const app = await structuralFixture();
    const abort = new AbortController();
    try {
      const refused = await fetch(`${app.url}/api/events`, { headers: { origin: "https://evil.example" } });
      expect(refused.status).toBe(403);
      const response = await fetch(`${app.url}/api/events`, { signal: abort.signal });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      const reading = frames(response.body!, 4);
      await app.action("/api/pane/w:p/rename", { label: "After" });
      app.engine.pokeNow();
      expect(await reading).toEqual([
        "retry: 2000\nevent: ready\ndata: {}",
        'data: {"topic":"snapshot"}',
        'data: {"topic":"pane","paneId":"w:p"}',
        'data: {"topic":"journal","paneId":"w:p"}',
      ]);
    } finally {
      abort.abort();
      await app.dispose();
    }
  });
});

describe("a client that stops reading", () => {
  it("is closed instead of buffered without bound", async () => {
    const hub = new LiveEvents();
    const stream = liveEventStream(hub, "s", { flushMs: 0 });
    for (let pane = 0; pane < 1000; pane++) hub.publish({ session: "s", topic: "pane", paneId: `p${pane}` });
    await Bun.sleep(10);
    const reader = stream.getReader();
    let frames = 0;
    while (!(await reader.read()).done) frames++;
    expect(frames).toBeLessThan(300);
  });
});
