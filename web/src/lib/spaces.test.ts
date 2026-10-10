import {
  groupPanesByTab,
  neighborTab,
  paneAfterClose,
  shownTab,
  soloPane,
  spaceLastSeenMap,
  tabName,
  workspaceFolder,
} from "./spaces";
import type { AgentView, TabView } from "./types";

function agent(
  partial: Partial<AgentView> & { paneId: string; workspaceId: string; tabId: string },
): AgentView {
  return {
    workspaceLabel: "ws",
    workspaceNumber: 1,
    agent: "claude",
    status: "idle",
    cwd: "/home/you/demo",
    focused: false,
    ...partial,
  };
}

const tab = (tabId: string, workspaceId: string, number: number): TabView => ({
  tabId,
  workspaceId,
  number,
  label: String(number),
  focused: false,
  paneCount: 1,
});

describe("groupPanesByTab", () => {
  const tabs = [tab("w1:t2", "w1", 2), tab("w1:t1", "w1", 1)]; // differs from stable number order

  it("preserves snapshot tab order when grouping panes", () => {
    const a1 = agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1" });
    const a2 = agent({ paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t2" });
    const groups = groupPanesByTab("w1", tabs, [a1, a2], []);
    expect(groups.map((g) => g.tabId)).toEqual(["w1:t2", "w1:t1"]);
    expect(groups[0]!.panes).toEqual([a2]);
    expect(groups[1]!.panes).toEqual([a1]);
  });

  it("includes shell panes alongside agents in their tab", () => {
    const a1 = agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1" });
    const shell = agent({ paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t1", kind: "shell" });
    const group = groupPanesByTab("w1", tabs, [a1], [shell]).find((item) => item.tabId === "w1:t1");
    expect(group!.panes).toEqual([a1, shell]);
  });

  it("collects panes whose tab isn't listed yet into a trailing 'Other panes' group", () => {
    const orphan = agent({ paneId: "w1:p9", workspaceId: "w1", tabId: "w1:tX" });
    const groups = groupPanesByTab("w1", tabs, [orphan], []);
    const last = groups.at(-1)!;
    expect(last.tabId).toBe("w1:other");
    expect(last.label).toBe("Other panes");
    expect(last.panes).toEqual([orphan]);
  });

  it("ignores panes from other workspaces", () => {
    const other = agent({ paneId: "w2:p1", workspaceId: "w2", tabId: "w2:t1" });
    const groups = groupPanesByTab("w1", tabs, [other], []);
    expect(groups.every((g) => g.panes.length === 0)).toBe(true);
  });
});

describe("spaceLastSeenMap", () => {
  it("agrees with spaceLastSeen for every space, in one pass", () => {
    const panes = [
      agent({ paneId: "w1:p1", workspaceId: "w1", tabId: "w1:t1", lastSeenAt: 100 }),
      agent({ paneId: "w1:p2", workspaceId: "w1", tabId: "w1:t1", lastSeenAt: 900 }),
      agent({ paneId: "w2:p1", workspaceId: "w2", tabId: "w2:t1", lastSeenAt: 400 }),
    ];
    const map = spaceLastSeenMap(panes);
    expect(map.get("w1")).toBe(900);
    expect(map.get("w2")).toBe(400);
  });

  it("omits spaces with no panes, which callers read as 0", () => {
    expect(spaceLastSeenMap([]).get("w1")).toBeUndefined();
  });
});

describe("neighborTab", () => {
  // Snapshot order, not number order: w1 reads t3, t1, t2 in Herdr.
  const tabs = [tab("w1:t3", "w1", 3), tab("w1:t1", "w1", 1), tab("w1:t2", "w1", 2), tab("w2:t1", "w2", 1)];

  it("is the tab to the left, else the one to the right, in snapshot order", () => {
    expect(neighborTab(tabs, "w1:t2")).toBe("w1:t1");
    expect(neighborTab(tabs, "w1:t1")).toBe("w1:t3");
    expect(neighborTab(tabs, "w1:t3")).toBe("w1:t1");
  });

  it("stays in the workspace, and is undefined for its only tab or an unknown one", () => {
    expect(neighborTab(tabs, "w2:t1")).toBeUndefined();
    expect(neighborTab(tabs, "w9:t1")).toBeUndefined();
  });

  it("skips tabs that closed with it", () => {
    const alive = (id: string) => id !== "w1:t1";
    expect(neighborTab(tabs, "w1:t2", alive)).toBe("w1:t3");
    expect(neighborTab(tabs, "w1:t3", (id) => id === "w2:t1")).toBeUndefined();
  });
});

describe("paneAfterClose", () => {
  const before = [tab("w1:t1", "w1", 1), tab("w1:t2", "w1", 2), tab("w2:t1", "w2", 1)];
  const shell = (paneId: string, tabId: string) => ({ ...agent({ paneId, workspaceId: tabId.split(":")[0]!, tabId }), agent: "shell", kind: "shell" as const });

  it("prefers another pane in its tab, an agent before a shell", () => {
    const now = { tabs: before, agents: [agent({ paneId: "w1:p1c", workspaceId: "w1", tabId: "w1:t1" })], shellPanes: [shell("w1:p1b", "w1:t1")] };
    expect(paneAfterClose({ tabId: "w1:t1" }, before, now)).toBe("w1:p1c");
  });

  it("opens the neighbor tab's pane once its own tab is gone, and nothing once its workspace is", () => {
    const now = { tabs: [before[1]!, before[2]!], agents: [agent({ paneId: "w2:p1", workspaceId: "w2", tabId: "w2:t1" })], shellPanes: [shell("w1:p2", "w1:t2")] };
    expect(paneAfterClose({ tabId: "w1:t1" }, before, now)).toBe("w1:p2");
    expect(paneAfterClose({ tabId: "w1:t1" }, before, { ...now, tabs: [before[2]!], shellPanes: [] })).toBeUndefined();
  });
});

describe("tabName", () => {
  it("names a tab Herdr numbered by position, and keeps a label someone wrote", () => {
    expect(tabName("1", 1)).toBe("Tab 1");
    expect(tabName(" 12 ", 2)).toBe("Tab 12");
    expect(tabName("redesign", 1)).toBe("redesign");
    expect(tabName("v2 review", 1)).toBe("v2 review");
    expect(tabName("  ", 3)).toBe("Tab 3");
  });
});

describe("shownTab", () => {
  const groups = [{ tabId: "w1:t1", label: "a", panes: [] }, { tabId: "w1:t2", label: "b", panes: [] }];

  it("shows the tab asked for, else Herdr's active tab, else the first", () => {
    expect(shownTab(groups, "w1:t1", "w1:t2")?.tabId).toBe("w1:t1");
    expect(shownTab(groups, null, "w1:t2")?.tabId).toBe("w1:t2");
    // A tab closed since the link was made falls back like no ask at all.
    expect(shownTab(groups, "w1:gone", "w1:t2")?.tabId).toBe("w1:t2");
    expect(shownTab(groups, null, "w1:gone")?.tabId).toBe("w1:t1");
    expect(shownTab([], null, "w1:t1")).toBeUndefined();
  });
});

describe("workspaceFolder", () => {
  const at = (paneId: string, cwd: string) => agent({ paneId, workspaceId: "w1", tabId: "w1:t1", cwd });

  it("is the directory most panes sit in, the first one on a tie", () => {
    expect(workspaceFolder([at("w1:a", "/r/wt"), at("w1:b", "/r"), at("w1:c", "/r")])).toBe("/r");
    expect(workspaceFolder([at("w1:a", "/r/wt"), at("w1:b", "/r")])).toBe("/r/wt");
  });

  it("is unknown without a pane that reports one", () => {
    expect(workspaceFolder([])).toBeUndefined();
    expect(workspaceFolder([at("w1:a", "")])).toBeUndefined();
  });
});

describe("soloPane", () => {
  const a = agent({ paneId: "w1:a", workspaceId: "w1", tabId: "w1:t1" });
  const shell = agent({ paneId: "w1:s", workspaceId: "w1", tabId: "w1:t2", kind: "shell" });
  const elsewhere = agent({ paneId: "w2:a", workspaceId: "w2", tabId: "w2:t1" });

  it("is the workspace's only pane, agent or shell", () => {
    expect(soloPane("w1", [a, elsewhere], [])).toBe(a);
    expect(soloPane("w1", [elsewhere], [shell])).toBe(shell);
  });

  it("is nothing when the workspace holds several panes or none", () => {
    expect(soloPane("w1", [a], [shell])).toBeUndefined();
    expect(soloPane("w3", [a, elsewhere], [shell])).toBeUndefined();
  });
});
