import { describe, expect, it } from "vitest";

import { BY_FOLDER, destinationFolder, destinationLabel, destinationTarget, liveDestination, takesFolder, type Places } from "./start-destination";
import type { AgentView } from "./types";

const pane = (paneId: string, workspaceId: string, tabId: string, cwd: string, lastActiveAt = 0): AgentView =>
  ({ paneId, workspaceId, workspaceLabel: workspaceId, workspaceNumber: 1, tabId, agent: "claude", status: "idle", cwd, focused: false, lastActiveAt });

const places: Places = {
  workspaces: [
    { workspaceId: "w1", number: 1, label: "Nenu", focused: true, activeTabId: "t1", tabCount: 2, paneCount: 3 },
    { workspaceId: "w2", number: 2, label: "", focused: false, activeTabId: "t3", tabCount: 1, paneCount: 1 },
  ],
  tabs: [
    { tabId: "t1", workspaceId: "w1", number: 1, label: "1", focused: true, paneCount: 2 },
    { tabId: "t2", workspaceId: "w1", number: 2, label: "review", focused: false, paneCount: 1 },
    { tabId: "t3", workspaceId: "w2", number: 1, label: "", focused: true, paneCount: 1 },
  ],
  agents: [pane("p1", "w1", "t1", "/code/nenu", 5), pane("p2", "w1", "t2", "/code/nenu-wt", 9)],
  shellPanes: [pane("p3", "w2", "t3", "/srv")],
};

describe("destinationTarget", () => {
  it("by folder joins the workspace working there, else opens one", () => {
    expect(destinationTarget(BY_FOLDER, "/code/nenu", places)).toEqual({ target: { kind: "tab", workspaceId: "w1" }, cwd: "/code/nenu", name: "" });
    expect(destinationTarget(BY_FOLDER, "/elsewhere", places)).toEqual({ target: { kind: "workspace" }, cwd: "/elsewhere", name: "" });
  });

  it("a quick chat makes the scratch workspace on home once, then is a tab of it, whatever the folder", () => {
    expect(destinationTarget({ kind: "quick" }, "/code/nenu", places)).toEqual({ target: { kind: "workspace" }, cwd: "", name: "scratch" });
    const scratch = { ...places, workspaces: [...places.workspaces, { workspaceId: "w9", number: 9, label: "Scratch", focused: false, activeTabId: "t9", tabCount: 1, paneCount: 1 }] };
    expect(destinationTarget({ kind: "quick" }, "/code/nenu", scratch)).toEqual({ target: { kind: "tab", workspaceId: "w9" }, cwd: "", name: "" });
    expect(takesFolder({ kind: "quick" })).toBe(false);
  });

  it("a workspace, tab or pane destination opens where it says, in the folder given", () => {
    expect(destinationTarget({ kind: "workspace" }, "/code/nenu", places).target).toEqual({ kind: "workspace" });
    expect(destinationTarget({ kind: "tab", workspaceId: "w2" }, "/srv", places)).toEqual({ target: { kind: "tab", workspaceId: "w2" }, cwd: "/srv", name: "" });
    expect(destinationTarget({ kind: "pane", tabId: "t2" }, "/x", places)).toEqual({ target: { kind: "pane", tabId: "t2" }, cwd: "/x", name: "" });
  });
});

describe("liveDestination", () => {
  it("keeps a destination that still exists and falls back to the folder for one closed since", () => {
    expect(liveDestination({ kind: "pane", tabId: "t2" }, places)).toEqual({ kind: "pane", tabId: "t2" });
    expect(liveDestination({ kind: "pane", tabId: "gone" }, places)).toBe(BY_FOLDER);
    expect(liveDestination({ kind: "tab", workspaceId: "gone" }, places)).toBe(BY_FOLDER);
    expect(liveDestination({ kind: "quick" }, places)).toEqual({ kind: "quick" });
  });
});

describe("destinationFolder", () => {
  it("is where the workspace's or tab's last-moved pane works, and nothing for the rest", () => {
    expect(destinationFolder({ kind: "tab", workspaceId: "w1" }, places)).toBe("/code/nenu-wt");
    expect(destinationFolder({ kind: "pane", tabId: "t1" }, places)).toBe("/code/nenu");
    expect(destinationFolder({ kind: "pane", tabId: "t3" }, places)).toBe("/srv");
    expect(destinationFolder({ kind: "workspace" }, places)).toBeNull();
  });
});

describe("destinationLabel", () => {
  it("names each place as the sidebar does", () => {
    expect(destinationLabel(BY_FOLDER, places)).toBe("By folder");
    expect(destinationLabel({ kind: "tab", workspaceId: "w2" }, places)).toBe("New tab in Workspace 2");
    expect(destinationLabel({ kind: "pane", tabId: "t2" }, places)).toBe("Beside Nenu › review");
    expect(destinationLabel({ kind: "pane", tabId: "t3" }, places)).toBe("Beside Workspace 2 › Tab 1");
  });
});
