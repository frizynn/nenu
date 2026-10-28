import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { statStartTicks } from "./agent-state-sources.ts";
import { AgentStates, lastClaudeGoal, sameProcess, type WatchFn } from "./agent-state.ts";
import * as lines from "./journal/lines.ts";
import type { AgentView, LiveEvent } from "./types.ts";

// The service over real files in a temp dir, with the watcher and the process lookups injected so a
// test fires the change events itself.

const PID = 4242;
const SESSION_ID = "86629802-eb8f-4a01-abec-13644095ba48";
const T0 = Date.parse("2026-10-11T13:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

let dir: string;
let claudeProjects: string;
let sessions: string;
let codexRoot: string;
let transcript: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nenu-agent-state-"));
  claudeProjects = join(dir, "claude", "projects");
  sessions = join(dir, "claude", "sessions");
  codexRoot = join(dir, "codex", "sessions");
  transcript = join(claudeProjects, "-w", `${SESSION_ID}.jsonl`);
  await mkdir(join(claudeProjects, "-w"), { recursive: true });
  await mkdir(sessions, { recursive: true });
  await mkdir(join(codexRoot, "2026", "10", "11"), { recursive: true });
});
afterEach(async () => rm(dir, { recursive: true, force: true }));

/** A watcher registry the test fires by path. */
function watches() {
  const listeners = new Map<string, (event: string, filename: string | null) => void>();
  const watch: WatchFn = (path, onChange) => {
    listeners.set(path, onChange);
    return { close: () => listeners.delete(path) };
  };
  return { watch, fire: (path: string, filename: string | null = null) => listeners.get(path)?.("change", filename), paths: () => [...listeners.keys()] };
}

const pane = (agent: string, extra: Partial<AgentView> = {}): AgentView => ({
  paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "w", workspaceNumber: 1, tabId: "w1:t1", agent, status: "idle", cwd: "/w", focused: false, ...extra,
});
const herdr = (pids: number[]) => ({ processInfo: async () => ({ foreground_processes: pids.map((pid) => ({ pid })) }) });
const sessionFile = (status: string, statusUpdatedAt: number, extra: object = {}) =>
  JSON.stringify({ pid: PID, sessionId: SESSION_ID, kind: "interactive", version: "2.1.296", procStart: "Sun Oct 11 12:59:42 2026", status, statusUpdatedAt, ...extra });
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

function states(w: ReturnType<typeof watches>, extra: Partial<ConstructorParameters<typeof AgentStates>[0]> = {}) {
  const events: LiveEvent[] = [];
  const service = new AgentStates({
    claudeRoots: [claudeProjects],
    codexRoots: [codexRoot],
    live: { publish: (event) => void events.push(event) },
    claudeTranscript: async (id) => (id === SESSION_ID ? transcript : null),
    sameProcess: async () => true,
    openFiles: async () => [],
    watch: w.watch,
    ...extra,
  });
  return { service, events };
}

describe("Claude panes", () => {
  test("follow the session file and the busy transcript, and publish only real changes", async () => {
    const w = watches();
    const { service, events } = states(w);
    await writeFile(join(sessions, `${PID}.json`), sessionFile("idle", T0));
    service.sync("s", herdr([PID]), [pane("claude")]);
    await settle();
    expect(service.get("s", "w1:p1")).toEqual({ running: false, source: "claude-session" });
    expect(events).toEqual([{ session: "s", topic: "snapshot" }, { session: "s", topic: "pane", paneId: "w1:p1" }]);

    // A turn starts: the file flips busy and the transcript gets the prompt.
    await writeFile(transcript, JSON.stringify({ type: "user", timestamp: iso(T0 + 20), message: { content: "write an essay" } }) + "\n");
    await writeFile(join(sessions, `${PID}.json`), sessionFile("busy", T0 + 10));
    w.fire(sessions, `${PID}.json`);
    await settle();
    expect(service.get("s", "w1:p1")).toEqual({ running: true, queued: null, source: "claude-session" });
    expect(w.paths()).toContain(transcript);

    // The main turn ends but a background agent keeps the session busy.
    events.length = 0;
    await appendFile(transcript, JSON.stringify({ type: "system", subtype: "turn_duration", durationMs: 900, timestamp: iso(T0 + 950) }) + "\n");
    w.fire(transcript);
    await settle();
    expect(service.get("s", "w1:p1")).toEqual({ running: false, background: true, source: "claude-session" });
    expect(events.map((e) => e.topic)).toEqual(["snapshot", "pane"]);

    // Idle: the transcript watch closes, the directory watch stays.
    await writeFile(join(sessions, `${PID}.json`), sessionFile("idle", T0 + 2_000));
    w.fire(sessions, `${PID}.json`);
    await settle();
    expect(service.get("s", "w1:p1")).toEqual({ running: false, source: "claude-session" });
    expect(w.paths()).toEqual([sessions]);
    service.close();
    expect(w.paths()).toEqual([]);
  });

  test("a dialog reads as waiting, and the transcript is not followed for it", async () => {
    const w = watches();
    const { service } = states(w);
    await writeFile(join(sessions, `${PID}.json`), sessionFile("waiting", T0, { waitingFor: "permission prompt" }));
    service.sync("s", herdr([PID]), [pane("claude")]);
    await settle();
    expect(service.get("s", "w1:p1")).toEqual({ running: false, waiting: "permission prompt", source: "claude-session" });
    expect(w.paths()).toEqual([sessions]);
  });

  test("a file left by another process with the same pid is not trusted", async () => {
    const w = watches();
    const { service } = states(w, { sameProcess: async () => false });
    await writeFile(join(sessions, `${PID}.json`), sessionFile("busy", T0));
    service.sync("s", herdr([PID]), [pane("claude")]);
    await settle();
    expect(service.get("s", "w1:p1")).toBeUndefined();
  });

  test.skipIf(process.platform !== "linux")("on Linux a session file maps by the start ticks /proc holds, with no spawn", async () => {
    const pid = process.pid;
    const ticks = statStartTicks(await Bun.file(`/proc/${pid}/stat`).text());
    expect(ticks).not.toBeNull();
    const spawn = spyOn(Bun, "spawn");
    try {
      const w = watches();
      const { service } = states(w, { sameProcess: undefined });
      await writeFile(join(sessions, `${pid}.json`), sessionFile("idle", T0, { pid, procStart: ticks }));
      service.sync("s", herdr([pid]), [pane("claude")]);
      await settle();
      expect(service.get("s", "w1:p1")).toEqual({ running: false, source: "claude-session" });

      // A file left by a crashed Claude whose pid now belongs to another process is not trusted.
      const other = states(watches(), { sameProcess: undefined });
      await writeFile(join(sessions, `${pid}.json`), sessionFile("idle", T0, { pid, procStart: String(Number(ticks) + 1) }));
      other.service.sync("s", herdr([pid]), [pane("claude")]);
      await settle();
      expect(other.service.get("s", "w1:p1")).toBeUndefined();
      expect(spawn).not.toHaveBeenCalled();
      service.close();
      other.service.close();
    } finally { spawn.mockRestore(); }
  });

  test("a start in ps form is checked with ps", async () => {
    const spawn = spyOn(Bun, "spawn");
    try {
      expect(await sameProcess(process.pid, "Sun Oct 11 12:59:42 2026")).toBe(false);
      expect(spawn).toHaveBeenCalledTimes(1);
    } finally { spawn.mockRestore(); }
  });

  test("fresh() reads the file even when no watch event came", async () => {
    const w = watches();
    const { service } = states(w);
    await writeFile(join(sessions, `${PID}.json`), sessionFile("idle", T0));
    service.sync("s", herdr([PID]), [pane("claude")]);
    await settle();
    await writeFile(join(sessions, `${PID}.json`), sessionFile("busy", T0 + 10));
    expect(await service.fresh("s", pane("claude"), herdr([PID]))).toMatchObject({ running: true });
  });

  test("a session file created after the pane was seen is picked up by the directory watch", async () => {
    const w = watches();
    const { service } = states(w);
    service.sync("s", herdr([PID]), [pane("claude")]);
    await settle();
    expect(service.get("s", "w1:p1")).toBeUndefined();
    await writeFile(join(sessions, `${PID}.json`), sessionFile("idle", T0));
    w.fire(sessions, `${PID}.json`);
    await settle();
    expect(service.get("s", "w1:p1")).toMatchObject({ running: false });
  });

  test("a closed pane is dropped with its watchers", async () => {
    const w = watches();
    const { service } = states(w);
    await writeFile(join(sessions, `${PID}.json`), sessionFile("idle", T0));
    service.sync("s", herdr([PID]), [pane("claude")]);
    await settle();
    service.sync("s", herdr([PID]), []);
    expect(service.get("s", "w1:p1")).toBeUndefined();
    expect(w.paths()).toEqual([]);
  });
});

describe("Claude panes at their usage limit", () => {
  const OTHER_PID = 4343;
  const OTHER_ID = "0c3e2a6d-1b7a-4f1e-9d55-3c1f2e7a9b10";
  const RESETS = 1792632000 * 1000;
  const NOW = Date.parse("2026-10-21T21:45:00.000Z");
  // A loaded machine can take longer than settle()'s fixed wait: these look until the state says so.
  const until = async (test: () => boolean) => { for (let i = 0; i < 100 && !test(); i++) await settle(); };
  const limited = async () => (await readFile(join(import.meta.dirname, "test-support", "agent-state", "claude-2.1.306-transcript-usage-limit.jsonl"), "utf8")).split("\n").slice(0, 8).join("\n") + "\n";

  test("a Claude at rest reads its limit from the transcript, and a reply on its account clears it", async () => {
    const w = watches();
    const other = join(claudeProjects, "-w", `${OTHER_ID}.jsonl`);
    let now = NOW;
    const { service, events } = states(w, { now: () => now, claudeTranscript: async (id) => (id === SESSION_ID ? transcript : id === OTHER_ID ? other : null) });
    await writeFile(transcript, await limited());
    await writeFile(join(sessions, `${PID}.json`), sessionFile("idle", NOW - 60_000));
    await writeFile(join(sessions, `${OTHER_PID}.json`), JSON.stringify({ pid: OTHER_PID, sessionId: OTHER_ID, kind: "interactive", procStart: "Sun Oct 11 12:59:42 2026", status: "idle", statusUpdatedAt: NOW - 60_000 }));
    await writeFile(other, "");
    const herdrs = { processInfo: async (paneId: string) => ({ foreground_processes: [{ pid: paneId === "w1:p1" ? PID : OTHER_PID }] }) };
    service.sync("s", herdrs, [pane("claude"), pane("claude", { paneId: "w1:p2" })]);
    await until(() => service.get("s", "w1:p1")?.limit !== undefined && service.get("s", "w1:p2") !== undefined);
    expect(service.get("s", "w1:p1")).toEqual({ running: false, limit: { resetsAt: RESETS }, source: "claude-session" });
    expect(service.get("s", "w1:p2")).toEqual({ running: false, source: "claude-session" });

    // The account is switched and the other Claude gets a reply through: the first is free again.
    events.length = 0;
    now = Date.parse("2026-10-21T22:00:30.000Z");
    await writeFile(join(sessions, `${OTHER_PID}.json`), JSON.stringify({ pid: OTHER_PID, sessionId: OTHER_ID, kind: "interactive", procStart: "Sun Oct 11 12:59:42 2026", status: "busy", statusUpdatedAt: now - 20_000 }));
    w.fire(sessions, `${OTHER_PID}.json`);
    await settle();
    await appendFile(other, JSON.stringify({ type: "assistant", timestamp: "2026-10-21T22:00:15.612Z", message: { content: [{ type: "text", text: "on it" }] } }) + "\n");
    w.fire(other);
    await until(() => service.get("s", "w1:p1")?.limit === undefined);
    expect(service.get("s", "w1:p1")).toEqual({ running: false, source: "claude-session" });
    expect(events).toContainEqual({ session: "s", topic: "pane", paneId: "w1:p1" });
    service.close();
  });

  test("the limit drops on its own when the reset passes", async () => {
    const w = watches();
    let now = RESETS - 50;
    const { service } = states(w, { now: () => now });
    await writeFile(transcript, await limited());
    await writeFile(join(sessions, `${PID}.json`), sessionFile("idle", NOW));
    service.sync("s", herdr([PID]), [pane("claude")]);
    await until(() => service.get("s", "w1:p1")?.limit !== undefined);
    expect(service.get("s", "w1:p1")?.limit).toEqual({ resetsAt: RESETS });
    now = RESETS + 1;
    // The timer is set for the reset plus a second; waiting it out here would be slow.
    service.poke("s", "w1:p1");
    await until(() => service.get("s", "w1:p1")?.limit === undefined);
    expect(service.get("s", "w1:p1")?.limit).toBeUndefined();
    service.close();
  });
});

describe("Claude panes at their usage limit, timers and races", () => {
  const until = async (test: () => boolean) => { for (let i = 0; i < 100 && !test(); i++) await settle(); };
  const limitRow = (at: number, resetsAt: number) =>
    JSON.stringify({ type: "assistant", timestamp: iso(at), apiError: "usage_limit_reached", isApiErrorMessage: true, quotaLimits: { resetsAt: resetsAt / 1000 }, message: { model: "<synthetic>", content: [] } }) + "\n";

  test("a limit row further back than the first short look is still found", async () => {
    const w = watches();
    const { service } = states(w, { now: () => T0 });
    // A long row after the limit (a big paste typed into the terminal) pushes it past the first look.
    const long = JSON.stringify({ type: "system", subtype: "informational", timestamp: iso(T0 - 500), content: "x".repeat(200 * 1024) }) + "\n";
    await writeFile(transcript, limitRow(T0 - 1_000, T0 + 3_600_000) + long);
    await writeFile(join(sessions, `${PID}.json`), sessionFile("idle", T0));
    service.sync("s", herdr([PID]), [pane("claude")]);
    await until(() => service.get("s", "w1:p1")?.limit !== undefined);
    expect(service.get("s", "w1:p1")).toEqual({ running: false, limit: { resetsAt: T0 + 3_600_000 }, source: "claude-session" });
    service.close();
  });

  test("a resting Claude whose last reply is near the end is read only that far", async () => {
    const read = spyOn(lines, "readAppended");
    try {
      const w = watches();
      const { service } = states(w, { now: () => T0 });
      const long = JSON.stringify({ type: "system", subtype: "informational", timestamp: iso(T0 - 2_000), content: "x".repeat(200 * 1024) }) + "\n";
      const reply = JSON.stringify({ type: "assistant", timestamp: iso(T0 - 1_000), message: { stop_reason: "end_turn", content: [] } }) + "\n";
      await writeFile(transcript, long + reply);
      await writeFile(join(sessions, `${PID}.json`), sessionFile("idle", T0));
      service.sync("s", herdr([PID]), [pane("claude")]);
      await until(() => read.mock.calls.length > 0 && service.get("s", "w1:p1") !== undefined);
      await settle();
      expect(read.mock.calls.map((call) => call[1])).toEqual([64 * 1024]);

      // A short transcript with no reply yet was read whole by the first look: no second read.
      read.mockClear();
      await writeFile(transcript, JSON.stringify({ type: "user", timestamp: iso(T0), message: { content: "hi" } }) + "\n");
      const other = states(watches(), { now: () => T0 });
      other.service.sync("s", herdr([PID]), [pane("claude")]);
      await until(() => read.mock.calls.length > 0 && other.service.get("s", "w1:p1") !== undefined);
      await settle();
      expect(read.mock.calls.map((call) => call[1])).toEqual([64 * 1024]);
      service.close();
      other.service.close();
    } finally { read.mockRestore(); }
  });

  test("a reset weeks away arms a timer of an hour at most, never one past 2^31 ms", async () => {
    const w = watches();
    const timer = spyOn(globalThis, "setTimeout");
    try {
      const { service } = states(w, { now: () => T0 });
      await writeFile(transcript, limitRow(T0 - 1_000, T0 + 40 * 86_400_000));
      await writeFile(join(sessions, `${PID}.json`), sessionFile("idle", T0));
      service.sync("s", herdr([PID]), [pane("claude")]);
      await until(() => service.get("s", "w1:p1")?.limit !== undefined);
      expect(service.get("s", "w1:p1")?.limit).toEqual({ resetsAt: T0 + 40 * 86_400_000 });
      const delays = timer.mock.calls.map((call) => call[1] ?? 0);
      expect(Math.max(...delays)).toBeLessThanOrEqual(3_600_000);
      service.close();
    } finally { timer.mockRestore(); }
  });

  test("a turn that starts while the look at rest is still finding the transcript keeps its watch", async () => {
    const w = watches();
    let release!: () => void;
    const found = new Promise<void>((resolve) => { release = resolve; });
    // The look at rest asks first and hears last: the busy spell's own lookup answers at once.
    let calls = 0;
    const { service } = states(w, { claudeTranscript: async (id) => { if (calls++ === 0) await found; return id === SESSION_ID ? transcript : null; } });
    await writeFile(transcript, JSON.stringify({ type: "user", timestamp: iso(T0 + 20), message: { content: "go" } }) + "\n");
    await writeFile(join(sessions, `${PID}.json`), sessionFile("idle", T0));
    service.sync("s", herdr([PID]), [pane("claude")]);
    await settle();
    // The look at rest is waiting on the lookup; the session turns busy and follows the transcript too.
    await writeFile(join(sessions, `${PID}.json`), sessionFile("busy", T0 + 10));
    w.fire(sessions, `${PID}.json`);
    await settle();
    await until(() => service.get("s", "w1:p1")?.running === true && w.paths().includes(transcript));
    release();
    await settle();
    expect(w.paths()).toContain(transcript);
    // The watched tail is the one the state reads: the turn's end shows.
    await appendFile(transcript, JSON.stringify({ type: "assistant", timestamp: iso(T0 + 900), message: { stop_reason: "end_turn", content: [] } }) + "\n");
    w.fire(transcript);
    await until(() => service.get("s", "w1:p1")?.running === false);
    expect(service.get("s", "w1:p1")).toEqual({ running: false, background: true, source: "claude-session" });
    service.close();
  });
});

describe("Claude panes, races and restarts", () => {
  const row = (value: object) => JSON.stringify(value) + "\n";
  const queue = (operation: string, at: number, content?: string) => row({ type: "queue-operation", operation, timestamp: iso(at), ...(content ? { content } : {}) });

  test("two watch events for one append scan it once: the queue drains", async () => {
    const w = watches();
    const { service } = states(w);
    await writeFile(transcript, row({ type: "user", timestamp: iso(T0 + 20), message: { content: "write an essay" } }));
    await writeFile(join(sessions, `${PID}.json`), sessionFile("busy", T0 + 10));
    service.sync("s", herdr([PID]), [pane("claude")]);
    await settle();
    await appendFile(transcript, queue("enqueue", T0 + 100, "After that, say BANANA."));
    w.fire(transcript);
    void service.fresh("s", pane("claude"), herdr([PID]), { remap: false });
    w.fire(transcript);
    await settle();
    expect(service.get("s", "w1:p1")).toMatchObject({ running: true, queued: "sends" });
    // One read of the dequeue: a doubled enqueue would leave a phantom message behind it.
    await appendFile(transcript, queue("dequeue", T0 + 200));
    w.fire(transcript);
    await settle();
    expect(service.get("s", "w1:p1")).toMatchObject({ running: true, queued: null });
  });

  test("a Claude that crashed and restarted in the pane is not read from its old busy file", async () => {
    const w = watches();
    const { service } = states(w);
    const NEW = PID + 1;
    await writeFile(join(sessions, `${PID}.json`), sessionFile("busy", T0));
    let fg = [PID];
    const host = { processInfo: async () => ({ foreground_processes: fg.map((pid) => ({ pid })) }) };
    service.sync("s", host, [pane("claude", { status: "working", stateChangeSeq: 1 })]);
    await settle();
    expect(service.get("s", "w1:p1")).toMatchObject({ running: true });
    // SIGKILL: the old file stays. A new Claude starts in the pane and writes its own, idle.
    fg = [NEW];
    await writeFile(join(sessions, `${NEW}.json`), sessionFile("idle", T0 + 5_000, { pid: NEW }));
    w.fire(sessions, `${NEW}.json`);
    await settle();
    expect(await service.fresh("s", pane("claude"), host)).toEqual({ running: false, source: "claude-session" });
  });

  test("a Herdr status move re-checks the pid, so the restart shows without a Stop", async () => {
    const w = watches();
    let clock = T0;
    const { service } = states(w, { now: () => clock });
    const NEW = PID + 1;
    await writeFile(join(sessions, `${PID}.json`), sessionFile("busy", T0));
    let fg = [PID];
    const host = { processInfo: async () => ({ foreground_processes: fg.map((pid) => ({ pid })) }) };
    service.sync("s", host, [pane("claude", { status: "working", stateChangeSeq: 1 })]);
    await settle();
    fg = [NEW];
    clock += 5_000;
    await writeFile(join(sessions, `${NEW}.json`), sessionFile("idle", T0 + 5_000, { pid: NEW }));
    service.sync("s", host, [pane("claude", { status: "idle", stateChangeSeq: 2 })]);
    await settle();
    expect(service.get("s", "w1:p1")).toEqual({ running: false, source: "claude-session" });
  });

  test("a background agent's dialog answered after the main turn ended keeps it background", async () => {
    const w = watches();
    const { service } = states(w);
    await writeFile(transcript, row({ type: "user", timestamp: iso(T0 + 20), message: { content: "start a background agent" } }) + row({ type: "assistant", timestamp: iso(T0 + 500), message: { stop_reason: "end_turn", content: [] } }));
    await writeFile(join(sessions, `${PID}.json`), sessionFile("busy", T0 + 10));
    service.sync("s", herdr([PID]), [pane("claude")]);
    await settle();
    expect(service.get("s", "w1:p1")).toEqual({ running: false, background: true, source: "claude-session" });
    await writeFile(join(sessions, `${PID}.json`), sessionFile("waiting", T0 + 2_000, { waitingFor: "permission prompt" }));
    w.fire(sessions, `${PID}.json`);
    await settle();
    expect(service.get("s", "w1:p1")).toMatchObject({ running: false, waiting: "permission prompt" });
    await writeFile(join(sessions, `${PID}.json`), sessionFile("busy", T0 + 3_000));
    w.fire(sessions, `${PID}.json`);
    await settle();
    expect(service.get("s", "w1:p1")).toEqual({ running: false, background: true, source: "claude-session" });
  });
});

describe("Claude goal", () => {
  // The real goal rows (test-support/agent-state/*goal*), written as Claude writes them: one compact
  // JSON object per line.
  const goalRows = async (name: string) => (await readFile(join(import.meta.dirname, "test-support", "agent-state", name), "utf8"))
    .split("\n").filter(Boolean).map((row) => JSON.stringify(JSON.parse(row)) + "\n").join("");
  // A long row like Claude's request blobs, and one that quotes a goal row's words inside its text.
  const blob = (bytes: number) => JSON.stringify({ type: "api-request-blob", message: { role: "user", content: "x".repeat(bytes) } }) + "\n";
  const quoting = JSON.stringify({ type: "user", timestamp: iso(T0), message: { content: '{"type":"goal_status","met":false,"condition":"quoted"} and "subtype":"compact_boundary"' } }) + "\n";
  const until = async (test: () => boolean) => { for (let i = 0; i < 100 && !test(); i++) await settle(); };

  test("the backward look finds the newest goal row across chunks, past long rows and quoted words", async () => {
    const cases: [string, string | null][] = [
      ["claude-2.1.310-goal-active.jsonl", "Merge what is pending, deploy, and send me the messages"],
      ["claude-2.1.296-goal-met.jsonl", null],
      ["claude-2.1.296-goal-cleared.jsonl", null],
      ["claude-2.1.308-goal-replaced.jsonl", "Simplify the prompt and keep it human"],
      ["claude-2.1.308-goal-compacted.jsonl", "Hill-climb the prompt to 100% on every case"],
    ];
    for (const [name, condition] of cases) {
      await writeFile(transcript, blob(5_000) + (await goalRows(name)) + blob(3_000) + quoting + blob(700) + quoting);
      // Chunks smaller than the long rows, which are dropped while read, so rows straddle chunks.
      for (const chunk of [1_024, 4_096, 1024 * 1024]) {
        expect(await lastClaudeGoal(transcript, chunk)).toEqual(condition === null ? null : { condition });
      }
    }
  });

  test("the backward look ends a goal by its met row, as a forward read does", async () => {
    const met = (await goalRows("claude-2.1.296-goal-met.jsonl")).split("\n").slice(0, 6).join("\n") + "\n";
    await writeFile(transcript, met + blob(3_000));
    expect(await lastClaudeGoal(transcript, 1_024)).toBeNull();
    // Without its met row, the same log holds the goal it set.
    await writeFile(transcript, met.split("\n").slice(0, 5).join("\n") + "\n" + blob(3_000));
    expect(await lastClaudeGoal(transcript, 1_024)).toEqual({ condition: "Add a benchmark per agent and merge it" });
  });

  test("a goal set before a compaction that did not restate it is gone; a log with no goal row has none", async () => {
    const boundary = JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: iso(T0) }) + "\n";
    await writeFile(transcript, (await goalRows("claude-2.1.310-goal-active.jsonl")) + boundary + blob(2_000));
    expect(await lastClaudeGoal(transcript, 1_024)).toBeNull();
    await writeFile(transcript, blob(2_000) + quoting);
    expect(await lastClaudeGoal(transcript, 1_024)).toBeNull();
  });

  test("a Claude at rest shows the goal its log holds far back, watches for it to clear, and stops watching then", async () => {
    const w = watches();
    const { service } = states(w);
    // The goal sits further back than the look at rest reads (1 MB), behind a reply.
    const reply = JSON.stringify({ type: "assistant", timestamp: iso(T0 + 5), message: { model: "claude-opus-5-5", stop_reason: "end_turn", content: [] } }) + "\n";
    await writeFile(transcript, (await goalRows("claude-2.1.310-goal-active.jsonl")) + blob(1_100_000) + reply);
    await writeFile(join(sessions, `${PID}.json`), sessionFile("idle", T0 + 10));
    service.sync("s", herdr([PID]), [pane("claude")]);
    await until(() => service.get("s", "w1:p1")?.goal !== undefined);
    expect(service.get("s", "w1:p1")).toEqual({ running: false, source: "claude-session", goal: { condition: "Merge what is pending, deploy, and send me the messages" } });
    expect(w.paths()).toContain(transcript);

    // `/goal clear` at rest: the sentinel row Claude writes, and no session file change.
    const cleared = (await goalRows("claude-2.1.296-goal-cleared.jsonl")).split("\n").slice(4).join("\n");
    await appendFile(transcript, cleared);
    w.fire(transcript);
    await until(() => service.get("s", "w1:p1")?.goal === undefined);
    expect(service.get("s", "w1:p1")).toEqual({ running: false, source: "claude-session" });
    expect(w.paths()).toEqual([sessions]);
    service.close();
  });

  test("a goal set in a turn shows while it runs and stays once the turn ends", async () => {
    const w = watches();
    const { service } = states(w);
    await writeFile(transcript, reply0());
    await writeFile(join(sessions, `${PID}.json`), sessionFile("idle", T0));
    service.sync("s", herdr([PID]), [pane("claude")]);
    await until(() => service.get("s", "w1:p1") !== undefined);
    expect(service.get("s", "w1:p1")?.goal).toBeUndefined();

    await writeFile(join(sessions, `${PID}.json`), sessionFile("busy", T0 + 10));
    w.fire(sessions, `${PID}.json`);
    await settle();
    await appendFile(transcript, (await goalRows("claude-2.1.308-goal-replaced.jsonl")));
    w.fire(transcript);
    await until(() => service.get("s", "w1:p1")?.goal !== undefined);
    expect(service.get("s", "w1:p1")?.goal).toEqual({ condition: "Simplify the prompt and keep it human" });

    await writeFile(join(sessions, `${PID}.json`), sessionFile("idle", T0 + 2_000));
    w.fire(sessions, `${PID}.json`);
    await settle();
    expect(service.get("s", "w1:p1")?.goal).toEqual({ condition: "Simplify the prompt and keep it human" });
    expect(w.paths()).toContain(transcript);
    service.close();
  });

  test("a look at rest that watched the first short tail for a goal leaves no watch behind when the long read replaces it", async () => {
    const open = new Set<number>();
    const listeners = new Map<string, () => void>();
    let next = 0;
    const watch: WatchFn = (path, onChange) => {
      const id = ++next;
      open.add(id);
      listeners.set(path === sessions ? path : `${path}#${id}`, () => onChange("change", path === sessions ? `${PID}.json` : null));
      return { close: () => { open.delete(id); listeners.delete(`${path}#${id}`); } };
    };
    // The goal and the reply sit further back than the first short look reads.
    const reply = JSON.stringify({ type: "assistant", timestamp: iso(T0 + 5), message: { model: "claude-opus-5-5", stop_reason: "end_turn", content: [] } }) + "\n";
    await writeFile(transcript, (await goalRows("claude-2.1.310-goal-active.jsonl")) + reply + blob(200_000));
    await writeFile(join(sessions, `${PID}.json`), sessionFile("idle", T0 + 10));
    const gate = () => { let release!: () => void; let reach!: () => void; const reached = new Promise<void>((r) => (reach = r)); const released = new Promise<void>((r) => (release = r)); return { reach, reached, release, released }; };
    const firstRead = gate();
    const lookups = [gate(), gate()];
    const realRead = lines.readAppended;
    let reads = 0;
    const spy = spyOn(lines, "readAppended").mockImplementation(async (...args: Parameters<typeof realRead>) => {
      if (reads++ === 0) { firstRead.reach(); await firstRead.released; }
      return realRead(...args);
    });
    let calls = 0;
    const { service } = states(watches(), {
      watch,
      claudeTranscript: async (id) => {
        const g = lookups[calls++];
        if (g) { g.reach(); await g.released; }
        return id === SESSION_ID ? transcript : null;
      },
    });
    try {
      service.sync("s", herdr([PID]), [pane("claude")]);
      await lookups[0]!.reached;
      // A second look at rest (the session file was written) while the first finds the transcript.
      listeners.get(sessions)?.();
      await lookups[1]!.reached;
      lookups[0]!.release();
      await firstRead.reached;
      // The second look finds the first one's short tail and, the goal being active, watches it.
      lookups[1]!.release();
      await settle();
      // The first look finds no reply in its short tail and reads the long one into a new tail.
      firstRead.release();
      await until(() => service.get("s", "w1:p1")?.goal !== undefined);
      await settle();
      expect([...listeners.keys()].filter((k) => k.includes(".jsonl"))).toHaveLength(1);
      service.close();
      expect(open.size).toBe(0);
    } finally { spy.mockRestore(); }
  });

  test("the goal's look never holds back the turn, and a failed look is tried again on a later read", async () => {
    const w = watches();
    let release!: (goal: { condition: string } | null) => void;
    let looks = 0;
    let fail = false;
    let clock = T0;
    const { service } = states(w, {
      now: () => clock,
      lastGoal: () => {
        looks++;
        if (fail) return Promise.reject(new Error("EMFILE"));
        return new Promise((resolve) => { release = resolve; });
      },
    });
    await writeFile(transcript, JSON.stringify({ type: "user", timestamp: iso(T0 + 20), message: { content: "go" } }) + "\n");
    await writeFile(join(sessions, `${PID}.json`), sessionFile("busy", T0 + 10));
    service.sync("s", herdr([PID]), [pane("claude")]);
    await until(() => service.get("s", "w1:p1") !== undefined);
    expect(service.get("s", "w1:p1")).toEqual({ running: true, queued: null, source: "claude-session" });
    expect(looks).toBe(1);
    release({ condition: "ship it" });
    await until(() => service.get("s", "w1:p1")?.goal !== undefined);
    expect(service.get("s", "w1:p1")?.goal).toEqual({ condition: "ship it" });
    service.close();

    // Another bridge whose look fails: nothing shows, and a read a minute later looks again.
    fail = true;
    looks = 0;
    const second = states(watches(), { now: () => clock, lastGoal: () => (fail ? Promise.reject(new Error("EMFILE")) : (looks++, Promise.resolve({ condition: "ship it" }))) });
    second.service.sync("s", herdr([PID]), [pane("claude")]);
    await until(() => second.service.get("s", "w1:p1") !== undefined);
    await settle();
    expect(second.service.get("s", "w1:p1")?.goal).toBeUndefined();
    fail = false;
    clock += 61_000;
    await appendFile(transcript, JSON.stringify({ type: "user", timestamp: iso(T0 + 30), message: { content: "more" } }) + "\n");
    expect(await second.service.fresh("s", pane("claude"), herdr([PID]), { remap: false })).toBeDefined();
    await until(() => second.service.get("s", "w1:p1")?.goal !== undefined);
    expect(looks).toBe(1);
    second.service.close();
  });

  const reply0 = () => JSON.stringify({ type: "assistant", timestamp: iso(T0 - 5), message: { model: "claude-opus-5-5", stop_reason: "end_turn", content: [] } }) + "\n";
});

describe("Codex panes", () => {
  const rollout = () => join(codexRoot, "2026", "10", "11", "rollout-2026-10-11T15-04-38-01a12b10-b86b-7781-9182-b55f713c7ee2.jsonl");
  const event = (type: string, turnId: string) => JSON.stringify({ type: "event_msg", payload: { type, turn_id: turnId } }) + "\n";

  test("follow the rollout the process holds open", async () => {
    const w = watches();
    await writeFile(rollout(), event("task_started", "t1"));
    const outside = join(dir, "elsewhere-rollout-2026-10-11T15-04-38-01a12b10-b86b-7781-9182-b55f713c7ee3.jsonl");
    await writeFile(outside, event("task_started", "x"));
    const { service } = states(w, { openFiles: async () => [rollout(), outside] });
    service.sync("s", herdr([7]), [pane("codex", { status: "working" })]);
    await settle();
    expect(service.get("s", "w1:p1")).toEqual({ running: true, source: "codex-rollout" });
    await appendFile(rollout(), event("turn_aborted", "t1"));
    // Watched by its real path (containment resolves symlinks such as macOS's /var → /private/var).
    w.fire(await realpath(rollout()));
    await settle();
    expect(service.get("s", "w1:p1")).toEqual({ running: false, source: "codex-rollout" });
  });

  test("a rollout outside the Codex roots is never read", async () => {
    const w = watches();
    const outside = join(dir, "rollout-2026-10-11T15-04-38-01a12b10-b86b-7781-9182-b55f713c7ee3.jsonl");
    await writeFile(outside, event("task_started", "x"));
    const { service } = states(w, { openFiles: async () => [outside] });
    service.sync("s", herdr([7]), [pane("codex")]);
    await settle();
    expect(service.get("s", "w1:p1")).toBeUndefined();
  });

  test("fresh() re-resolves an idle Codex, so a turn in a /new thread is found", async () => {
    const w = watches();
    const old = join(codexRoot, "2026", "10", "11", "rollout-2026-10-11T15-03-30-01a12b0f-ada4-7d12-b0d2-30807b9fe152.jsonl");
    await writeFile(old, event("task_started", "a") + event("turn_aborted", "a"));
    let open = [old];
    const { service } = states(w, { openFiles: async () => open });
    service.sync("s", herdr([7]), [pane("codex")]);
    await settle();
    expect(service.get("s", "w1:p1")).toMatchObject({ running: false });
    await writeFile(rollout(), event("task_started", "b"));
    open = [old, rollout()];
    expect(await service.fresh("s", pane("codex"), herdr([7]))).toEqual({ running: true, source: "codex-rollout" });
  });

  test("fresh() without remap only re-reads: an idle Codex costs no process lookup per poll", async () => {
    const w = watches();
    await writeFile(rollout(), event("task_started", "a") + event("task_complete", "a"));
    let lookups = 0;
    const { service } = states(w, { openFiles: async () => (lookups++, [rollout()]) });
    service.sync("s", herdr([7]), [pane("codex")]);
    await settle();
    lookups = 0;
    await service.fresh("s", pane("codex"), herdr([7]));
    for (let i = 0; i < 10; i++) await service.fresh("s", pane("codex"), herdr([7]), { remap: false });
    expect(lookups).toBe(1);
  });
});
