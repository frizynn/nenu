import { render, screen, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import type { HomeData } from "@/lib/loaders";
import type { AgentView, MachineView } from "@/lib/types";
import { ComposerPlace } from "./composer-chips";
import { SessionSwitcher } from "./session-switcher";
import { WorkbenchSidebar } from "./workbench-sidebar";

const chat = (paneId: string, terminalTitle: string, status: AgentView["status"] = "idle"): AgentView => ({
  paneId, terminalTitle, workspaceId: "w1", workspaceLabel: "api", workspaceNumber: 1, tabId: "w1:t1", agent: "claude", status, cwd: "/", focused: false, lastActiveAt: 10,
});

const LOCAL: Pick<HomeData, "agents" | "shellPanes" | "workspaces" | "tabs"> = {
  agents: [chat("w1:p1", "Checkout flow")],
  shellPanes: [],
  workspaces: [{ workspaceId: "w1", number: 1, label: "api", focused: false, activeTabId: "w1:t1", tabCount: 1, paneCount: 1 }],
  tabs: [{ tabId: "w1:t1", workspaceId: "w1", number: 1, label: "main", focused: true, paneCount: 1 }],
};

const MACHINES: MachineView[] = [
  { label: "studio", state: "connected" },
  { session: "@build-box", label: "build-box", state: "connected", herd: { bridge: "connected", agents: [chat("w1:p1", "Release notes", "working")], shellPanes: [], workspaces: LOCAL.workspaces, tabs: LOCAL.tabs } },
  { session: "@lab", label: "lab", state: "offline", detail: "ssh: connect to host lab port 22: Connection refused" },
];

const data = (machines?: MachineView[], session?: string) => ({
  ...LOCAL, bridge: "connected", projects: [], sessions: [], session, error: false, authError: false, machines,
} as unknown as HomeData);

function sidebar(home: HomeData, variant: "sidebar" | "drawer" = "sidebar") {
  const router = createMemoryRouter([{ path: "/", element: <WorkbenchSidebar data={home} variant={variant} /> }], { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
}

beforeEach(() => localStorage.clear());

describe("more than one machine", () => {
  it("the sidebar lists each other machine under its name, its chats opening there", async () => {
    sidebar(data(MACHINES));
    const box = within(await screen.findByRole("region", { name: "build-box" }));
    expect(box.getByRole("link", { name: /Release notes/ }).getAttribute("href")).toBe("/pane/w1%3Ap1?s=%40build-box");
  });

  it("a machine SSH cannot reach is listed with ssh's reason, and this machine's chats stay", async () => {
    sidebar(data(MACHINES), "drawer");
    const lab = within(await screen.findByRole("region", { name: "lab" }));
    expect(lab.getByText("ssh: connect to host lab port 22: Connection refused")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: /Checkout flow/ })[0]!.getAttribute("href")).toBe("/pane/w1%3Ap1");
  });

  it("the footer names the machine on screen, not the browser's host", async () => {
    sidebar(data(MACHINES, "@build-box"));
    await screen.findByRole("region", { name: "studio" });
    expect(screen.getByText("build-box", { selector: ".nav-host-name" })).toBeTruthy();
  });

  it("with one machine nothing is added", () => {
    sidebar(data(undefined));
    expect(screen.queryByRole("region", { name: "build-box" })).toBeNull();
    expect(document.querySelector("[data-machine]")).toBeNull();
  });

  it("the composer's machine is the pane's", () => {
    render(<ComposerPlace machine="build-box" />);
    expect(screen.getByText("build-box")).toBeTruthy();
  });

  it("a machine is not a Herdr session: the session switcher stays out of it", () => {
    const router = createMemoryRouter([{ path: "/", element: <SessionSwitcher sessions={[{ name: "default", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 0 }]} current="@build-box" /> }]);
    render(<RouterProvider router={router} />);
    expect(screen.queryByRole("button", { name: /Session/ })).toBeNull();
  });
});
