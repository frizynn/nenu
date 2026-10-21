import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentStates, type WatchFn } from "./agent-state.ts";
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
    procStart: async () => Date.parse("Sun Oct 11 12:59:42 2026 UTC"),
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
    const { service } = states(w, { procStart: async () => Date.parse("Sun Oct 11 09:00:00 2026 UTC") });
    await writeFile(join(sessions, `${PID}.json`), sessionFile("busy", T0));
    service.sync("s", herdr([PID]), [pane("claude")]);
    await settle();
    expect(service.get("s", "w1:p1")).toBeUndefined();
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
    await settle();
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
    await settle();
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
    await settle();
    expect(service.get("s", "w1:p1")?.limit).toEqual({ resetsAt: RESETS });
    now = RESETS + 1;
    // The timer is set for the reset plus a second; waiting it out here would be slow.
    service.poke("s", "w1:p1");
    await settle();
    expect(service.get("s", "w1:p1")?.limit).toBeUndefined();
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
