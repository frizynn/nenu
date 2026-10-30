import { describe, expect, it } from "vitest";

import { currentMachine, isMachineSession, machineSearch, otherMachines, shownHerd } from "@/lib/machines";
import type { AgentView, MachineView, TabView, WorkspaceView } from "@/lib/types";

const chat = (paneId: string, terminalTitle: string): AgentView => ({
  paneId, terminalTitle, workspaceId: "w1", workspaceLabel: "api", workspaceNumber: 1, tabId: "w1:t1", agent: "claude", status: "idle", cwd: "/", focused: false,
});
const herd = (title: string) => ({ bridge: "connected" as const, agents: [chat("w1:p1", title)], shellPanes: [], workspaces: [], tabs: [] });

const MACHINES: MachineView[] = [
  { label: "studio", state: "connected" },
  { session: "@build-box", label: "build-box", state: "connected", herd: herd("Release notes") },
  { session: "@lab", label: "lab", state: "offline", detail: "ssh: connect to host lab port 22: Connection refused" },
];

describe("machines", () => {
  it("a machine's session is the one that starts with @", () => {
    expect(isMachineSession("@build-box")).toBe(true);
    expect(isMachineSession("default")).toBe(false);
    expect(isMachineSession(undefined)).toBe(false);
  });

  it("names the machine on screen, and only when there is more than one", () => {
    expect(currentMachine({ machines: MACHINES })?.label).toBe("studio");
    expect(currentMachine({ machines: MACHINES, session: "@build-box" })?.label).toBe("build-box");
    expect(currentMachine({})).toBeUndefined();
  });

  it("lists every other machine, offline ones included", () => {
    expect(otherMachines({ machines: MACHINES }).map((m) => m.label)).toEqual(["build-box", "lab"]);
    expect(otherMachines({ machines: MACHINES, session: "@build-box" }).map((m) => m.label)).toEqual(["studio", "lab"]);
    expect(otherMachines({})).toEqual([]);
  });

  it("finds another machine's chats, keyed apart from this one's", () => {
    const groups = machineSearch({ machines: MACHINES }, "release");
    expect(groups.map((g) => [g.label, g.machine.label, g.hits.map((h) => h.key)])).toEqual([["Chats", "build-box", ["@build-box|pane:w1:p1"]]]);
  });

  describe("joined machines (herdr-core)", () => {
    const row = (paneId: string, session: string) => ({ ...chat(paneId, paneId), session });
    const space = (workspaceId: string, session: string) => ({ workspaceId, number: 1, label: workspaceId, focused: false, activeTabId: "", tabCount: 1, paneCount: 1, session });
    const JOINED: MachineView[] = [
      { label: "mac", sessions: ["", "hc"], state: "connected", herd: { bridge: "connected", agents: [row("w1:p1", ""), row("t6", "hc")], shellPanes: [], workspaces: [space("w1", ""), space("hc", "hc")], tabs: [] } },
      { label: "rise-l", sessions: ["hc@rise-l"], state: "connected", herd: { bridge: "connected", agents: [row("rise-l:t7", "hc@rise-l")], shellPanes: [], workspaces: [space("rise-l:s", "hc@rise-l")], tabs: [] } },
      { label: "lab", sessions: ["hc@lab"], state: "offline" },
    ];
    const page = { agents: [chat("w1:p1", "only this session")], shellPanes: [] as AgentView[], workspaces: [] as WorkspaceView[], tabs: [] as TabView[], machines: JOINED, session: undefined };

    it("shows every machine's chats at once, each opening in its own session, another machine's named", () => {
      const shown = shownHerd(page, "");
      expect(shown.agents.map((a) => [a.paneId, a.session, a.machine])).toEqual([
        ["w1:p1", "", undefined], ["t6", "hc", undefined], ["rise-l:t7", "hc@rise-l", "rise-l"],
      ]);
      expect(shown.workspaces.map((w) => w.machine)).toEqual([undefined, undefined, "rise-l"]);
    });

    it("one machine picked shows its sessions joined, unnamed; a machine no longer listed shows them all", () => {
      expect(shownHerd(page, "mac").agents.map((a) => [a.paneId, a.machine])).toEqual([["w1:p1", undefined], ["t6", undefined]]);
      expect(shownHerd(page, "gone").agents).toHaveLength(3);
    });

    it("a joined machine is listed apart only while out of reach, and the page's machine is the one holding its session", () => {
      expect(otherMachines(page).map((m) => m.label)).toEqual(["lab"]);
      expect(currentMachine({ machines: JOINED, session: "hc" })?.label).toBe("mac");
      expect(currentMachine({ machines: JOINED })?.label).toBe("mac");
      expect(currentMachine({ machines: JOINED, session: "hc@rise-l" })?.label).toBe("rise-l");
    });

    it("without joined machines the snapshot's own herd shows", () => {
      const own = { ...page, machines: MACHINES };
      expect(shownHerd(own, "")).toBe(own);
    });
  });
});
