import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import type { HomeData } from "@/lib/loaders";
import type { AgentView, ProjectView } from "@/lib/types";
import { WorkbenchSidebar } from "./workbench-sidebar";

function pane(paneId: string, paneLabel: string, lastActiveAt = 0): AgentView {
  return { paneId, paneLabel, lastActiveAt, workspaceId: "w", workspaceLabel: "w", workspaceNumber: 1, tabId: "t", agent: "claude", status: "idle", cwd: "/", focused: false };
}

beforeEach(() => localStorage.clear());

describe("the sidebar's workspaces, with no projects", () => {
  const herd = {
    agents: [
      { ...pane("d1", "", 50), paneLabel: undefined, workspaceId: "w2", workspaceLabel: "Design", tabId: "t-coord", terminalTitle: "Landing vs Max", status: "done" },
      { ...pane("d2", "", 40), paneLabel: undefined, workspaceId: "w2", workspaceLabel: "Design", tabId: "t-panels", terminalTitle: "Panel prod", status: "working" },
      { ...pane("d3", "", 30), paneLabel: undefined, workspaceId: "w2", workspaceLabel: "Design", tabId: "t-panels", terminalTitle: "Panel ventas", status: "blocked" },
      { ...pane("n1", "", 90), paneLabel: undefined, workspaceId: "w1", workspaceLabel: "Nenu", tabId: "t-nenu", terminalTitle: "Workspaces brief", status: "working" },
    ],
    shellPanes: [],
    workspaces: [
      { workspaceId: "w1", number: 1, label: "Nenu", focused: false, activeTabId: "t-nenu", tabCount: 1, paneCount: 1 },
      { workspaceId: "w2", number: 2, label: "Design", focused: false, activeTabId: "t-coord", tabCount: 2, paneCount: 3 },
    ],
    tabs: [
      { tabId: "t-nenu", workspaceId: "w1", number: 1, label: "main", focused: true, paneCount: 1 },
      { tabId: "t-coord", workspaceId: "w2", number: 1, label: "coordinator", focused: false, paneCount: 1 },
      { tabId: "t-panels", workspaceId: "w2", number: 2, label: "panels", focused: false, paneCount: 2 },
    ],
    projects: [], sessions: [], session: undefined,
  } as unknown as HomeData;

  function open(path: string) {
    const router = createMemoryRouter([
      { path: "/", element: <WorkbenchSidebar data={herd} /> },
      { path: "/pane/:paneId", element: <WorkbenchSidebar data={herd} /> },
    ], { initialEntries: [path] });
    render(<RouterProvider router={router} />);
    return userEvent.setup();
  }
  const workspaces = () => within(screen.getByRole("region", { name: "Workspaces" }));

  it("leads with the workspace on screen, names each tab and lists a split tab's panes with their state", () => {
    open("/pane/d1");
    expect(workspaces().getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["Design", "Nenu"]);

    const design = screen.getByRole("region", { name: "Design" });
    expect(within(design).getByRole("button", { name: "Design panes" })).toHaveAttribute("aria-expanded", "true");
    expect(within(design).getByRole("link", { name: /^Design/ })).toHaveAttribute("href", "/space/w2");
    expect(within(design).getByRole("link", { name: /^coordinator/ })).toHaveAttribute("aria-current", "page");
    expect(within(design).getByRole("link", { name: /^coordinator/ })).toHaveTextContent("coordinatorLanding vs Maxdone");
    const panels = within(design).getByRole("group", { name: "panels" });
    expect(within(panels).getAllByRole("link").map((link) => link.textContent)).toEqual(["Panel prodclaudeworking", "Panel ventasclaudeneeds you"]);

    // Elsewhere, a workspace with nothing waiting on you starts folded.
    expect(screen.getByRole("button", { name: "Nenu panes" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Workspaces brief")).not.toBeInTheDocument();
  });

  it("remembers a fold, and search opens and narrows every workspace", async () => {
    const user = open("/");
    // On Home nothing is on screen: the workspace holding a blocked agent opens, the rest wait.
    expect(screen.getByRole("button", { name: "Design panes" })).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "Nenu panes" }));
    expect(screen.getByText("Workspaces brief")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("collie:sidebar:v1")!)).toEqual({ expanded: {}, workspaces: { w1: true } });

    await user.click(screen.getByRole("button", { name: /^Search/ }));
    await user.type(screen.getByRole("searchbox"), "ventas");
    expect(workspaces().getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["Design"]);
    // Narrowed to one pane, the split tab reads like any other: the tab, then the session.
    const design = within(screen.getByRole("region", { name: "Design" }));
    expect(design.getAllByRole("link", { name: /^(?!Design)/ }).map((link) => link.textContent)).toEqual(["panelsPanel ventasneeds you"]);
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "nothing like it");
    expect(screen.getByText("No matching projects or chats")).toBeInTheDocument();
  });
});

describe("the sidebar", () => {
  const thread = (id: string, title: string, parentId: string, extra: Partial<ProjectView["threads"][number]> = {}): ProjectView["threads"][number] =>
    ({ id, title, parentId, role: "worker", status: "open", ...extra });
  const awam: ProjectView = {
    slug: "awam", name: "AWAM", status: "active", workspaceIds: ["w1"],
    coordinator: { paneId: "c", agent: "codex", liveStatus: "working" },
    threads: [
      thread("t1", "rediseño mobile", "root", { role: "coordinator", paneId: "lead", liveStatus: "idle" }),
      thread("t2", "panel depo", "t1", { paneId: "depo", liveStatus: "blocked" }),
      thread("t3", "panel merca", "t1", { paneId: "merca", liveStatus: "idle", group: "ready-for-review" }),
      thread("t4", "landing", "root"),
      thread("t5", "old", "t1", { status: "resolved" }),
    ],
  };
  const at = (paneId: string, workspaceId: string, status: AgentView["status"] = "idle"): AgentView =>
    ({ ...pane(paneId, paneId), workspaceId, workspaceLabel: workspaceId, tabId: `${workspaceId}:t`, status });
  const herd = {
    agents: [at("c", "w1", "working"), at("lead", "w1"), at("depo", "w1", "blocked"), at("merca", "w1"), at("stray", "w1"), at("loose", "w2", "working")],
    shellPanes: [],
    workspaces: [
      { workspaceId: "w1", number: 1, label: "AWAM ws", focused: true, activeTabId: "w1:t", tabCount: 1, paneCount: 5 },
      { workspaceId: "w2", number: 2, label: "soflex", focused: false, activeTabId: "w2:t", tabCount: 1, paneCount: 1 },
    ],
    tabs: [
      { tabId: "w1:t", workspaceId: "w1", number: 1, label: "main", focused: true, paneCount: 5 },
      { tabId: "w2:t", workspaceId: "w2", number: 1, label: "main", focused: true, paneCount: 1 },
    ],
    projects: [awam], sessions: [], session: undefined, bridge: "connected", error: false,
  } as unknown as HomeData;

  function open(path = "/", source: HomeData = herd) {
    const router = createMemoryRouter([
      { path: "/", element: <WorkbenchSidebar data={source} /> },
      { path: "/pane/:paneId", element: <WorkbenchSidebar data={source} /> },
    ], { initialEntries: [path] });
    render(<RouterProvider router={router} />);
    return userEvent.setup();
  }

  it("nests threads under their coordinator and marks what needs you and what is ready for review", () => {
    open("/pane/depo");
    const project = screen.getByRole("region", { name: "AWAM" });
    const lead = within(project).getByRole("group", { name: "rediseño mobile" });
    expect(within(lead).getByRole("link", { name: /^rediseño mobile/ })).toHaveAttribute("href", "/pane/lead");
    expect(within(lead).getByRole("link", { name: /^panel depo/ })).toHaveAccessibleName("panel depo, needs you");
    expect(within(lead).getByRole("link", { name: /^panel depo/ })).toHaveAttribute("aria-current", "page");
    expect(within(lead).getByRole("link", { name: "panel merca, ready for review" })).toHaveTextContent("review");
    // A root worker sits beside the coordinator thread, and the resolved one folds into History.
    expect(within(project).getByRole("link", { name: /^landing/ }).closest("[role=group]")).toBeNull();
    expect(within(project).getByText("old").closest("details")).not.toHaveAttribute("open");
    // A pane in the project's workspace that runs no thread still has a row.
    expect(within(project).getByRole("link", { name: /^stray/ })).toHaveAttribute("href", "/pane/stray");
  });

  it("lists only the workspaces no project holds, and folds a coordinator's threads", async () => {
    const user = open();
    const workspaces = screen.getByRole("region", { name: "Workspaces" });
    expect(within(workspaces).getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["soflex"]);
    expect(within(workspaces).getByRole("link", { name: /^soflex/ })).toHaveAttribute("href", "/space/w2");
    await user.click(screen.getByRole("button", { name: "rediseño mobile threads" }));
    expect(screen.queryByText("panel depo")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("collie:sidebar:v1")!).expanded).toEqual({ "awam/t1": false });
  });

  it("finds a project pane that runs no thread, under its project", async () => {
    const user = open();
    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.keyboard("stray");
    const project = screen.getByRole("region", { name: "AWAM" });
    expect(within(project).getByRole("link", { name: /^stray/ })).toHaveAttribute("href", "/pane/stray");
    expect(within(project).queryByRole("link", { name: /^Coordinator/ })).not.toBeInTheDocument();
  });

  it("shows a coordinator thread's own state beside its threads' dots", () => {
    const blocked = { ...awam, threads: awam.threads.map((item) => item.id === "t1" ? { ...item, liveStatus: "blocked" as const } : item) };
    open("/", { ...herd, projects: [blocked] });
    const head = screen.getByRole("link", { name: /^rediseño mobile/ });
    expect(head).toHaveAccessibleName("rediseño mobile, needs you");
    expect(head.querySelector(".nav-row-word")).toHaveTextContent("needs you");
  });

  it("counts what needs you and narrows the list to it", async () => {
    const user = open();
    const needsYou = screen.getByRole("button", { name: "Needs you, 1" });
    await user.click(needsYou);
    expect(needsYou).toHaveAttribute("aria-pressed", "true");
    const list = screen.getByRole("region", { name: "Needs you" });
    expect(within(list).getAllByRole("link").map((link) => link.textContent)).toEqual(["panel depoAWAM, needs you"]);
    await user.click(needsYou);
    expect(screen.getByRole("region", { name: "Projects" })).toBeInTheDocument();
  });

  it("names the host and what it holds in the footer, beside Settings", () => {
    open();
    expect(screen.getByText("2 workspaces · 6 agents")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });
});
