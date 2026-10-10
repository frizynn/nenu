import { describe, expect, it } from "bun:test";

import { LiveEvents, liveEventStream, LiveThrottle, snapshotWatcher, type LiveEvent } from "./live-events.ts";
import { PaneWatcher } from "./pane-watcher.ts";
import type { Services, SessionRouteRequest } from "./routes/context.ts";
import { eventRoutes } from "./routes/events.ts";
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

describe("LiveThrottle", () => {
  it("sends the first change at once and folds a burst into one trailing event per key", async () => {
    const events: LiveEvent[] = [];
    const throttle = new LiveThrottle({ publish: (event) => events.push(event) }, 30);
    const a = { session: "s", topic: "pane" as const, paneId: "a" };
    const b = { session: "s", topic: "pane" as const, paneId: "b" };
    throttle.publish(a);
    throttle.publish(a);
    throttle.publish(a);
    throttle.publish(b);
    expect(events).toEqual([a, b]);
    await Bun.sleep(45);
    expect(events).toEqual([a, b, a]);
  });

  it("waits out the delay before the first event, and forgets a key on request", async () => {
    const events: LiveEvent[] = [];
    const throttle = new LiveThrottle({ publish: (event) => events.push(event) }, 0, 10);
    const a = { session: "s", topic: "journal" as const, paneId: "a" };
    throttle.publish(a);
    expect(events).toEqual([]);
    await Bun.sleep(20);
    expect(events).toEqual([a]);
    throttle.publish(a);
    throttle.forget(a);
    await Bun.sleep(20);
    expect(events).toEqual([a]);
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

describe("GET /api/snapshot", () => {
  it("answers an unchanged herd with 304, whatever the clock says", async () => {
    const app = await structuralFixture();
    try {
      const first = await fetch(`${app.url}/api/snapshot`);
      const etag = first.headers.get("etag");
      expect(etag).toMatch(/^"[0-9a-f]+"$/);
      const body = await first.json() as { ts: number; looseWorkspaceIds: string[] };
      expect(typeof body.ts).toBe("number");
      expect(Array.isArray(body.looseWorkspaceIds)).toBe(true);
      await Bun.sleep(5);
      const again = await fetch(`${app.url}/api/snapshot`, { headers: { "if-none-match": etag! } });
      expect(again.status).toBe(304);
      expect(again.headers.get("etag")).toBe(etag);
      expect(await again.text()).toBe("");
      await app.action("/api/pane/w:p/rename", { label: "After" });
      await app.engine.refresh();
      const changed = await fetch(`${app.url}/api/snapshot`, { headers: { "if-none-match": etag! } });
      expect(changed.status).toBe(200);
      expect(changed.headers.get("etag")).not.toBe(etag);
    } finally {
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

describe("GET /api/events ?watch=", () => {
  function route(herd: () => EngineSnapshot, refreshed: () => EngineSnapshot = herd) {
    const live = new LiveEvents();
    const paneWatcher = new PaneWatcher(live, { readEveryMs: 1_000 });
    const herdr = { async readPane(paneId: string) { return { pane_id: paneId, text: "", truncated: false, revision: 0 }; } };
    const abort = new AbortController();
    let refreshes = 0;
    const engine = { current: herd, async refresh() { refreshes++; return refreshed(); } };
    const open = async (watch: string) => {
      const services = { cfg: { transcript: false }, live, paneWatcher, journalWatch: { resolveWith() {} } } as unknown as Services;
      const request = {
        req: new Request("http://bridge/api/events", { signal: abort.signal }),
        url: new URL(`http://bridge/api/events?watch=${encodeURIComponent(watch)}`),
        rt: { name: "s", engine, herdr },
        server: { timeout() {} },
      } as unknown as SessionRouteRequest;
      return eventRoutes[0]!.handle(services, request);
    };
    return { live, paneWatcher, abort, open, refreshes: () => refreshes };
  }

  it("stops watching when the stream closes itself on a client that stopped reading", async () => {
    const { live, paneWatcher, abort, open } = route(() => snap(pane("p", "idle")));
    const response = await open("p");
    expect(paneWatcher.watching).toEqual(["p"]);
    for (let n = 0; n < 1000; n++) live.publish({ session: "s", topic: "pane", paneId: `x${n}` });
    await Bun.sleep(60);
    const reader = response.body!.getReader();
    while (!(await reader.read()).done);
    expect(abort.signal.aborted).toBe(false);
    expect(paneWatcher.watching).toEqual([]);
  });

  it("refreshes the herd once for a pane created after the last snapshot", async () => {
    const { paneWatcher, abort, open, refreshes } = route(() => snap(), () => snap(pane("new", "idle")));
    await open("new");
    expect([refreshes(), paneWatcher.watching]).toEqual([1, ["new"]]);
    await open("bogus");
    expect([refreshes(), paneWatcher.watching]).toEqual([2, ["new"]]);
    abort.abort();
    expect(paneWatcher.watching).toEqual([]);
  });
});
