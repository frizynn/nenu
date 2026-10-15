import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import type { HerdrClient } from "../herdr-client.ts";
import { LiveEvents } from "../live-events.ts";
import type { MachineDirectory } from "../machines.ts";
import { startServer } from "../server.ts";
import { StateEngine } from "../state-engine.ts";
import type { MachineView } from "../types.ts";

// A machine is a session to the browser (`?session=@<label>`). The dispatcher clears the local gate at
// the route's own level, then hands the request to that machine's link untouched; the other Nenu's
// socket (`<stateDir>/peer.sock`) answers as the operator, and never forwards again.

let url = "";
let stateDir = "";
let dispose = async () => {};
const forwarded: Array<{ session: string; path: string; method: string }> = [];

const BUILD_BOX: MachineView = { session: "@build-box", label: "build-box", state: "connected", herd: { bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [] } };

const machines: MachineDirectory = {
  views: (current) => [{ label: "studio", state: "connected" }, current === "@build-box" ? { ...BUILD_BOX, herd: undefined } : BUILD_BOX],
  has: (session) => session === "@build-box",
  async forward(session, req, url) {
    forwarded.push({ session, path: url.pathname, method: req.method });
    return Response.json({ forwarded: true });
  },
  async snapshot() { return null; },
  refresh() {},
  stop() {},
};

beforeAll(async () => {
  stateDir = await mkdtemp(join(tmpdir(), "nenu-mach-"));
  const paneInfo = { pane_id: "w:p", terminal_id: "t", workspace_id: "w", tab_id: "tab", focused: false, cwd: stateDir, agent_status: "idle" as const, revision: 0 };
  const herdr = {
    async sessionSnapshot() { return { version: "test", protocol: 16, workspaces: [], panes: [paneInfo], tabs: [] }; },
    async listPanes() { return [paneInfo]; },
    async readPane() { return { text: "", truncated: false, revision: 0 }; },
  };
  const engine = new StateEngine(herdr as unknown as HerdrClient, 60_000);
  engine.start();
  await new Promise<void>((resolve) => engine.onUpdate(() => resolve()));
  const runtime = { name: "default", isPrimary: true, engine, herdr, socketPath: join(stateDir, "herdr.sock") };
  const cfg = {
    ...loadConfig(), host: "127.0.0.1", port: 0, stateDir, transcript: false,
    trustedUser: "operator@example.com", skipServe: false, allowAnyHost: false, publicHosts: ["nenu.example"],
    tailscaleHosts: [], allowedOrigins: [], deviceHeader: "x-device", deviceAllowlist: ["phone"],
  };
  const server = startServer({
    cfg,
    registry: { get: (name?: string) => (!name || name === "default" ? runtime : undefined), list: () => [], all: () => [runtime] },
    push: { enabled: false, publicKey: "", useInteractions: () => {} }, snooze: { until: () => null }, notifyPrefs: { current: () => ({}) }, alerts: { use: () => {} },
    updateMonitor: { status: () => ({}), checkRelease: async () => {} },
    audit: { record: () => {} },
    activity: { get: () => undefined, noteSeen: () => {} },
    live: new LiveEvents(),
    machines,
  } as unknown as Parameters<typeof startServer>[0]);
  url = `http://127.0.0.1:${server.port}`;
  dispose = async () => {
    engine.stop();
    await server.stop(true);
    await rm(stateDir, { recursive: true, force: true });
  };
});

afterAll(() => dispose());

const ME = { "tailscale-user-login": "operator@example.com" };

describe("a request for another machine", () => {
  test("a pane read is handed to that machine's link, after the local gate", async () => {
    const res = await fetch(`${url}/api/pane/w1%3Ap1?session=%40build-box`, { headers: ME });
    expect(await res.json()).toEqual({ forwarded: true });
    expect(forwarded.at(-1)).toEqual({ session: "@build-box", path: "/api/pane/w1%3Ap1", method: "GET" });
  });

  test("a write from a read-only device is refused here and never reaches the other machine", async () => {
    const before = forwarded.length;
    const res = await fetch(`${url}/api/pane/w1%3Ap1/send?session=%40build-box`, { method: "POST", headers: { ...ME, origin: url, "x-device": "tablet" } });
    expect(res.status).toBe(403);
    expect(forwarded.length).toBe(before);
  });

  test("without the operator's identity nothing is forwarded", async () => {
    const before = forwarded.length;
    const res = await fetch(`${url}/api/pane/w1%3Ap1?session=%40build-box`);
    expect(res.status).toBe(403);
    expect(forwarded.length).toBe(before);
  });

  test("the folder picker and a confirmed Open go to the machine too", async () => {
    await fetch(`${url}/api/dirs?session=%40build-box`, { headers: { ...ME, "x-device": "phone" } });
    expect(forwarded.at(-1)?.path).toBe("/api/dirs");
    await fetch(`${url}/api/files/open?token=abc&session=%40build-box`, { headers: ME });
    expect(forwarded.at(-1)?.path).toBe("/api/files/open");
  });

  test("settings, push and Organizations stay on this machine", async () => {
    const before = forwarded.length;
    await fetch(`${url}/api/config?session=%40build-box`, { headers: ME });
    await fetch(`${url}/api/org/node/start?session=%40build-box`, { method: "POST", headers: { ...ME, origin: url, "x-device": "phone" } });
    expect(forwarded.length).toBe(before);
  });

  test("a machine Herdr has not saved is a 404", async () => {
    const res = await fetch(`${url}/api/pane/w1%3Ap1?session=%40nowhere`, { headers: ME });
    expect(res.status).toBe(404);
  });

  test("this machine's snapshot lists every machine, and the others' herds", async () => {
    const snap = await (await fetch(`${url}/api/snapshot`, { headers: ME })).json() as { machines?: MachineView[] };
    expect(snap.machines?.map((m) => [m.label, m.session, m.herd !== undefined])).toEqual([["studio", undefined, false], ["build-box", "@build-box", true]]);
  });
});

describe("the other machines' door", () => {
  const peer = () => join(stateDir, "peer.sock");

  test("is a socket only this user can open", async () => {
    expect((await stat(peer())).mode & 0o777).toBe(0o600);
  });

  test("answers as the operator: no identity header, Origin or device needed", async () => {
    const res = await fetch("http://nenu-peer/api/snapshot", { unix: peer() });
    expect(res.status).toBe(200);
    const write = await fetch("http://nenu-peer/api/pane/nope/rename", { unix: peer(), method: "POST", body: "{}" });
    expect(write.status).not.toBe(403);
  });

  test("never forwards to another machine: one hop only", async () => {
    const before = forwarded.length;
    const res = await fetch("http://nenu-peer/api/pane/w1%3Ap1?session=%40build-box", { unix: peer() });
    expect(res.status).toBe(404);
    expect(forwarded.length).toBe(before);
  });
});
