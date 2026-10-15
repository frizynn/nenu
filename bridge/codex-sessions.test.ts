import { describe, expect, test } from "bun:test";
import { CodexSessions } from "./codex-sessions.ts";
import type { AgentView } from "./types.ts";

const id = "11111111-2222-3333-4444-555555555555";
const other = "99999999-2222-3333-4444-555555555555";
const pane: AgentView = { paneId: "p1", workspaceId: "w1", workspaceLabel: "QA", workspaceNumber: 1, tabId: "t1", focused: false, agent: "codex", status: "idle", cwd: "/tmp", terminalTitle: "Fix parser | tmp" };
const info = { foreground_processes: [{ pid: 123, argv: ["/bin/codex"] }] };
const thread = { id, cwd: "/tmp", name: "Fix parser", parentThreadId: null };

function sessions(threads: object[], nextCursor: string | null = null) {
  return new CodexSessions({ request: async (method, params) => {
    if (method === "thread/loaded/list") return { data: threads.map(row => "id" in row ? row.id : null), nextCursor };
    return { thread: threads.find(row => "id" in row && row.id === params?.threadId) };
  } }, async () => []);
}

describe("Codex terminal identity", () => {
  test("matches the full live title and real directory, including the working spinner", async () => {
    expect(await sessions([thread]).identify({ ...pane, terminalTitle: "⠸ Fix parser | tmp" }, info)).toEqual({ id });
    expect(await sessions([thread]).identify({ ...pane, terminalTitle: "Fix pars | tmp" }, info)).toBeNull();
    expect(await sessions([{ ...thread, cwd: "/" }]).identify(pane, info)).toBeNull();
  });
  test("rejects duplicate names and incomplete loaded lists", async () => {
    expect(await sessions([thread, { ...thread, id: other }]).identify(pane, info)).toBeNull();
    expect(await sessions([thread], "next").identify(pane, info)).toBeNull();
  });
  test("does not use a subagent, shell title, missing process or invalid ID", async () => {
    expect(await sessions([{ ...thread, parentThreadId: other }]).identify(pane, info)).toBeNull();
    expect(await sessions([{ ...thread, id: "invalid" }]).identify(pane, info)).toBeNull();
    expect(await sessions([thread]).identify(pane, { foreground_processes: [{ pid: 123, argv: ["echo", "codex"] }] })).toBeNull();
    expect(await sessions([thread]).identify({ ...pane, terminalTitle: undefined }, info)).toBeNull();
  });
  test("rechecks loaded conversations and follows a switch inside the same process", async () => {
    const resolver = sessions([thread, { ...thread, id: other, name: "Other task" }]);
    expect(await resolver.identify(pane, info)).toEqual({ id });
    expect(await resolver.identify({ ...pane, terminalTitle: "Other task | tmp" }, info)).toEqual({ id: other });
    expect(await resolver.identify({ ...pane, terminalTitle: "Codex | tmp" }, info)).toBeNull();
  });
});

test("shares concurrent identity reads but reloads the inventory on the next poll", async () => {
  let lists = 0;
  const resolver = new CodexSessions({ request: async (method) => {
    if (method === "thread/loaded/list") { lists++; await Bun.sleep(10); return { data: [id], nextCursor: null }; }
    return { thread };
  } }, async () => []);
  expect(await Promise.all([resolver.identify(pane, info), resolver.identify(pane, info), resolver.identify(pane, info)])).toEqual([{ id }, { id }, { id }]);
  expect(lists).toBe(1);
  expect(await resolver.identify(pane, info)).toEqual({ id });
  expect(lists).toBe(2);
});

describe("a Codex whose conversation has not started", () => {
  const fresh = { id, cwd: "/tmp", name: null, preview: "", status: { type: "idle" }, parentThreadId: null };
  const begun = { ...fresh, id: other, preview: "Fix the parser" };
  const daemon = (threads: object[], methods: string[] = [], nextCursor: string | null = null) => ({ request: async (method: string, params?: Record<string, unknown>) => {
    methods.push(method);
    if (method === "thread/loaded/list") return { data: threads.map(row => "id" in row ? row.id : null), nextCursor };
    if (method === "thread/read") return { thread: threads.find(row => "id" in row && row.id === params?.threadId) };
    // The folder's earlier sessions: only a picker lists them, identity never reads them.
    if (method === "thread/list") return { data: [{ id: other }], nextCursor: null };
    throw new Error(`Unexpected request: ${method}`);
  } });
  const none = async () => [];
  const rollout = (session: string) => `/home/user/.codex/sessions/2026/10/15/rollout-2026-10-15T14-25-54-${session}.jsonl`;

  test("a Codex just opened in a folder with earlier sessions has not started, and takes none of them", async () => {
    const methods: string[] = [];
    const resolver = new CodexSessions(daemon([fresh], methods), none);
    expect(await resolver.identify({ ...pane, terminalTitle: "tmp" }, info)).toEqual({ notStarted: true });
    expect(await resolver.identify({ ...pane, terminalTitle: "⠸ tmp" }, info)).toEqual({ notStarted: true });
    expect(methods).not.toContain("thread/list");
  });
  test("an unnamed conversation already running in the folder leaves the choice to the operator", async () => {
    expect(await new CodexSessions(daemon([fresh, begun]), none).identify({ ...pane, terminalTitle: "tmp" }, info)).toBeNull();
    const working = { ...fresh, status: { type: "active", activeFlags: [] } };
    expect(await new CodexSessions(daemon([working]), none).identify({ ...pane, terminalTitle: "tmp" }, info)).toBeNull();
    const older = { ...fresh, preview: undefined };
    expect(await new CodexSessions(daemon([older]), none).identify({ ...pane, terminalTitle: "tmp" }, info)).toBeNull();
  });
  test("a named title, a remote server, a partial or unreadable inventory never reads as not started", async () => {
    expect(await new CodexSessions(daemon([fresh]), none).identify({ ...pane, terminalTitle: "Fix parser | tmp" }, info)).toBeNull();
    expect(await new CodexSessions(daemon([fresh]), none).identify({ ...pane, terminalTitle: "tmp" }, { foreground_processes: [{ pid: 123, argv: ["/bin/zsh"] }] })).toBeNull();
    expect(await new CodexSessions(daemon([fresh]), none).identify({ ...pane, terminalTitle: "tmp" }, { foreground_processes: [{ pid: 123, argv: ["/bin/codex", "--remote", "ws://host:9000"] }] })).toBeNull();
    expect(await new CodexSessions(daemon([fresh], [], "next"), none).identify({ ...pane, terminalTitle: "tmp" }, info)).toBeNull();
    const offline = new CodexSessions({ request: async () => { throw new Error("Offline"); } }, none);
    expect(await offline.identify({ ...pane, terminalTitle: "tmp" }, info)).toBeNull();
  });
  test("a native Codex is read from the rollout it holds open, never from the daemon's titles", async () => {
    const native = { foreground_processes: [{ pid: 7, argv: ["node", "/bin/codex", "--no-daemon"] }, { pid: 8, argv: ["/vendor/bin/codex", "--no-daemon"] }] };
    const asked: number[][] = [];
    const holds = (files: string[]) => async (pids: number[]) => { asked.push(pids); return files; };
    const named = { id: other, cwd: "/tmp", name: "Fix parser", preview: "Fix the parser", status: { type: "idle" }, parentThreadId: null };
    const methods: string[] = [];
    const resolver = new CodexSessions(daemon([named], methods), holds([rollout(id), "/dev/null", "/tmp/notes.jsonl"]));
    expect(await resolver.identify({ ...pane, terminalTitle: "Fix parser | tmp" }, native)).toEqual({ id });
    expect(asked).toEqual([[8]]);
    expect(methods).toEqual([]);
    expect(await new CodexSessions(daemon([named]), none).identify({ ...pane, terminalTitle: "tmp" }, native)).toEqual({ notStarted: true });
    // A name says a turn ran, so a rollout it does not hold is a state to show the operator, not a new chat.
    expect(await new CodexSessions(daemon([named]), none).identify({ ...pane, terminalTitle: "Fix parser | tmp" }, native)).toBeNull();
    expect(await new CodexSessions(daemon([named]), holds([rollout(id), rollout(other)])).identify(pane, native)).toBeNull();
  });
});

describe("two Codex at once in the same folder", () => {
  const panes = { a: { ...pane, paneId: "pa", terminalTitle: "tmp" }, b: { ...pane, paneId: "pb", terminalTitle: "tmp" } };
  const runs = (pid: number, ...flags: string[]) => ({ foreground_processes: [{ pid, argv: ["/bin/codex", ...flags] }] });

  test("native: each is bound to the rollout its own process holds", async () => {
    const files: Record<number, string[]> = {
      1: [`/s/2026/10/15/rollout-2026-10-15T14-25-54-${id}.jsonl`],
      2: [`/s/2026/10/15/rollout-2026-10-15T14-25-58-${other}.jsonl`],
    };
    const resolver = new CodexSessions({ request: async () => { throw new Error("no daemon"); } }, async (pids) => pids.flatMap(pid => files[pid] ?? []));
    expect(await resolver.identify(panes.a, runs(1, "--no-daemon"))).toEqual({ id });
    expect(await resolver.identify(panes.b, runs(2, "--no-daemon"))).toEqual({ id: other });
  });
  test("on the shared daemon: neither takes the other's while both are new, each its own once named", async () => {
    const threads = [
      { id, cwd: "/tmp", name: null as string | null, preview: "", status: { type: "idle" }, parentThreadId: null },
      { id: other, cwd: "/tmp", name: null as string | null, preview: "", status: { type: "idle" }, parentThreadId: null },
    ];
    const resolver = new CodexSessions({ request: async (method, params) => {
      if (method === "thread/loaded/list") return { data: threads.map(row => row.id), nextCursor: null };
      return { thread: threads.find(row => row.id === params?.threadId) };
    } }, async () => []);
    expect(await resolver.identify(panes.a, runs(1))).toEqual({ notStarted: true });
    expect(await resolver.identify(panes.b, runs(2))).toEqual({ notStarted: true });
    threads[0] = { ...threads[0]!, name: "Fix parser", preview: "Fix the parser" };
    threads[1] = { ...threads[1]!, name: "Release notes", preview: "Write the notes" };
    expect(await resolver.identify({ ...panes.a, terminalTitle: "Fix parser | tmp" }, runs(1))).toEqual({ id });
    expect(await resolver.identify({ ...panes.b, terminalTitle: "Release notes | tmp" }, runs(2))).toEqual({ id: other });
  });
});
