import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_HOOK_PATH, CLAUDE_HOOK_TOKEN_FILE, CLAUDE_HOOK_TOKEN_HEADER, ClaudeHooks, decodeClaudeHook, hookTokenMatches, paneForSession } from "./claude-hooks.ts";
import { loadConfig } from "./config.ts";
import type { HerdrClient } from "./herdr-client.ts";
import { LiveEvents } from "./live-events.ts";
import { startServer } from "./server.ts";
import { StateEngine } from "./state-engine.ts";
import type { AgentView, LiveEvent } from "./types.ts";

const SESSION = "0b6b2a52-5d5c-4c0e-9d5e-4f3f3c1a2b3c";
const OTHER = "11111111-2222-4333-8444-555555555555";

describe("decodeClaudeHook", () => {
  test("keeps the question and options of AskUserQuestion, never the prompt", () => {
    const observation = decodeClaudeHook({
      hook_event_name: "PreToolUse", session_id: SESSION, tool_name: "AskUserQuestion",
      tool_input: { questions: [{ question: "Which DB?", header: "DB", options: [{ label: "Postgres", description: "x" }, { label: "SQLite" }], multiSelect: false }] },
    }, 5);
    expect(observation).toEqual({ event: "PreToolUse", sessionId: SESSION, observedAt: 5, toolName: "AskUserQuestion", hint: { source: "claude-hook", observedAt: 5, question: "Which DB?", options: ["Postgres", "SQLite"] } });
  });

  test("a permission request carries the full command as detail", () => {
    const observation = decodeClaudeHook({ hook_event_name: "PermissionRequest", session_id: SESSION, tool_name: "Bash", tool_input: { command: "rm -rf build" }, permission_suggestions: [] }, 1);
    expect(observation?.hint).toEqual({ source: "claude-hook", observedAt: 1, question: "Bash", detail: "rm -rf build" });
  });

  test("UserPromptSubmit and Stop keep only metadata", () => {
    const submit = decodeClaudeHook({ hook_event_name: "UserPromptSubmit", session_id: SESSION, prompt: "secret plans", transcript_path: "/x" }, 1);
    const stop = decodeClaudeHook({ hook_event_name: "Stop", session_id: SESSION, last_assistant_message: "private reply" }, 1);
    expect(submit).toEqual({ event: "UserPromptSubmit", sessionId: SESSION, observedAt: 1 });
    expect(stop).toEqual({ event: "Stop", sessionId: SESSION, observedAt: 1 });
    expect(JSON.stringify([submit, stop])).not.toContain("secret");
  });

  test("an unknown event or a malformed session id is dropped", () => {
    expect(decodeClaudeHook({ hook_event_name: "SessionEnd", session_id: SESSION })).toBeNull();
    expect(decodeClaudeHook({ hook_event_name: "Stop", session_id: "../../etc" })).toBeNull();
    expect(decodeClaudeHook("nope")).toBeNull();
  });
});

const agent = (paneId: string, value: string, name = "claude"): AgentView =>
  ({ paneId, agent: name, agentSession: { kind: "id", value } }) as AgentView;

test("paneForSession maps only an unambiguous Claude pane", () => {
  expect(paneForSession([agent("w:1", SESSION), agent("w:2", OTHER)], SESSION)).toBe("w:1");
  expect(paneForSession([agent("w:1", OTHER)], SESSION)).toBeNull();
  expect(paneForSession([agent("w:1", SESSION), agent("w:2", SESSION)], SESSION)).toBeNull();
  expect(paneForSession([agent("w:1", SESSION, "codex")], SESSION)).toBeNull();
});

test("hookTokenMatches refuses missing, empty and different tokens", () => {
  expect(hookTokenMatches("abc", "abc")).toBe(true);
  expect(hookTokenMatches(null, "abc")).toBe(false);
  expect(hookTokenMatches("", "")).toBe(false);
  expect(hookTokenMatches("abd", "abc")).toBe(false);
  expect(hookTokenMatches("abcd", "abc")).toBe(false);
});

test("ClaudeHooks names the pane and keeps a fresh hint until the turn ends", () => {
  const events: LiveEvent[] = [];
  const hooks = new ClaudeHooks({ publish: (e) => events.push(e) });
  const ask = decodeClaudeHook({ hook_event_name: "PermissionRequest", session_id: SESSION, tool_name: "Bash", tool_input: { command: "ls" } }, 1_000)!;
  hooks.receive("s", "w:1", ask);
  expect(events).toEqual([{ session: "s", topic: "pane", paneId: "w:1" }, { session: "s", topic: "interaction", paneId: "w:1" }]);
  expect(hooks.hintFor("s", "w:1", 2_000)?.detail).toBe("ls");
  expect(hooks.hintFor("s", "w:1", 1_000 + 11 * 60_000)).toBeUndefined();
  hooks.receive("s", "w:1", decodeClaudeHook({ hook_event_name: "Stop", session_id: SESSION }, 3_000)!);
  expect(hooks.hintFor("s", "w:1", 3_000)).toBeUndefined();
});

describe("POST /api/hooks/claude", () => {
  const TOKEN = "t".repeat(64);
  let url = "";
  let dir = "";
  const frames: LiveEvent[] = [];
  let pokes = 0;
  let dispose = async () => {};

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "nenu-claude-hooks-"));
    await writeFile(join(dir, CLAUDE_HOOK_TOKEN_FILE), TOKEN + "\n");
    const paneInfo = {
      pane_id: "w:p", terminal_id: "t", workspace_id: "w", tab_id: "tab", focused: false, cwd: dir,
      agent: "claude", agent_status: "working" as const, revision: 0, agent_session: { kind: "id", value: SESSION },
    };
    const herdr = {
      async sessionSnapshot() { return { version: "test", protocol: 22, workspaces: [], panes: [paneInfo], tabs: [] }; },
      async listPanes() { return [paneInfo]; },
      async readPane() { return { text: "", truncated: false, revision: 0 }; },
    };
    const engine = new StateEngine(herdr as unknown as HerdrClient, 60_000);
    engine.start();
    await new Promise<void>((resolve) => engine.onUpdate(() => resolve()));
    const poke = engine.pokeNow.bind(engine);
    engine.pokeNow = () => { pokes++; poke(); };
    const runtime = { name: "default", isPrimary: true, engine, herdr, socketPath: join(dir, "herdr.sock") };
    const live = new LiveEvents();
    live.subscribe((event) => frames.push(event));
    const server = startServer({
      cfg: { ...loadConfig(), host: "127.0.0.1", port: 0, stateDir: dir, transcript: false, trustedUser: "", skipServe: true, allowAnyHost: false, publicHosts: [], tailscaleHosts: [], allowedOrigins: [] },
      registry: { get: () => runtime, list: () => [], all: () => [runtime] },
      push: { enabled: false, publicKey: "", useInteractions: () => {} }, snooze: { until: () => null }, notifyPrefs: { current: () => ({}) },
      updateMonitor: { status: () => ({}), checkRelease: async () => {} },
      audit: { record: () => {} },
      activity: { get: () => undefined, noteSeen: () => {} },
      live,
    } as unknown as Parameters<typeof startServer>[0]);
    url = `http://127.0.0.1:${server.port}${CLAUDE_HOOK_PATH}`;
    dispose = async () => {
      engine.stop();
      await server.stop(true);
      await rm(dir, { recursive: true, force: true });
    };
  });
  afterAll(() => dispose());

  const post = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, { method: "POST", headers: { "content-type": "application/json", [CLAUDE_HOOK_TOKEN_HEADER]: TOKEN, ...headers }, body: JSON.stringify(body) });

  test("a known session answers an empty 204, names the pane and pokes the engine", async () => {
    frames.length = 0;
    pokes = 0;
    const response = await post({ hook_event_name: "Notification", session_id: SESSION, notification_type: "permission_prompt", message: "needs you" });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
    expect(frames.filter((f) => f.paneId === "w:p").map((f) => f.topic)).toEqual(["pane", "interaction"]);
    expect(pokes).toBe(1);
  });

  test("an unknown session is accepted and ignored", async () => {
    frames.length = 0;
    pokes = 0;
    const response = await post({ hook_event_name: "Stop", session_id: OTHER });
    expect(response.status).toBe(204);
    expect(frames).toEqual([]);
    expect(pokes).toBe(0);
  });

  test("no token, a wrong token, a browser Origin or a front-door host is refused", async () => {
    frames.length = 0;
    const body = { hook_event_name: "Stop", session_id: SESSION };
    expect((await post(body, { [CLAUDE_HOOK_TOKEN_HEADER]: "" })).status).toBe(403);
    expect((await post(body, { [CLAUDE_HOOK_TOKEN_HEADER]: "x".repeat(64) })).status).toBe(403);
    expect((await post(body, { origin: "http://127.0.0.1" })).status).toBe(403);
    expect((await post(body, { host: "nenu.tailnet.ts.net" })).status).toBe(403);
    expect((await post(body, { "tailscale-user-login": "me@example.com" })).status).toBe(403);
    expect((await post(body, { "x-forwarded-for": "100.64.0.2" })).status).toBe(403);
    expect(frames).toEqual([]);
  });

  test("without an installed token every delivery is refused", async () => {
    await rm(join(dir, CLAUDE_HOOK_TOKEN_FILE));
    expect((await post({ hook_event_name: "Stop", session_id: SESSION })).status).toBe(403);
    await writeFile(join(dir, CLAUDE_HOOK_TOKEN_FILE), TOKEN);
  });
});
