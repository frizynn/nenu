import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { beforeEach, expect, it } from "vitest";

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

it("groups tasks under their project, folds resolved ones into History and leaves the rest as other chats", () => {
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
  const user = setup();
  await user.click(screen.getByRole("button", { name: "Site tasks" }));
  expect(screen.queryByText("Hero")).not.toBeInTheDocument();
  await user.click(screen.getByRole("radio", { name: "Recent" }));
  // Recent lists every pane by recency; project panes go by their task and name their project.
  expect(within(screen.getByRole("region", { name: "Older" })).getAllByRole("link").map((link) => link.textContent))
    .toEqual(["Loose chat, idle", "BuildHub, idle", "CoordinatorHub, idle"]);

  const stored = JSON.parse(localStorage.getItem("collie:sidebar:v1")!);
  expect(stored).toEqual({ view: "recent", expanded: { site: false } });
});

it("restores the stored view and survives unreadable storage", () => {
  localStorage.setItem("collie:sidebar:v1", JSON.stringify({ view: "recent", expanded: { hub: false } }));
  setup();
  expect(screen.getByRole("radio", { name: "Recent" })).toHaveAttribute("aria-checked", "true");
  localStorage.setItem("collie:sidebar:v1", "{not json");
  setup();
  expect(screen.getAllByRole("radio", { name: "Projects" }).at(-1)).toHaveAttribute("aria-checked", "true");
});

it("reveals the current project even when it was folded, and search opens every match", async () => {
  localStorage.setItem("collie:sidebar:v1", JSON.stringify({ view: "projects", expanded: { hub: false, site: false } }));
  const user = setup("/pane/a");
  expect(screen.getByRole("button", { name: "Hub tasks" })).toHaveAttribute("aria-expanded", "true");
  expect(screen.queryByText("Hero")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Search" }));
  await user.type(screen.getByRole("searchbox"), "audit");
  expect(screen.queryByRole("region", { name: "Site" })).not.toBeInTheDocument();
  expect(screen.getByText("Audit").closest("details")).toHaveAttribute("open");
});
