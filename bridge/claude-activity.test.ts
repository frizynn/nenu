import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, cp, mkdir, mkdtemp, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AppendTail,
  ClaudeActivity,
  describeTask,
  lastToolFromTail,
  parseTaskNotification,
  resultPreview,
} from "./claude-activity.ts";

// The fixture is this repo's own Claude Code session files, reduced to their structure with every
// free-text value redacted (bridge/test-support/claude-activity). One run finished, one running.
const FIXTURE = join(import.meta.dir, "test-support", "claude-activity");
const SID = "d4d58882-18b1-4ed3-8e38-e1cf7d2ab7a8";
const PROJECT = "-home-user-dev";

let base: string;
let roots: string[];
let tasksBase: string;
let sessionDir: string;
let tasksDir: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "claude-activity-"));
  await cp(FIXTURE, base, { recursive: true });
  roots = [join(base, "projects")];
  tasksBase = join(base, "tmp", "claude-1000");
  sessionDir = join(base, "projects", PROJECT, SID);
  tasksDir = join(tasksBase, PROJECT, SID, "tasks");
});
afterEach(async () => { await rm(base, { recursive: true, force: true }); });

const reader = (now = Date.now, extra: Partial<ConstructorParameters<typeof ClaudeActivity>[1]> = {}) =>
  new ClaudeActivity(roots, { tasksBases: [tasksBase], now, ...extra });

async function listed(activity = reader()) {
  const result = await activity.list(SID);
  if (!result.available) throw new Error(`unavailable: ${result.reason}`);
  return result;
}

describe("list", () => {
  test("rebuilds a finished run from its summary and a running one from its journal", async () => {
    const { workflows } = await listed();
    const done = workflows.find((w) => w.runId === "wf_58bd2e6c-e80")!;
    expect(done).toMatchObject({ name: "nenu-workflows-view-design", taskId: "wmkvmzo35", status: "completed", agentCount: 3, doneCount: 3, durationMs: 1043157, totalTokens: 440267, totalToolCalls: 114 });
    expect(done.phases.map((p) => [p.title, p.agents.map((a) => a.label)])).toEqual([
      ["Research", ["research:claude-data", "research:nenu-today"]],
      ["Design", ["design:activity"]],
    ]);
    expect(done.phases[0]!.agents[0]).toMatchObject({ state: "done", model: "claude-opus-5-5[1m]" });

    const running = workflows.find((w) => w.runId === "wf_fe5d5046-9d2")!;
    expect(running).toMatchObject({ name: "nenu-wave", status: "running", agentCount: 3, doneCount: 0, startedAt: Date.parse("2026-10-10T06:49:13.546Z") });
    expect(running.phases).toHaveLength(1);
    expect(running.phases[0]!.agents.map((a) => [a.label, a.state, a.lastTool])).toEqual([
      ["impl:B1", "running", "Bash · Keep waiting for gate"],
      ["impl:B3", "running", "Bash · Keep waiting for gate"],
      ["impl:B4", "running", "Bash · Keep waiting for gate"],
    ]);
  });

  test("background commands carry their own title, exit code and output flag; workflow tasks stay out", async () => {
    const out = await stat(join(tasksDir, "bclff19e4.output"));
    const { tasks } = await listed(reader(() => out.mtimeMs + 60_000));
    const byId = Object.fromEntries(tasks.map((t) => [t.id, t]));
    expect(byId.b3f8meozt).toMatchObject({ kind: "bash", title: "Typecheck bridge through the gate", status: "failed", exitCode: 144, hasOutput: true });
    expect(byId.bl638tuih).toMatchObject({ kind: "bash", title: "Run CI gates: fmt, clippy, tests, release build", status: "completed", exitCode: 0 });
    expect(byId.b25hn9bvi).toMatchObject({ kind: "monitor", title: "60s baseline run completion", event: "done" });
    expect(byId.bx8ostaai).toMatchObject({ kind: "monitor", title: "F1 gate progress", hasOutput: false });
    expect(byId.bclff19e4).toMatchObject({ kind: "bash", status: "running", hasOutput: true });
    expect(byId.wmkvmzo35).toBeUndefined();
    expect(tasks[0]!.id).toBe("bclff19e4");
  });

  test("an unnotified command that stopped writing is unknown, not running", async () => {
    const out = await stat(join(tasksDir, "bclff19e4.output"));
    const { tasks } = await listed(reader(() => out.mtimeMs + 60 * 60_000));
    expect(tasks.find((t) => t.id === "bclff19e4")!.status).toBe("unknown");
  });

  test("lists only claude.ai artifacts", async () => {
    const { artifacts } = await listed();
    expect(artifacts).toEqual([{ id: "art_redacted_1", url: "https://claude.ai/code/artifact/00000000-redacted", title: "Rediseño Nenu sobre Herdr", icon: "canvas", version: "1791318979-91a7", at: Date.parse("2026-10-10T02:00:00.000Z") }]);
  });

  test("never sends paths the client could follow", async () => {
    expect(JSON.stringify(await listed())).not.toMatch(/\/home\/user|\/tmp\/|output-file|transcriptDir|scriptPath/);
  });

  test("appends are picked up incrementally", async () => {
    const activity = reader();
    await listed(activity);
    const journal = join(sessionDir, "subagents", "workflows", "wf_fe5d5046-9d2", "journal.jsonl");
    await appendFile(journal, `${JSON.stringify({ type: "result", key: "k", agentId: "a2755e6a129ea042e", result: { status: "DONE", changed: ["a", "b"] } })}\n`);
    let running = (await listed(activity)).workflows.find((w) => w.runId === "wf_fe5d5046-9d2")!;
    expect(running.phases[0]!.agents[0]).toMatchObject({ state: "done", resultPreview: "DONE · 2 changed" });
    expect(running.doneCount).toBe(1);

    const notice = `<task-notification>\n<task-id>woxtq1pnu</task-id>\n<status>completed</status>\n<summary>Dynamic workflow "x" completed</summary>\n</task-notification>`;
    await appendFile(join(base, "projects", PROJECT, `${SID}.jsonl`), `${JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "2026-10-10T08:00:00.000Z", content: notice })}\n`);
    running = (await listed(activity)).workflows.find((w) => w.runId === "wf_fe5d5046-9d2")!;
    expect(running.status).toBe("completed");
    // Agents that never returned from a finished run were stopped.
    expect(running.phases[0]!.agents.map((a) => a.state)).toEqual(["done", "failed", "failed"]);
  });

  test("an unknown session, a malformed id and another session's files stay unavailable", async () => {
    const activity = reader();
    expect(await activity.list("not-a-session")).toEqual({ available: false, reason: "no-session" });
    const other = "11111111-2222-3333-4444-555555555555";
    await writeFile(join(base, "projects", PROJECT, `${other}.jsonl`), "");
    const result = await activity.list(other);
    expect(result).toMatchObject({ available: true, workflows: [], artifacts: [] });
  });

  test("a runs directory symlinked out of the session is not read", async () => {
    const outside = join(base, "outside");
    await mkdir(join(outside, "wf_aaaaaaaa-bbb"), { recursive: true });
    await writeFile(join(outside, "wf_aaaaaaaa-bbb", "journal.jsonl"), `${JSON.stringify({ type: "started", agentId: "a1234567890abcdef", label: "leak", phase: "X" })}\n`);
    await rm(join(sessionDir, "subagents", "workflows"), { recursive: true });
    await symlink(outside, join(sessionDir, "subagents", "workflows"));
    const { workflows } = await listed();
    expect(workflows.flatMap((w) => w.phases.flatMap((p) => p.agents.map((a) => a.label)))).not.toContain("leak");
  });
});

describe("workflow detail and task output", () => {
  test("returns each finished agent's return value, read only on demand", async () => {
    const detail = await reader().workflow(SID, "wf_58bd2e6c-e80");
    expect(detail?.workflow.runId).toBe("wf_58bd2e6c-e80");
    expect(Object.keys(detail!.results).sort()).toEqual(["a3d18255abbdddc4f", "a62346b3ec68b1323", "ac510438353edb795"]);
    expect(detail!.results.a62346b3ec68b1323).toHaveProperty("summary", "redacted");
  });

  test("caps an oversized result to a preview", async () => {
    const journal = join(sessionDir, "subagents", "workflows", "wf_fe5d5046-9d2", "journal.jsonl");
    await appendFile(journal, `${JSON.stringify({ type: "result", key: "k", agentId: "a5ecc06a0363074c3", result: { status: "DONE", summary: "x".repeat(40_000) } })}\n`);
    const detail = await reader().workflow(SID, "wf_fe5d5046-9d2");
    expect(detail!.results.a5ecc06a0363074c3).toEqual({ truncated: true, preview: "DONE" });
  });

  test("refuses ids that are not a run or a task of this session", async () => {
    const activity = reader();
    expect(await activity.workflow(SID, "../../etc")).toBeNull();
    expect(await activity.workflow(SID, "wf_00000000-000")).toBeNull();
    expect(await activity.taskOutput(SID, "../x")).toBeNull();
    expect(await activity.taskOutput(SID, "bnotthere1")).toBeNull();
  });

  test("tails a command's output and never follows a symlink", async () => {
    const activity = reader();
    expect(await activity.taskOutput(SID, "b3f8meozt")).toMatchObject({ id: "b3f8meozt", text: "redacted gate output line 1\nredacted line 2\n", truncated: false });
    await writeFile(join(base, "secret.txt"), "secret");
    await symlink(join(base, "secret.txt"), join(tasksDir, "bsymlink1.output"));
    expect(await activity.taskOutput(SID, "bsymlink1")).toBeNull();
    await writeFile(join(tasksDir, "bbig00001.output"), `first line\n${"y".repeat(20_000)}\nlast\n`);
    const big = await activity.taskOutput(SID, "bbig00001");
    expect(big!.truncated).toBe(true);
    expect(big!.text.endsWith("last\n")).toBe(true);
    expect(big!.text).not.toContain("first line");
  });
});

describe("observe", () => {
  test("notifies once per real change and stays quiet otherwise", async () => {
    const fires: (() => void)[] = [];
    const watched: string[] = [];
    const activity = reader(Date.now, {
      debounceMs: 5,
      watch: (path, _recursive, onEvent) => { watched.push(path); fires.push(onEvent); return { close() {} }; },
    });
    let notified = 0;
    await activity.observe(SID, "default\0w1:p1", () => notified++);
    expect(watched).toHaveLength(4);
    const settle = () => new Promise((r) => setTimeout(r, 40));

    fires[0]!();
    await settle();
    expect(notified).toBe(0);

    await appendFile(join(sessionDir, "subagents", "workflows", "wf_fe5d5046-9d2", "journal.jsonl"), `${JSON.stringify({ type: "result", key: "k", agentId: "a50eb3dddf8c58664", result: "ok" })}\n`);
    fires[1]!();
    fires[1]!();
    await settle();
    expect(notified).toBe(1);
    activity.close();
  });

  test("stops watching after the session goes unread", async () => {
    let now = 1_000;
    let closed = 0;
    const fires: (() => void)[] = [];
    const activity = reader(() => now, { watchTtlMs: 100, watch: (_p, _r, onEvent) => { fires.push(onEvent); return { close() { closed++; } }; } });
    await activity.observe(SID, "k", () => {});
    now += 1_000;
    fires[0]!();
    expect(closed).toBe(4);
  });
});

describe("parsers", () => {
  test("a task notification ignores tags inside its result", () => {
    const n = parseTaskNotification("<task-notification>\n<task-id>wabc12345</task-id>\n<status>completed</status>\n<summary>Dynamic workflow &quot;a &amp; b&quot; completed</summary>\n<result>{\"x\":\"</status><status>failed</status>\"}</result>\n<usage>1</usage>\n</task-notification>", 5);
    expect(n).toEqual({ taskId: "wabc12345", toolUseId: undefined, status: "completed", summary: 'Dynamic workflow "a & b" completed', event: undefined, at: 5 });
    expect(parseTaskNotification("<task-id>../../x</task-id>")).toBeNull();
  });

  test("summaries map to kind, title and exit code", () => {
    expect(describeTask('Background command "say "hi"" failed with exit code 2')).toEqual({ kind: "bash", title: 'say "hi"', exitCode: 2 });
    expect(describeTask('Background command "ok" completed (exit code 0)')).toEqual({ kind: "bash", title: "ok", exitCode: 0 });
    expect(describeTask('Monitor "gate" stream ended')).toMatchObject({ kind: "monitor", title: "gate" });
    expect(describeTask('Agent "review" finished')).toMatchObject({ kind: "agent", title: "review" });
    expect(describeTask("Something new")).toMatchObject({ kind: "other", title: "Something new" });
  });

  test("result previews stay generic", () => {
    expect(resultPreview({ status: "PARTIAL", changed: [1, 2], open_issues: [1] })).toBe("PARTIAL · 2 changed · 1 open issues");
    expect(resultPreview({ summary: "short" })).toBe("short");
    expect(resultPreview("  plain  ")).toBe("plain");
    expect(resultPreview(42)).toBeUndefined();
  });

  test("the last tool comes from the newest assistant tool_use", () => {
    const row = (name: string, input: object) => JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name, input }] } });
    expect(lastToolFromTail(`${row("Bash", { description: "old" })}\n${row("Read", { file_path: "/a/b/c.ts" })}\n{"type":"user"}`)).toBe("Read · c.ts");
    expect(lastToolFromTail('partial line {"tool_use"\n')).toBeUndefined();
  });
});

describe("AppendTail", () => {
  test("reads appended complete lines only, and resets when the file is replaced", async () => {
    const tail = new AppendTail();
    const path = join(base, "log.jsonl");
    await writeFile(path, "a\nb\npart");
    expect((await tail.read(path, 1024)).lines).toEqual(["a", "b"]);
    await appendFile(path, "ial\nc\n");
    expect((await tail.read(path, 1024)).lines).toEqual(["partial", "c"]);
    expect((await tail.read(path, 1024)).lines).toEqual([]);
    await rm(path);
    await writeFile(path, "z\n");
    expect(await tail.read(path, 1024)).toMatchObject({ lines: ["z"], reset: true });
  });

  test("a first read of a large file keeps only the newest whole lines", async () => {
    const path = join(base, "big.jsonl");
    await writeFile(path, `${"x".repeat(50)}\nkeep1\nkeep2\n`);
    await utimes(path, new Date(), new Date());
    expect(await new AppendTail().read(path, 14)).toMatchObject({ lines: ["keep1", "keep2"], truncated: true });
  });
});
