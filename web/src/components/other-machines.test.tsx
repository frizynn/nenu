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
  ...LOCAL, bridge: "connected", sessions: [], session, error: false, authError: false, machines,
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
    localStorage.setItem("nenu:sidebar-view:v1", JSON.stringify({ view: "time" }));
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
    expect(screen.getByRole("button", { name: "Where this runs: build-box" })).toBeTruthy();
  });

  it("a machine is not a Herdr session: the session switcher stays out of it", () => {
    const router = createMemoryRouter([{ path: "/", element: <SessionSwitcher sessions={[{ name: "default", isPrimary: true, reachable: true, agents: 1, working: 0, blocked: 0 }]} current="@build-box" /> }]);
    render(<RouterProvider router={router} />);
    expect(screen.queryByRole("button", { name: /Session/ })).toBeNull();
  });
});

describe("herdr-core's machines (ADR 0135)", () => {
  const at = (paneId: string, title: string, session: string, workspaceId: string, label: string): AgentView => ({ ...chat(paneId, title), session, workspaceId, workspaceLabel: label, tabId: `${workspaceId}:t` });
  const space = (workspaceId: string, label: string, session: string) => ({ workspaceId, number: 1, label, focused: false, activeTabId: `${workspaceId}:t`, tabCount: 1, paneCount: 1, session });
  const tab = (workspaceId: string, session: string) => ({ tabId: `${workspaceId}:t`, workspaceId, number: 1, label: "1", focused: false, paneCount: 1, session });
  const JOINED: MachineView[] = [
    { label: "mac", sessions: ["", "hc"], state: "connected", herd: { bridge: "connected",
      agents: [at("w1:p1", "Checkout flow", "", "w1", "api"), at("t6", "Herdr app", "hc", "s1", "nenu")], shellPanes: [],
      workspaces: [space("w1", "api", ""), space("s1", "nenu", "hc")], tabs: [tab("w1", ""), tab("s1", "hc")] } },
    { label: "rise-l", sessions: ["hc@rise-l"], state: "connected", herd: { bridge: "connected",
      agents: [at("rise-l:t7", "Brief hats", "hc@rise-l", "rise-l:s2", "hats")], shellPanes: [],
      workspaces: [space("rise-l:s2", "hats", "hc@rise-l")], tabs: [tab("rise-l:s2", "hc@rise-l")] } },
  ];
  const href = (name: RegExp) => screen.getAllByRole("link", { name })[0]!.getAttribute("href");

  it("the bar lists every machine's chats at once, each opening in its own session, and names no session", async () => {
    localStorage.setItem("nenu:sidebar-view:v1", JSON.stringify({ view: "time" }));
    sidebar(data(JOINED, "hc"));
    expect(screen.getByRole("radio", { name: "All", checked: true })).toBeTruthy();
    expect(href(/Checkout flow/)).toBe("/pane/w1%3Ap1");
    expect(href(/Herdr app/)).toBe("/pane/t6?s=hc");
    expect(href(/Brief hats/)).toBe("/pane/rise-l%3At7?s=hc%40rise-l");
    expect(screen.getAllByText(/hats · rise-l/).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: /Session/ })).toBeNull();
  });

  it("picking a machine lists only its chats, kept on this device", async () => {
    localStorage.setItem("nenu:sidebar-view:v1", JSON.stringify({ view: "time" }));
    sidebar(data(JOINED));
    screen.getByRole("radio", { name: "rise-l" }).click();
    expect(await screen.findByRole("radio", { name: "rise-l", checked: true })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /Checkout flow/ })).toBeNull();
    expect(href(/Brief hats/)).toBe("/pane/rise-l%3At7?s=hc%40rise-l");
    expect(localStorage.getItem("nenu:machine:v1")).toBe(JSON.stringify("rise-l"));
  });

  it("the bar lists by spaces, folders, time or state, as this device picked", async () => {
    sidebar(data(JOINED));
    screen.getByRole("radio", { name: "Spaces" }).click();
    expect(await screen.findByRole("region", { name: "Workspaces" })).toBeTruthy();
    screen.getByRole("radio", { name: "State" }).click();
    expect(await screen.findByRole("region", { name: "By state" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Resting" })).toBeTruthy();
  });
});
