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
  } });
}

describe("Codex terminal identity", () => {
  test("matches the full live title and real directory, including the working spinner", async () => {
    expect(await sessions([thread]).match({ ...pane, terminalTitle: "⠸ Fix parser | tmp" }, info)).toBe(id);
    expect(await sessions([thread]).match({ ...pane, terminalTitle: "Fix pars | tmp" }, info)).toBeNull();
    expect(await sessions([{ ...thread, cwd: "/" }]).match(pane, info)).toBeNull();
  });
  test("rejects duplicate names and incomplete loaded lists", async () => {
    expect(await sessions([thread, { ...thread, id: other }]).match(pane, info)).toBeNull();
    expect(await sessions([thread], "next").match(pane, info)).toBeNull();
  });
  test("does not use a subagent, shell title, missing process or invalid ID", async () => {
    expect(await sessions([{ ...thread, parentThreadId: other }]).match(pane, info)).toBeNull();
    expect(await sessions([{ ...thread, id: "invalid" }]).match(pane, info)).toBeNull();
    expect(await sessions([thread]).match(pane, { foreground_processes: [{ pid: 123, argv: ["echo", "codex"] }] })).toBeNull();
    expect(await sessions([thread]).match({ ...pane, terminalTitle: undefined }, info)).toBeNull();
  });
  test("rechecks loaded conversations and follows a switch inside the same process", async () => {
    const resolver = sessions([thread, { ...thread, id: other, name: "Other task" }]);
    expect(await resolver.match(pane, info)).toBe(id);
    expect(await resolver.match({ ...pane, terminalTitle: "Other task | tmp" }, info)).toBe(other);
    expect(await resolver.match({ ...pane, terminalTitle: "Codex | tmp" }, info)).toBeNull();
  });
});

test("shares concurrent identity reads but reloads the inventory on the next poll", async () => {
  let lists = 0;
  const resolver = new CodexSessions({ request: async (method) => {
    if (method === "thread/loaded/list") { lists++; await Bun.sleep(10); return { data: [id], nextCursor: null }; }
    return { thread };
  } });
  expect(await Promise.all([resolver.match(pane, info), resolver.match(pane, info), resolver.match(pane, info)])).toEqual([id, id, id]);
  expect(lists).toBe(1);
  expect(await resolver.match(pane, info)).toBe(id);
  expect(lists).toBe(2);
});
