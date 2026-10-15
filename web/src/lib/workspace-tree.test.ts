import { describe, expect, it } from "vitest";

import type { AgentView, TabView, WorkspaceView } from "@/lib/types";
import { opensDirectly, workspaceTree } from "./workspace-tree";

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
