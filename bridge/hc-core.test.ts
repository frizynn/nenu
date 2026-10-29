import { describe, expect, test } from "bun:test";

import { hcAddress, hcAgentStatus, hcCounters, hcPaneId, hcProcessInfo, hcSnapshot, type HcAppDoc, type HcTerminal } from "./hc-core.ts";

// Shapes as `hc connect` returned them on hc 0.1.13 (terminal.list, doc.get "herdr-app"), trimmed.
const claude: HcTerminal = {
  address: "t6",
  state: "live",
  cwd: "/Users/u",
  pid: 77145,
  name: null,
  title: "Herdr app frente a herdr",
  labels: { "herdr.space": "sp1", "herdr.tab": "tb1", where: "~ / 1" },
  status: { app: "claude-code", state: "working" },
  foreground: { pid: 80390, name: "2.1.312", argv: ["claude", "--resume"], cwd: "/Users/u/repo" },
  turn: 12,
};
const doc: HcAppDoc = {
  spaces: [{ id: "sp1", name: "", folder: "/Users/u", tabs: [{ id: "tb1", name: "" }, { id: "tb2", name: "PRs" }] }],
};

describe("hcSnapshot", () => {
  test("a Herdr.app terminal is an agent pane in its space and tab", () => {
    const snap = hcSnapshot([claude], new Map([["", doc]]), new Map([["t6", "uuid-1"]]));
    expect(snap.panes).toEqual([{
      pane_id: "t6",
      terminal_id: "t6",
      workspace_id: "sp1",
      tab_id: "tb1",
      focused: false,
      cwd: "/Users/u",
      foreground_cwd: "/Users/u/repo",
      agent: "claude",
      agent_status: "working",
      terminal_title: "Herdr app frente a herdr",
      revision: 0,
      agent_session: { agent: "claude", kind: "id", value: "uuid-1" },
    }]);
    // A space with no name reads as its folder; a tab with no terminal is left out.
    expect(snap.workspaces.map((w) => [w.workspace_id, w.label, w.tab_count, w.pane_count])).toEqual([["sp1", "u", 1, 1]]);
    expect(snap.tabs.map((t) => [t.tab_id, t.label])).toEqual([["tb1", "1"]]);
  });

  test("a terminal Herdr.app did not place sits in one `hc` space per machine", () => {
    const shell: HcTerminal = { address: "t9", state: "live", cwd: "/tmp", status: null, foreground: null };
    const remote: HcTerminal = { ...shell, address: "box/t2", status: { app: "codex", state: "blocked" } };
    const snap = hcSnapshot([shell, remote], new Map());
    expect(snap.panes.map((p) => [p.pane_id, p.workspace_id, p.agent, p.agent_status])).toEqual([
      ["t9", "hc", null, "unknown"],
      ["box:t2", "box:hc", "codex", "blocked"],
    ]);
    expect(snap.workspaces.map((w) => [w.label, w.number])).toEqual([["hc", 1], ["hc box", 2]]);
  });

  test("finished terminals are not panes", () => {
    expect(hcSnapshot([{ ...claude, state: "finished" }], new Map([["", doc]])).panes).toEqual([]);
  });
});

test("hc's state words map onto Herdr's, an error waiting on a person as blocked does", () => {
  expect(["idle", "working", "blocked", "done", "error", "later"].map((state) => hcAgentStatus({ state }))).toEqual([
    "idle", "working", "blocked", "done", "blocked", "unknown",
  ]);
  expect(hcAgentStatus(null)).toBe("unknown");
});

describe("hcCounters", () => {
  const at = (state: string, turn: number) => hcCounters({ ...claude, status: { app: "claude-code", state }, turn });

  test("a turn that started and ended between two polls still moves state_change_seq", () => {
    // Seen working on turn 3, then working again on turn 4: the status word never changed.
    expect(at("working", 4).state_change_seq).not.toBe(at("working", 3).state_change_seq);
    expect(at("idle", 4).state_change_seq).not.toBe(at("idle", 3).state_change_seq);
  });

  test("every move in and out of a turn bumps it, and only a finished turn completes", () => {
    const seq = [at("idle", 0), at("working", 1), at("done", 1), at("working", 2), at("idle", 2)];
    expect(seq.map((c) => c.state_change_seq)).toEqual([0, 1, 2, 3, 4]);
    expect(seq.map((c) => c.completion_seq)).toEqual([0, 0, 1, 1, 2]);
  });

  test("the snapshot carries them for agent terminals only", () => {
    const shell: HcTerminal = { address: "t9", state: "live", cwd: "/tmp", status: null };
    expect(hcSnapshot([claude, shell], new Map()).agents?.map((a) => a.pane_id)).toEqual(["t6"]);
  });
});

test("Herdr.app's own space and tab names win over folder and position", () => {
  const named: HcAppDoc = { spaces: [{ id: "sp1", name: "nenu", folder: "/Users/u", tabs: [{ id: "tb1", name: "chat" }] }] };
  const snap = hcSnapshot([claude], new Map([["", named]]));
  expect(snap.workspaces.map((w) => w.label)).toEqual(["nenu"]);
  expect(snap.tabs.map((t) => t.label)).toEqual(["chat"]);
});

test("a document tab with no terminal, or a block that is not one, is left out without breaking the rest", () => {
  const odd = { spaces: [{ id: "sp1", tabs: [{ id: "tb2", name: "PRs", root: { content: { mod: "prs" } } }, { id: "tb1" }] }, { id: "empty" }] } as HcAppDoc;
  const snap = hcSnapshot([claude], new Map([["", odd]]));
  expect(snap.tabs.map((t) => [t.tab_id, t.label])).toEqual([["tb1", "2"]]);
  expect(snap.workspaces.map((w) => w.workspace_id)).toEqual(["sp1"]);
});

test("a machine's address round-trips through a pane id without a slash", () => {
  expect(hcPaneId("box/t7")).toBe("box:t7");
  expect(hcAddress(hcPaneId("box/t7"))).toBe("box/t7");
  expect(hcAddress("t7")).toBe("t7");
});

test("process info names the foreground leader the way pane.process_info does", () => {
  expect(hcProcessInfo(claude)).toEqual({
    pane_id: "t6",
    shell_pid: 77145,
    foreground_process_group_id: 80390,
    foreground_processes: [{ pid: 80390, name: "2.1.312", argv0: "claude", argv: ["claude", "--resume"], cmdline: "claude --resume", cwd: "/Users/u/repo" }],
  });
});
