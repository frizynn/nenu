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

const hub: ProjectView = {
  slug: "hub", name: "Hub", status: "active",
  coordinator: { paneId: "c", agent: "claude", liveStatus: "working" },
  threads: [
    { id: "T1", title: "Build", parentId: "root", role: "worker", status: "open", paneId: "a", liveStatus: "blocked" },
    { id: "T0", title: "Audit", parentId: "root", role: "worker", status: "resolved" },
  ],
};
const site: ProjectView = { slug: "site", name: "Site", status: "active", threads: [{ id: "T1", title: "Hero", parentId: "root", role: "worker", status: "open" }] };

const data = {
  agents: [pane("c", "coord"), pane("a", "build pane", 5), pane("x", "Loose chat", 10)],
  workspaces: [{ workspaceId: "w", number: 1, label: "w", focused: true, activeTabId: "t", tabCount: 1, paneCount: 3 }], tabs: [],
  projects: [hub, site], sessions: [], session: undefined,
} as unknown as HomeData;

function setup(path = "/") {
  const router = createMemoryRouter([
    { path: "/", element: <WorkbenchSidebar data={data} /> },
    { path: "/pane/:paneId", element: <WorkbenchSidebar data={data} /> },
  ], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return userEvent.setup();
}

beforeEach(() => localStorage.clear());

const projectsView = () => localStorage.setItem("collie:sidebar:v1", JSON.stringify({ nav: "projects" }));

it("groups tasks under their project, folds resolved ones into History and leaves the rest as other chats", () => {
  projectsView();
  setup("/pane/a");
  expect(screen.getByRole("radio", { name: "Projects" })).toHaveAttribute("aria-checked", "true");
  const project = screen.getByRole("region", { name: "Hub" });
  expect(within(project).getByRole("link", { name: /^Hub/ })).toHaveAttribute("href", "/project/hub");
  expect(within(project).getByRole("link", { name: /^Build/ })).toHaveAttribute("aria-current", "page");
  expect(within(project).getByRole("link", { name: /^Coordinator/ })).toHaveAttribute("href", "/pane/c");
  expect(within(project).getByText("Audit").closest("details")).not.toHaveAttribute("open");
  expect(within(screen.getByRole("region", { name: "Other chats" })).getAllByRole("link").map((link) => link.textContent)).toEqual(["Loose chat, idle"]);
});

it("remembers the chosen view and each project's fold", async () => {
  projectsView();
  const user = setup();
  await user.click(screen.getByRole("button", { name: "Site tasks" }));
  expect(screen.queryByText("Hero")).not.toBeInTheDocument();
  await user.click(screen.getByRole("radio", { name: "Recent" }));
  // Recent lists every pane by recency; project panes go by their task and name their project.
  expect(within(screen.getByRole("region", { name: "Older" })).getAllByRole("link").map((link) => link.textContent))
    .toEqual(["Loose chat, idle", "BuildHub, idle", "CoordinatorHub, idle"]);

  const stored = JSON.parse(localStorage.getItem("collie:sidebar:v1")!);
  expect(stored).toEqual({ nav: "recent", expanded: { site: false }, workspaces: {} });
});

it("restores the stored view, and leads with Workspaces on unreadable storage or a choice from before it existed", () => {
  localStorage.setItem("collie:sidebar:v1", JSON.stringify({ nav: "recent", expanded: { hub: false } }));
  setup();
  expect(screen.getByRole("radio", { name: "Recent" })).toHaveAttribute("aria-checked", "true");
  localStorage.setItem("collie:sidebar:v1", "{not json");
  setup();
  expect(screen.getAllByRole("radio", { name: "Workspaces" }).at(-1)).toHaveAttribute("aria-checked", "true");
  localStorage.setItem("collie:sidebar:v1", JSON.stringify({ view: "projects" }));
  setup();
  expect(screen.getAllByRole("radio", { name: "Workspaces" }).at(-1)).toHaveAttribute("aria-checked", "true");
});

it("reveals the current project even when it was folded, and search opens every match", async () => {
  localStorage.setItem("collie:sidebar:v1", JSON.stringify({ nav: "projects", expanded: { hub: false, site: false } }));
  const user = setup("/pane/a");
  expect(screen.getByRole("button", { name: "Hub tasks" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByText("Hero")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Search" }));
  await user.type(screen.getByRole("searchbox"), "audit");
  expect(screen.queryByRole("region", { name: "Site" })).not.toBeInTheDocument();
  expect(screen.getByText("Audit").closest("details")).toHaveAttribute("open");
});

describe("Workspaces view", () => {
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
      { path: "/space/:spaceId", element: <p>Space</p> },
    ], { initialEntries: [path] });
    render(<RouterProvider router={router} />);
    return { router, user: userEvent.setup() };
  }

  it("leads with the workspace on screen, names each tab and lists a split tab's panes with their state", () => {
    open("/pane/d1");
    expect(screen.getByRole("radio", { name: "Workspaces" })).toHaveAttribute("aria-checked", "true");
    // No projects, so no Projects choice to make.
    expect(screen.queryByRole("radio", { name: "Projects" })).not.toBeInTheDocument();
    expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["Design", "Nenu"]);

    const design = screen.getByRole("region", { name: "Design" });
    expect(within(design).getByRole("button", { expanded: true })).toHaveTextContent("Design3 chats · 1 needs you · 1 working · 1 done");
    expect(within(design).getByRole("link", { name: /^coordinator/ })).toHaveAttribute("aria-current", "page");
    expect(within(design).getByRole("link", { name: /^coordinator/ })).toHaveTextContent("coordinatorLanding vs Maxdone");
    const panels = within(design).getByRole("group", { name: "panels" });
    expect(within(panels).getAllByRole("link").map((link) => link.textContent)).toEqual(["Panel prodclaudeworking", "Panel ventasclaudeneeds you"]);
    expect(within(design).getByRole("link", { name: "Open workspace Design" })).toHaveAttribute("href", "/space/w2");

    // Elsewhere, a workspace with nothing waiting on you starts folded.
    expect(within(screen.getByRole("region", { name: "Nenu" })).getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Workspaces brief")).not.toBeInTheDocument();
  });

  it("remembers a fold, and search opens and narrows every workspace", async () => {
    const { user } = open("/");
    // On Home nothing is on screen: the workspace holding a blocked agent opens, the rest wait.
    expect(within(screen.getByRole("region", { name: "Design" })).getByRole("button")).toHaveAttribute("aria-expanded", "true");
    await user.click(within(screen.getByRole("region", { name: "Nenu" })).getByRole("button"));
    expect(screen.getByText("Workspaces brief")).toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("collie:sidebar:v1")!).workspaces).toEqual({ w1: true });

    await user.click(screen.getByRole("button", { name: "Search" }));
    await user.type(screen.getByRole("searchbox"), "ventas");
    expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["Design"]);
    // Narrowed to one pane, the split tab reads like any other: the tab, then the session.
    const design = within(screen.getByRole("region", { name: "Design" }));
    expect(design.getAllByRole("link", { name: /^(?!Open workspace)/ }).map((link) => link.textContent)).toEqual(["panelsPanel ventasneeds you"]);
    await user.clear(screen.getByRole("searchbox"));
    await user.type(screen.getByRole("searchbox"), "nothing like it");
    expect(screen.getByText("No matching projects or chats")).toBeInTheDocument();
  });
});
