import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.ts";
import { LiveEvents, snapshotWatcher } from "./live-events.ts";
import type { HerdrClient } from "./herdr-client.ts";
import { startServer } from "./server.ts";
import { StateEngine } from "./state-engine.ts";

// No terminal socket: exercise the real HTTP routes against a mutable Herdr test double.
export async function structuralFixture(cadenceMs = 12_000) {
  const dir = await mkdtemp(join(tmpdir(), "nenu-structural-"));
  const pane = { pane_id: "w:p", terminal_id: "t", workspace_id: "w", tab_id: "tab", focused: false, cwd: dir, agent: "codex", agent_status: "idle" as const, revision: 0, label: "Before" };
  const tab = { tab_id: "tab", workspace_id: "w", number: 1, label: "Before", focused: false, pane_count: 1, agent_status: "idle" as const };
  let panes = [pane], tabs = [tab];
  let failSnapshot = false;
  const herdr = {
    async sessionSnapshot() { if (failSnapshot) throw new Error("snapshot unavailable"); return { version: "test", protocol: 16, workspaces: [], panes, tabs }; },
    async renamePane(_id: string, label: string | null) { panes = panes.map(p => ({ ...p, label: label ?? "" })); },
    async renameTab(_id: string, label: string) { tabs = tabs.map(t => ({ ...t, label })); },
    async closePane() { panes = []; },
    async closeTab() { panes = []; tabs = []; },
  };
  const engine = new StateEngine(herdr as unknown as HerdrClient, cadenceMs);
  const live = new LiveEvents();
  engine.onUpdate(snapshotWatcher("default", (event) => live.publish(event)));
  engine.start();
  await new Promise<void>(resolve => engine.onUpdate(() => resolve()));
  const runtime = { name: "default", isPrimary: true, engine, herdr };
  const cfg = { ...loadConfig(), host: "127.0.0.1", port: 0, stateDir: dir, transcript: false, trustedUser: "", deviceHeader: "", publicHosts: ["127.0.0.1"], skipServe: true };
  const server = startServer({
    cfg,
    registry: { get: () => runtime, list: () => [] },
    push: { useInteractions: () => {} }, snooze: { until: () => null }, notifyPrefs: {}, updateMonitor: { status: () => ({}) },
    audit: { record: () => {} }, activity: { get: () => undefined, noteSeen: () => {} }, live,
  } as unknown as Parameters<typeof startServer>[0]);
  const url = `http://127.0.0.1:${server.port}`;
  return {
    url,
    async action(path: string, body?: unknown) {
      const response = await fetch(url + path, { method: "POST", headers: { origin: url, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    },
    engine,
    failReads() { failSnapshot = true; },
    async snapshot() { return await (await fetch(url + "/api/snapshot")).json(); },
    async dispose() {
      // Static requests join the bridge's pending asset retention before removing its test directory.
      await (await fetch(url + "/")).arrayBuffer();
      engine.stop();
      await server.stop(true);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
