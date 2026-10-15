import { describe, expect, it } from "vitest";

import type { AgentView, TabView, WorkspaceView } from "@/lib/types";
import { opensDirectly, tabFolds, tabStartsOpen, workspaceTree } from "./workspace-tree";

function workspace(workspaceId: string, number: number): WorkspaceView {
  return { workspaceId, number, label: workspaceId, focused: false, activeTabId: `${workspaceId}:t`, tabCount: 1, paneCount: 1 };
}

function pane(paneId: string, workspaceId: string, times: { active?: number; seen?: number } = {}): AgentView {
  return {
    paneId, workspaceId, workspaceLabel: workspaceId, workspaceNumber: 1, tabId: `${workspaceId}:t`, agent: "claude", status: "idle",
    cwd: "/", focused: false, lastActiveAt: times.active, lastSeenAt: times.seen,
  };
}

const tab = (workspaceId: string): TabView => ({ tabId: `${workspaceId}:t`, workspaceId, number: 1, label: "main", focused: false, paneCount: 1 });

describe("workspaceTree", () => {
  it("puts the workspace whose agent moved last first, and only marks the one on screen", () => {
    const herd = {
      workspaces: [workspace("old", 1), workspace("here", 2), workspace("busy", 3), workspace("visited", 4)],
      tabs: [tab("old"), tab("here"), tab("busy"), tab("visited")],
      agents: [
        pane("old:p", "old", { active: 10, seen: 5 }),
        pane("here:p", "here", { active: 20, seen: 30 }),
        pane("busy:p", "busy", { active: 90, seen: 1 }),
        pane("visited:p", "visited", { active: 2, seen: 60 }),
      ],
      shellPanes: [],
    };
    const branches = workspaceTree(herd, "here:p");
    expect(branches.map((branch) => branch.workspace.workspaceId)).toEqual(["busy", "here", "old", "visited"]);
    expect(branches.filter((branch) => branch.current).map((branch) => branch.workspace.workspaceId)).toEqual(["here"]);
  });

  it("keeps a workspace in its place when you open one of its panes", () => {
    const herd = (seen: number) => ({
      workspaces: [workspace("a", 1), workspace("b", 2)],
      tabs: [tab("a"), tab("b")],
      agents: [pane("a:p", "a", { active: 50, seen: 50 }), pane("b:p", "b", { active: 40, seen })],
      shellPanes: [],
    });
    const order = (seen: number, current: string) => workspaceTree(herd(seen), current).map((branch) => branch.workspace.workspaceId);
    // Opening b's pane bumps when it was seen, never where its workspace sits.
    expect(order(40, "a:p")).toEqual(["a", "b"]);
    expect(order(999, "b:p")).toEqual(["a", "b"]);
  });

  it("keeps Herdr's order between workspaces nothing has happened in", () => {
    const herd = {
      workspaces: [workspace("b", 2), workspace("a", 1)],
      tabs: [tab("a"), tab("b")],
      agents: [pane("a:p", "a"), pane("b:p", "b")],
      shellPanes: [],
    };
    expect(workspaceTree(herd).map((branch) => branch.workspace.workspaceId)).toEqual(["a", "b"]);
  });
});

describe("opensDirectly", () => {
  const shell = (paneId: string, workspaceId: string, tabId: string): AgentView => ({ ...pane(paneId, workspaceId), tabId, agent: "shell", kind: "shell" });
  const tabs = (workspaceId: string, ...ids: string[]): TabView[] => ids.map((tabId, i) => ({ ...tab(workspaceId), tabId, number: i + 1 }));
  const opens = (agents: AgentView[], shellPanes: AgentView[], tabIds: string[]) =>
    opensDirectly(workspaceTree({ workspaces: [workspace("w", 1)], tabs: tabs("w", ...tabIds), agents, shellPanes })[0]!);

  it("opens a workspace holding one session, whatever else its tabs hold but shells", () => {
    expect(opens([pane("a", "w")], [], ["w:t"])).toBe(true);
    // Tabs of shells alone add nothing to unfold.
    expect(opens([pane("a", "w")], [shell("s1", "w", "w:shells"), shell("s2", "w", "w:more")], ["w:t", "w:shells", "w:more"])).toBe(true);
    // One tab stays one tap, split into several sessions or not.
    expect(opens([pane("a", "w"), pane("b", "w")], [shell("s", "w", "w:t")], ["w:t"])).toBe(true);
  });

  it("unfolds two sessions in two tabs, and shells alone in two tabs", () => {
    expect(opens([pane("a", "w"), { ...pane("b", "w"), tabId: "w:u", status: "done" }], [], ["w:t", "w:u"])).toBe(false);
    expect(opens([], [shell("s1", "w", "w:t"), shell("s2", "w", "w:u")], ["w:t", "w:u"])).toBe(false);
  });
});

describe("a workspace's tabs", () => {
  const at = (paneId: string, tabId: string, status: AgentView["status"] = "idle", kind?: "shell"): AgentView =>
    ({ ...pane(paneId, "w"), tabId, status, ...(kind ? { agent: "shell", kind } : {}) });
  const tabs = (...labels: string[]): TabView[] => labels.map((label, i) => ({ ...tab("w"), tabId: `w:${label}`, number: i + 1, label }));
  const crew = (workers: AgentView["status"][]) => workspaceTree({
    workspaces: [workspace("w", 1)],
    tabs: tabs("lead", "server", "workers"),
    agents: [at("lead", "w:lead"), ...workers.map((status, i) => at(`worker${i}`, "w:workers", status))],
    shellPanes: [at("server", "w:server", "unknown", "shell")],
  })[0]!;

  it("makes a tab of two or more panes a row that folds them, and leaves a one-pane tab its pane's row", () => {
    const branch = crew(["working", "done", "blocked", "idle"]);
    expect(branch.tabs.map((tab) => [tab.label, tabFolds(tab.panes.length, branch.tabs.length)]))
      .toEqual([["lead", false], ["server", false], ["workers", true]]);
    // A lone tab has nothing beside it to tell its panes apart from: it never gets a row of its own.
    expect(tabFolds(4, 1)).toBe(false);
  });

  it("counts a tab's agents as a workspace's, shells left out", () => {
    const split = workspaceTree({
      workspaces: [workspace("w", 1)], tabs: tabs("one", "mixed"),
      agents: [at("a", "w:one"), at("b", "w:mixed", "working"), at("c", "w:mixed", "blocked")],
      shellPanes: [at("s", "w:mixed", "unknown", "shell")],
    })[0]!;
    expect(split.tabs.map((tab) => tab.counts)).toEqual([
      { agents: 1, blocked: 0, working: 0, done: 0 },
      { agents: 2, blocked: 1, working: 1, done: 0 },
    ]);
  });

  it("opens an untouched tab that folds when it holds the pane on screen or one that needs you, and folds it otherwise", () => {
    const workers = (branch: ReturnType<typeof crew>) => branch.tabs.find((tab) => tab.label === "workers")!.panes;
    expect(tabStartsOpen(workers(crew(["working", "done", "blocked", "idle"])))).toBe(true);
    expect(tabStartsOpen(workers(crew(["working", "done", "idle"])))).toBe(false);
    expect(tabStartsOpen(workers(crew(["working", "done", "idle"])), "worker2")).toBe(true);
    expect(tabStartsOpen(workers(crew(["working", "done", "idle"])), "lead")).toBe(false);
  });
});
