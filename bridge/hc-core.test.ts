import { describe, expect, test } from "bun:test";

import { hcAddress, hcAgentStatus, hcPaneId, hcProcessInfo, hcSnapshot, type HcAppDoc, type HcTerminal } from "./hc-core.ts";

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

test("hc's state words map onto Herdr's, error reading as unknown", () => {
  expect(["idle", "working", "blocked", "done", "error"].map((state) => hcAgentStatus({ state }))).toEqual([
    "idle", "working", "blocked", "done", "unknown",
  ]);
  expect(hcAgentStatus(null)).toBe("unknown");
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
