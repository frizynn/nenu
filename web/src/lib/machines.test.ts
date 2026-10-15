import { describe, expect, it } from "vitest";

import { currentMachine, isMachineSession, machineSearch, otherMachines } from "@/lib/machines";
import type { AgentView, MachineView } from "@/lib/types";

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
});
