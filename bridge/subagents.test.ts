import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSubagents } from "./subagents-claude.ts";
import { CodexSubagents, codexTurnStatus, codexJournalState } from "./subagents-codex.ts";
import { SubagentFiles } from "./subagent-files.ts";
import { Subagents } from "./subagents.ts";
import { recordSubagentEvent } from "../scripts/subagent-hook.ts";
import { subagentHookSettings } from "../scripts/install-subagent-hooks.ts";
import type { AgentView } from "./types.ts";

const parent = "11111111-2222-3333-4444-555555555555";
const other = "99999999-2222-3333-4444-555555555555";
const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "nenu-subagents-")); dirs.push(dir);
  const root = join(dir, "projects"); const project = join(root, "project"); const children = join(project, parent, "subagents");
  await mkdir(children, { recursive: true });
  await writeFile(join(project, `${parent}.jsonl`), JSON.stringify({ sessionId: parent, toolUseResult: { agentId: "child", description: "Review test files", resolvedModel: "test-model", status: "async_launched" } }) + "\n");
  const child = join(children, "agent-child.jsonl");
  await writeFile(child, JSON.stringify({ type: "assistant", uuid: "reply", sessionId: parent, agentId: "child", isSidechain: true, timestamp: new Date().toISOString(), message: { role: "assistant", model: "test-model", content: [{ type: "text", text: "Subagent output" }] } }) + "\n");
  return { dir, root, project, children, child };
}

test("Codex checks ancestry even if the server ignores the filter, including grandchildren and cycles", async () => {
  const rpc = { async request(method: string, params?: Record<string, unknown>) {
    expect(method).toBe("thread/list"); expect(params?.ancestorThreadId).toBe(parent);
    return { data: [
      { id: "grandchild", parentThreadId: "child", status: { type: "active", activeFlags: ["waitingOnApproval"] } },
      { id: "child", parentThreadId: parent, status: { type: "active", activeFlags: [] } },
      { id: "unrelated", parentThreadId: other, status: { type: "active" } },
      { id: "cycle", parentThreadId: "cycle", status: { type: "active" } },
    ] };
  } };
  const list = await new CodexSubagents(rpc).list(parent);
  expect(list.agents.map((a) => [a.id, a.status])).toEqual([["grandchild", "waiting"], ["child", "running"]]);
});

test("Codex child history cannot switch to another parent", async () => {
  const service = new CodexSubagents({ request: async () => ({ thread: { id: "child", parentThreadId: other, turns: [] } }) });
  await expect(service.history({ id: "child", parentId: parent, name: "child", task: "", status: "unknown" })).rejects.toThrow("belongs");
});

test("Claude lifecycle hooks distinguish running/finished, expose child history, and never infer working from a file", async () => {
  const f = await fixture();
  const reader = new ClaudeSubagents([f.root], join(f.dir, "subagents"));
  expect((await reader.list(parent)).agents[0]?.status).toBe("unknown");
  await recordSubagentEvent({ session_id: parent, agent_id: "child", agent_type: "reviewer", hook_event_name: "SubagentStart", prompt: "not persisted" }, f.dir);
  const running = (await reader.list(parent)).agents[0]!;
  expect(running).toMatchObject({ status: "running", name: "reviewer", task: "Review test files", model: "test-model" });
  expect((await reader.history(parent, running)).entries[0]?.parts).toContainEqual({ kind: "text", text: "Subagent output" });
  const stored = await Bun.file(join(f.dir, "subagents", parent, "child.json")).json();
  expect(stored.prompt).toBeUndefined();
  await recordSubagentEvent({ session_id: parent, agent_id: "child", agent_type: "reviewer", hook_event_name: "SubagentStop" }, f.dir);
  expect((await reader.list(parent)).agents[0]?.status).toBe("completed");
});

test("Claude refuses cross-session and symlinked transcripts; stale start becomes unknown", async () => {
  const f = await fixture();
  await symlink(f.child, join(f.children, "agent-linked.jsonl"));
  await writeFile(join(f.children, "agent-other.jsonl"), JSON.stringify({ sessionId: other, agentId: "other" }) + "\n");
  await recordSubagentEvent({ session_id: parent, agent_id: "child", hook_event_name: "SubagentStart" }, f.dir);
  const reader = new ClaudeSubagents([f.root], join(f.dir, "subagents"), () => Date.now() + 180_000);
  const list = await reader.list(parent);
  expect(list.agents.map((a) => [a.id, a.status])).toEqual([["child", "unknown"]]);
  expect((await reader.list(other)).agents).toEqual([]);
  const service = new Subagents({ claude: [f.root], codex: [] }, f.dir);
  const pane: AgentView = { paneId: "w1:p1", workspaceLabel: "QA", workspaceNumber: 1, focused: false, workspaceId: "w1", tabId: "w1:t1", agent: "claude", status: "idle", cwd: f.project, agentSession: { kind: "id", value: parent } };
  await expect(service.history(pane, "../../private")).rejects.toThrow("does not belong");
});

test("bounded file cache handles append, partial JSON and truncation", async () => {
  const f = await fixture(); const file = join(f.dir, "tail"); const cache = new SubagentFiles();
  await writeFile(file, "first\nsecond\n"); expect((await cache.tail(file, 20)).text).toBe("first\nsecond\n");
  await writeFile(file, "first\nsecond\nthird\nfourth\n"); expect((await cache.tail(file, 20)).text).toBe("second\nthird\nfourth\n");
  await writeFile(file, "new\n"); expect((await cache.tail(file, 20)).text).toBe("new\n");
});

test("hook installation preserves existing settings and is idempotent", () => {
  const original = { model: "test", hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "existing" }] }], SubagentStart: [{ matcher: "Explore", hooks: [{ type: "command", command: "other" }] }] } };
  const command = "bun '/nenu/scripts/subagent-hook.ts' '/state'";
  const once = subagentHookSettings(original, command);
  expect(subagentHookSettings(once, command)).toEqual(once);
  expect(once.model).toBe("test");
  expect((once.hooks as typeof original.hooks).PreToolUse).toEqual(original.hooks.PreToolUse);
  expect((once.hooks as typeof original.hooks).SubagentStart[0]).toEqual(original.hooks.SubagentStart[0]);
});


test("native Codex turn completion is authoritative; stale in-progress is unknown", () => {
  const now = Date.now();
  expect(codexTurnStatus({ status: "completed" }, undefined, now)).toBe("completed");
  expect(codexTurnStatus({ status: "inProgress" }, new Date(now).toISOString(), now)).toBe("running");
  expect(codexTurnStatus({ status: "inProgress" }, new Date(now - 180_000).toISOString(), now)).toBe("unknown");
  expect(codexTurnStatus({ status: "failed" }, undefined, now)).toBe("failed");
});


test("Codex native lifecycle wins over an unloaded server and handles resuming", () => {
  const now = Date.now();
  const event = (type: string, time = now) => JSON.stringify({ type: "event_msg", timestamp: new Date(time).toISOString(), payload: { type } });
  expect(codexJournalState(event("task_started"), now)).toBe("running");
  expect(codexJournalState(event("task_started", now - 180_000), now)).toBe("unknown");
  expect(codexJournalState(event("task_started") + "\n" + event("task_complete"), now)).toBe("completed");
  expect(codexJournalState(event("task_complete") + "\n" + event("task_started"), now)).toBe("running");
});
