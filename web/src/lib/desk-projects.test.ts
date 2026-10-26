import { describe, expect, it } from "vitest";

import { groupByProject, projectName, projectWeight } from "./desk-projects";
import type { AgentView } from "./types";

const pane = (paneId: string, extra: Partial<AgentView>): AgentView =>
  ({ paneId, workspaceId: "w", workspaceLabel: "ws", workspaceNumber: 1, tabId: "t", agent: "claude", status: "idle", cwd: "/", focused: false, ...extra });

describe("projectName", () => {
  it("takes the bridge's name, else the folder's, else the workspace's", () => {
    expect(projectName(pane("a", { project: "shop", cwd: "/w/shop-clone" }))).toBe("shop");
    expect(projectName(pane("a", { cwd: "/w/site/" }))).toBe("site");
    expect(projectName(pane("a", { cwd: "", workspaceLabel: "scratch" }))).toBe("scratch");
    expect(projectName(pane("a", { cwd: "/", workspaceLabel: "scratch" }))).toBe("scratch");
  });
});

describe("groupByProject", () => {
  it("joins names that differ only in case, keeps the order given and says the most pressing state", () => {
    const panes = [pane("a", { project: "Shop", status: "done" }), pane("b", { project: "notes" }), pane("c", { project: "shop", status: "blocked" })];
    const groups = groupByProject(panes, (p) => p);
    expect(groups.map((g) => [g.label, g.items.map((p) => p.paneId), g.state])).toEqual([["Shop", ["a", "c"], "blocked"], ["notes", ["b"], undefined]]);
  });
});

describe("projectWeight", () => {
  it("puts what needs you above what works above the rest, each by its last move", () => {
    const [needs, works, rests] = groupByProject([
      pane("a", { project: "a", status: "blocked", lastActiveAt: 1 }),
      pane("b", { project: "b", status: "working", lastActiveAt: 5 }),
      pane("c", { project: "c", status: "done", lastActiveAt: 9 }),
    ], (p) => p);
    const at = (p: AgentView) => p.lastActiveAt ?? 0;
    expect(projectWeight(needs!, at)).toBeGreaterThan(projectWeight(works!, at));
    expect(projectWeight(works!, at)).toBeGreaterThan(projectWeight(rests!, at));
  });
});
