import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentNotifyStore } from "../agent-notify.ts";
import { loadConfig } from "../config.ts";
import type { HerdrClient } from "../herdr-client.ts";
import { LiveEvents } from "../live-events.ts";
import { startServer } from "../server.ts";
import { StateEngine } from "../state-engine.ts";

// The real snapshot and switch routes, in process, against a Herdr test double with two agents. One
// server has the switch store, one does not (as 2.12.0 had none): with nothing configured, the first
// answers the second's snapshot plus `notify: true` on every agent.
let dir = "";
let withSwitch = "";
let without = "";
let store: AgentNotifyStore;
const stops: Array<() => Promise<void> | void> = [];

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "nenu-agent-notify-route-"));
  const agent = (id: string, cwd: string) => ({ pane_id: id, terminal_id: id, workspace_id: "w", tab_id: "tab", focused: false, cwd, agent: "codex", agent_status: "idle" as const, revision: 0 });
  const panes = [agent("w:p1", join(dir, "a")), agent("w:p2", join(dir, "b"))];
  const herdr = { async sessionSnapshot() { return { version: "test", protocol: 16, workspaces: [], panes, tabs: [] }; } };
  const engine = new StateEngine(herdr as unknown as HerdrClient, 60_000);
  engine.start();
  await new Promise<void>((resolve) => engine.onUpdate(() => resolve()));
  stops.push(() => engine.stop());
  store = AgentNotifyStore.at(join(dir, "state"));
  store.reconcile("default", engine.current().agents);
  const runtime = { name: "default", isPrimary: true, engine, herdr, notifications: { applyPrefs: () => {} } };
  const serve = (agentNotify?: AgentNotifyStore) => {
    const server = startServer({
      cfg: { ...loadConfig(), host: "127.0.0.1", port: 0, stateDir: dir, transcript: false, trustedUser: "", deviceHeader: "", publicHosts: ["127.0.0.1"], skipServe: true },
      registry: { get: (name?: string) => (!name || name === "default" ? runtime : undefined), list: () => [], all: () => [runtime] },
      push: { enabled: false, publicKey: "", useInteractions: () => {} }, snooze: { until: () => null }, notifyPrefs: { current: () => ({}) }, alerts: { use: () => {} },
      updateMonitor: { status: () => ({}) }, audit: { record: () => {} }, activity: { get: () => undefined, noteSeen: () => {} }, live: new LiveEvents(),
      ...(agentNotify ? { agentNotify } : {}),
    } as unknown as Parameters<typeof startServer>[0]);
    stops.push(() => server.stop(true));
    return `http://127.0.0.1:${server.port}`;
  };
  withSwitch = serve(store);
  without = serve();
});

afterAll(async () => {
  for (const stop of stops.reverse()) await stop();
  await rm(dir, { recursive: true, force: true });
});

const agents = async (base: string) => ((await (await fetch(`${base}/api/snapshot`)).json()) as { agents: Array<Record<string, unknown>> }).agents;
const post = (base: string, body: unknown) =>
  fetch(`${base}/api/notifications/agent`, { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify(body) });

describe("the snapshot with nothing configured", () => {
  test("is 2.12.0's, plus notify: true on every agent", async () => {
    const now = await agents(withSwitch);
    const before = await agents(without);
    expect(before.length).toBe(2);
    expect(now.map((a) => a.notify)).toEqual([true, true]);
    expect(now.map(({ notify: _notify, ...rest }) => rest)).toEqual(before);
    expect(before.every((a) => !("notify" in a))).toBe(true);
  });
});

describe("POST /api/notifications/agent", () => {
  test("turns one agent off and back on, and the snapshot follows", async () => {
    const off = await post(withSwitch, { paneId: "w:p2", on: false });
    expect(off.status).toBe(200);
    expect(await off.json()).toEqual({ paneId: "w:p2", notify: false });
    expect((await agents(withSwitch)).map((a) => [a.paneId, a.notify])).toEqual([["w:p1", true], ["w:p2", false]]);
    expect(store.on("default", "w:p2")).toBe(false);
    await post(withSwitch, { paneId: "w:p2", on: true });
    expect(store.on("default", "w:p2")).toBe(true);
  });

  test("refuses a pane the session does not have, a bad body, and a foreign origin", async () => {
    expect((await post(withSwitch, { paneId: "w:p9", on: false })).status).toBe(404);
    expect((await post(withSwitch, { paneId: "w:p1", on: "no" })).status).toBe(400);
    const foreign = await fetch(`${withSwitch}/api/notifications/agent`, { method: "POST", headers: { origin: "http://evil.example" }, body: "{}" });
    expect(foreign.status).toBe(403);
    expect(store.list().every((r) => r.on)).toBe(true);
  });

  test("a bridge without the store answers 404 and changes nothing", async () => {
    expect((await post(without, { paneId: "w:p1", on: false })).status).toBe(404);
  });
});
