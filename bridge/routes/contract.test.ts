import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../config.ts";
import type { HerdrClient } from "../herdr-client.ts";
import { LiveEvents } from "../live-events.ts";
import { startServer } from "../server.ts";
import { StateEngine } from "../state-engine.ts";
import { PANE_ACTIONS } from "./index.ts";

// The route contract, pinned over real HTTP: every API route and method reaches its handler only
// after the same gates, in the same order, as before the routes were split out of server.ts —
// host/origin/CSRF first, then the device gate for writes, then the session lookup, then (for a pane
// action) the method check that 405s, and seen-marking only on a routed request. Handlers are
// reached only with inputs that refuse before any side effect: an unknown session, a wrong method,
// a read-only device or a foreign origin.

type Level = "read" | "write" | "none";
interface Case { method: string; path: string; level: Level; session: boolean }

const pane = (action: string, method: string, level: Level): Case =>
  ({ method, path: `/api/pane/w%3Ap${action ? `/${action}` : ""}`, level, session: true });

const CASES: Case[] = [
  { method: "GET", path: "/api/org/templates", level: "read", session: false },
  { method: "POST", path: "/api/org/node/start", level: "write", session: true },
  { method: "POST", path: "/api/org/node/resolve", level: "write", session: true },
  { method: "POST", path: "/api/org/project/create", level: "write", session: true },
  { method: "POST", path: "/api/org/thread/merge", level: "write", session: true },
  { method: "POST", path: "/api/org/thread/set", level: "write", session: true },
  { method: "GET", path: "/api/snapshot", level: "read", session: true },
  { method: "POST", path: "/api/snapshot", level: "read", session: true },
  { method: "GET", path: "/api/events", level: "read", session: true },
  { method: "GET", path: "/api/dirs", level: "write", session: false },
  { method: "POST", path: "/api/tab", level: "write", session: true },
  { method: "POST", path: "/api/workspace", level: "write", session: true },
  { method: "POST", path: "/api/tab/t1/rename", level: "write", session: true },
  { method: "POST", path: "/api/tab/t1/close", level: "write", session: true },
  pane("", "GET", "read"),
  ...["history", "conversations", "skills", "models", "file", "subagents", "subagent-history", "files", "html-preview", "journal-image", "queue", "activity"]
    .map((action) => pane(action, "GET", "read")),
  ...["start", "send", "reply", "keys", "interrupt", "upload", "close", "rename", "connect", "send-report", "queue"]
    .map((action) => pane(action, "POST", "write")),
  // A pane action's gate follows its level, not the method: a mismatched method still clears the
  // gate and the session lookup before it 405s.
  pane("reply", "GET", "write"),
  pane("history", "POST", "read"),
  pane("queue", "PUT", "write"),
  { method: "GET", path: "/api/config", level: "read", session: false },
  { method: "POST", path: "/api/config", level: "read", session: false },
  { method: "POST", path: "/api/subscribe", level: "read", session: false },
  { method: "POST", path: "/api/notifications/snooze", level: "read", session: false },
  { method: "GET", path: "/api/notifications/prefs", level: "read", session: false },
  { method: "POST", path: "/api/notifications/prefs", level: "read", session: false },
  { method: "PUT", path: "/api/notifications/prefs", level: "none", session: false },
  { method: "POST", path: "/api/update/check", level: "read", session: false },
  { method: "GET", path: "/api/interactions", level: "read", session: true },
  { method: "POST", path: "/api/interactions/w%3Ap/answer", level: "write", session: true },
  { method: "POST", path: "/api/files/grant", level: "write", session: true },
  { method: "GET", path: "/api/files/open", level: "read", session: false },
];

// Paths no route claims for that method: they fall through to static and are never gated.
const UNROUTED = [
  ["GET", "/api/tab"],
  ["GET", "/api/subscribe"],
  ["GET", "/api/tab/t1/close"],
  ["POST", "/api/pane/w%3Ap/nope"],
] as const;

let url = "";
let dispose = async () => {};
const seen: string[] = [];
const audited: Array<{ action: string; device?: string | null; detail?: Record<string, unknown> }> = [];
let outside = "";

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), "nenu-route-contract-"));
  outside = await mkdtemp(join(tmpdir(), "nenu-route-outside-"));
  // A shell pane: no agent, so no handler reaches for a conversation, journal or daemon.
  const paneInfo = { pane_id: "w:p", terminal_id: "t", workspace_id: "w", tab_id: "tab", focused: false, cwd: dir, agent_status: "idle" as const, revision: 0 };
  const herdr = {
    async sessionSnapshot() { return { version: "test", protocol: 16, workspaces: [], panes: [paneInfo], tabs: [] }; },
    async listPanes() { return [paneInfo]; },
    async readPane() { return { text: "", truncated: false, revision: 0 }; },
  };
  const engine = new StateEngine(herdr as unknown as HerdrClient, 60_000);
  engine.start();
  await new Promise<void>((resolve) => engine.onUpdate(() => resolve()));
  const runtime = { name: "default", isPrimary: true, engine, herdr, socketPath: join(dir, "herdr.sock") };
  const cfg = {
    ...loadConfig(), host: "127.0.0.1", port: 0, stateDir: dir, transcript: false,
    trustedUser: "", skipServe: true, allowAnyHost: false, publicHosts: ["nenu.example"],
    tailscaleHosts: [], allowedOrigins: [], deviceHeader: "x-device", deviceAllowlist: ["phone"],
  };
  const server = startServer({
    cfg,
    registry: { get: (name?: string) => (!name || name === "default" ? runtime : undefined), list: () => [], all: () => [runtime] },
    push: { enabled: false, publicKey: "", useInteractions: () => {} }, snooze: { until: () => null }, notifyPrefs: { current: () => ({}) },
    updateMonitor: { status: () => ({}), checkRelease: async () => {} },
    audit: { record: (entry: (typeof audited)[number]) => audited.push(entry) },
    activity: { get: () => undefined, noteSeen: (_session: string, paneId: string) => seen.push(paneId) },
    live: new LiveEvents(),
  } as unknown as Parameters<typeof startServer>[0]);
  url = `http://127.0.0.1:${server.port}`;
  dispose = async () => {
    engine.stop();
    await server.stop(true);
    await rm(dir, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  };
});

afterAll(() => dispose());

async function send(method: string, path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  const response = await fetch(url + path, { method, headers });
  const body = response.headers.get("content-type")?.startsWith("text/event-stream") ? "<stream>" : await response.text();
  return { status: response.status, body };
}

const SAME_ORIGIN = () => ({ origin: url });
const withSession = (path: string, session: string) => `${path}${path.includes("?") ? "&" : "?"}session=${session}`;

describe("every route keeps its gate order", () => {
  for (const c of CASES) {
    const name = `${c.method} ${c.path}`;

    test(`${name}: a foreign origin is refused before anything else`, async () => {
      const result = await send(c.method, c.path, { origin: "http://evil.example" });
      if (c.level === "none") expect(result.status).toBe(405);
      else expect(result).toEqual({ status: 403, body: "cross-origin rejected" });
    });

    if (c.level === "none") continue;

    test(`${name}: a ${c.level} from a non-loopback host without Origin`, async () => {
      const result = await send(c.method, withSession(c.path, "nope"), { host: "nenu.example", "x-device": "phone" });
      if (c.level === "write") expect(result).toEqual({ status: 403, body: "origin required" });
      else expect(result.body).not.toBe("origin required");
    });

    test(`${name}: a read-only device ${c.level === "write" ? "is refused" : "passes the gate"}`, async () => {
      const result = await send(c.method, withSession(c.path, "nope"), { ...SAME_ORIGIN(), "x-device": "tablet" });
      if (c.level === "write") expect(result).toEqual({ status: 403, body: "device not authorised" });
      else expect(result.status).not.toBe(403);
    });

    if (c.session) {
      test(`${name}: the session is looked up after the gate`, async () => {
        const result = await send(c.method, withSession(c.path, "nope"), { ...SAME_ORIGIN(), "x-device": "phone" });
        expect(result).toEqual({ status: 404, body: JSON.stringify({ error: "unknown session: nope" }) });
      });
    }
  }
});

describe("pane actions", () => {
  test("every pane action has a contract row", () => {
    const covered = new Set(CASES.filter((c) => c.path.startsWith("/api/pane/w%3Ap")).map((c) => c.path.slice("/api/pane/w%3Ap/".length)));
    expect(Object.keys(PANE_ACTIONS).filter((action) => !covered.has(action))).toEqual([]);
  });

  test("a method mismatch 405s after the gate and session, and marks nothing seen", async () => {
    seen.length = 0;
    for (const [method, action] of [["GET", "reply"], ["POST", "history"], ["PUT", "queue"], ["POST", ""]] as const) {
      const result = await send(method, `/api/pane/w%3Ap${action ? `/${action}` : ""}`, { ...SAME_ORIGIN(), "x-device": "phone" });
      expect(result).toEqual({ status: 405, body: "method not allowed" });
    }
    expect(seen).toEqual([]);
  });

  test("a routed read marks the pane seen only with the seen header, except conversations", async () => {
    seen.length = 0;
    await send("GET", "/api/pane/w%3Ap", { "x-device": "tablet" });
    await send("GET", "/api/pane/w%3Ap/history", {});
    await send("GET", "/api/pane/w%3Ap/queue", {});
    expect(seen).toEqual([]);
    await send("GET", "/api/pane/w%3Ap", { "x-collie-seen": "1" });
    expect(seen).toEqual(["w:p"]);
    await send("GET", "/api/pane/w%3Ap/conversations", {});
    expect(seen).toEqual(["w:p", "w:p"]);
  });
});

describe("unrouted requests fall through to static, ungated", () => {
  for (const [method, path] of UNROUTED) {
    test(`${method} ${path}`, async () => {
      const result = await send(method, path, { origin: "http://evil.example" });
      expect(result.status).not.toBe(403);
      expect(result.status).not.toBe(405);
    });
  }

  test("/auth/ answers its placeholder outside every gate", async () => {
    const result = await send("GET", "/auth/sign-in", { origin: "http://evil.example" });
    expect(result.status).toBe(404);
    expect(result.body).toContain("Nothing is configured at this address");
  });
});

describe("opening a refused file through a confirmed link", () => {
  const grant = async (path: string, headers: Record<string, string> = { ...SAME_ORIGIN(), "x-device": "phone" }) => {
    const response = await fetch(`${url}/api/files/grant`, { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: JSON.stringify({ paneId: "w:p", path }) });
    return { status: response.status, body: await response.json() as { url?: string; name?: string; size?: number; type?: string; error?: string } };
  };

  test("grants a file outside the pane's folder and opens it once, sandboxed, for the same device", async () => {
    const file = join(outside, "resultado-shopify.html");
    await writeFile(file, "<script>document.title='ran'</script>");
    audited.length = 0;
    const { status, body } = await grant(file);
    expect(status).toBe(200);
    expect(body).toMatchObject({ name: "resultado-shopify.html", type: "text/html", size: 37 });
    expect(body.url).toMatch(/^\/api\/files\/open\?t=[A-Za-z0-9_-]{22}$/);
    // Another device cannot use it, and trying spends it.
    expect((await fetch(url + body.url, { headers: { "x-device": "tablet" } })).status).toBe(410);
    const again = await grant(file);
    // A top-level navigation carries no Origin.
    const opened = await fetch(url + again.body.url, { headers: { "x-device": "phone" } });
    expect(opened.status).toBe(200);
    expect(opened.headers.get("content-security-policy")).toEndWith("frame-ancestors 'none'; sandbox allow-scripts");
    expect(opened.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(await opened.text()).toContain("document.title");
    expect((await fetch(url + again.body.url, { headers: { "x-device": "phone" } })).status).toBe(410);
    expect(audited.map((entry) => [entry.action, entry.device, entry.detail?.path])).toEqual([
      ["file.grant", "phone", await realpathOf(file)],
      ["file.grant", "phone", await realpathOf(file)],
      ["file.open", "phone", await realpathOf(file)],
    ]);
  });

  test("resolves a relative path against the named pane's folder and refuses private files", async () => {
    expect(await grant("../nope.txt").then((r) => r.status)).toBe(404);
    await writeFile(join(outside, ".env"), "TOKEN=1");
    expect(await grant(join(outside, ".env"))).toEqual({ status: 403, body: { error: "This file is private and cannot be opened from Nenu." } });
  });
});

async function realpathOf(path: string): Promise<string> {
  const { realpath } = await import("node:fs/promises");
  return realpath(path);
}
