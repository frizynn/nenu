import { describe, expect, test } from "bun:test";
import { realpath } from "node:fs/promises";
import { ConversationService, explicitSession } from "./conversation-service.ts";
import { matchClaudeSession } from "./claude-sessions.ts";
import { launchAgent, startPaneAgent } from "./agent-start.ts";
import { codexEntries } from "./codex-history.ts";
import type { AgentView } from "./types.ts";

const id = "11111111-2222-3333-4444-555555555555";
const other = "99999999-2222-3333-4444-555555555555";
const pane: AgentView = { paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "QA", workspaceNumber: 1, tabId: "w1:t1", agent: "codex", status: "idle", cwd: "/tmp", focused: false };
const info = (argv: string[], pid = 123) => ({ foreground_processes: [{ argv, pid }] });
const herdr = { processInfo: async () => info(["codex"]), reportSession: async () => {} };

describe("native launch", () => {
  test("only supported choices launch in empty shells", async () => {
    let calls = 0;
    const client = { startAgent: async () => { calls++; } };
    expect(launchAgent({ agent: "codex; touch /tmp/x" })).toBeNull();
    await expect(startPaneAgent(pane, "codex", client)).rejects.toThrow("empty terminal");
    await expect(startPaneAgent(undefined, "claude", client)).rejects.toThrow("empty terminal");
    expect(calls).toBe(0);
  });
  test("keeps Codex hooks in the native process and gives Claude a recoverable id", async () => {
    const calls: string[][] = [];
    const client = { startAgent: async (_pane: string, _kind: string, args: string[] = []) => { calls.push(args); } };
    await startPaneAgent({ ...pane, kind: "shell" }, "codex", client);
    await startPaneAgent({ ...pane, kind: "shell" }, "claude", client);
    expect(calls[0]).toEqual(["--no-daemon"]);
    expect(calls[1]?.[0]).toBe("--session-id");
    expect(calls[1]?.[1]).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("identity recovery", () => {
  test("matches explicit native arguments, never a same-directory guess", () => {
    expect(explicitSession(info(["/bin/claude", "--session-id", id]), "claude")).toBe(id);
    expect(explicitSession(info(["/bin/codex", "resume", "--remote", "unix://", id]), "codex")).toBe(id);
    expect(explicitSession(info(["echo", "resume", id]), "codex")).toBeNull();
    expect(explicitSession(info(["codex", "resume", "--last"]), "codex")).toBeNull();
    expect(explicitSession(info(["codex", "resume", id, other]), "codex")).toBeNull();
  });
  test("Claude attach follows the authoritative process or short id", () => {
    const sessions = [{ id: "abc123", sessionId: id, cwd: "/tmp", pid: 100 }];
    expect(matchClaudeSession(info(["claude", "attach", "abc123"]), sessions)).toBe(id);
    expect(matchClaudeSession(info(["claude"], 100), sessions)).toBe(id);
    expect(matchClaudeSession(info(["other", "attach", "abc123"]), sessions)).toBeNull();
    expect(matchClaudeSession(info(["claude"], 200), sessions)).toBeNull();
  });
  test("recovers an explicit Claude id even if the hook is missing", async () => {
    const service = new ConversationService({ request: async () => { throw new Error("Codex must not run"); } });
    const resolved = await service.resolve({ ...pane, agent: "claude" }, { ...herdr, processInfo: async () => info(["claude", "--session-id", id]) });
    expect(resolved.agentSession).toEqual({ kind: "id", value: id });
  });
  test("refuses cross-directory recovery and process replacement", async () => {
    let reports = 0;
    const client = { ...herdr, reportSession: async () => { reports++; } };
    const elsewhere = new ConversationService({ request: async () => ({ thread: { id, cwd: "/" } }) });
    await expect(elsewhere.attach(pane, id, client)).rejects.toThrow("another directory");
    let reads = 0;
    const changed = { ...client, processInfo: async () => info(["codex"], ++reads) };
    const same = new ConversationService({ request: async () => ({ thread: { id, cwd: "/tmp" } }) });
    await expect(same.attach(pane, id, changed)).rejects.toThrow("terminal changed");
    expect(reports).toBe(0);
    await same.attach(pane, id, client);
    expect((await same.resolve(pane, client)).agentSession?.value).toBe(id);
  });
  test("pages app-server history without resuming it or starting a second agent", async () => {
    const methods: string[] = [];
    const service = new ConversationService({ request: async (method) => {
      methods.push(method);
      return { thread: { id, cwd: await realpath("/tmp"), turns: [{ id: "turn", status: "completed", items: [
        { id: "u", type: "userMessage", content: [{ type: "text", text: "Hello" }] },
        { id: "a", type: "agentMessage", text: "Answer", phase: "final_answer" },
      ] }] } };
    } });
    const connected = { ...pane, agentSession: { kind: "id" as const, value: id } };
    const latest = await service.page(connected, { limit: 1 });
    expect(latest?.entries[0]?.uuid).toBe("a");
    expect(latest?.hasMore).toBe(true);
    const older = await service.page(connected, { limit: 1, before: "a" });
    expect(older?.entries[0]?.uuid).toBe("u");
    expect(methods).toEqual(["thread/read"]);
  });
});

test("structured Codex history hides injected instructions and marks clipped tool output", () => {
  const entries = codexEntries({ turns: [{ id: "turn", status: "inProgress", items: [
    { id: "context", type: "userMessage", content: [{ type: "text", text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>\nhidden\n</INSTRUCTIONS>" }] },
    { id: "cmd", type: "commandExecution", command: "echo test", aggregatedOutput: "a".repeat(21_000), exitCode: 1 },
  ] }] });
  expect(entries).toHaveLength(1);
  expect(entries[0]?.turn?.status).toBe("running");
  expect(entries[0]?.parts[0]).toMatchObject({ result: { truncated: true, isError: true } });
});
