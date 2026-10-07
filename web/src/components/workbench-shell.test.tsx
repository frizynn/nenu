import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { WorkbenchShell } from "./workbench-shell";
import { AppHeader } from "./app-header";
import type { HomeData } from "@/lib/loaders";

const data: HomeData = {
  bridge: "connected", device: undefined, session: "work", sessions: [],
  error: false, authError: false, snoozedUntil: null, update: undefined,
  tabs: [], shellPanes: [],
  workspaces: [{ workspaceId: "w:1", number: 1, label: "Nenu", focused: true, activeTabId: "t1", tabCount: 1, paneCount: 1 }],
  agents: [{ paneId: "w:1:p2", workspaceId: "w:1", workspaceLabel: "Nenu", workspaceNumber: 1, tabId: "t1", agent: "codex", status: "working", cwd: "/dev/collie", focused: true, paneLabel: "Improve interface" }],
};

function setup(testData: HomeData = data, initialEntry = "/?s=work") {
  const element = <WorkbenchShell data={testData}><AppHeader bridge="connected" error={false}><span>Screen</span></AppHeader><textarea aria-label="Draft" defaultValue="Keep this draft" /></WorkbenchShell>;
  const router = createMemoryRouter([{ path: "/pane/:paneId", element }, { path: "*", element }], { initialEntries: [initialEntry] });
  render(<RouterProvider router={router} />);
  return { router, user: userEvent.setup(), sidebar: within(screen.getByRole("complementary", { name: "Workspace sidebar" })) };
}

it("uses one shared mobile header without the old brand or session row", () => {
  setup({ ...data, sessions: [{ name: "default", isPrimary: true, reachable: true, agents: 1, working: 1, blocked: 0 }, { name: "remote", isPrimary: false, reachable: true, agents: 0, working: 0, blocked: 0 }] });
  const main = document.querySelector(".workbench-main")!;
  expect(main.querySelectorAll(".workbench-app-header")).toHaveLength(1);
  expect(main.querySelector(".workbench-mobile-bar")).toBeNull();
  expect(within(main as HTMLElement).getByRole("button", { name: "Open navigation" })).toBeInTheDocument();
  expect(within(main as HTMLElement).queryByText("Nenu Code")).toBeNull();
  expect(within(main as HTMLElement).queryByRole("button", { name: /Session:/ })).toBeNull();
});

it("keeps project, chat and settings links scoped to the active session", () => {
  const { sidebar } = setup();
  expect(sidebar.getByRole("link", { name: /Improve interface/ })).toHaveAttribute("href", "/pane/w%3A1%3Ap2?s=work");
  expect(sidebar.getByRole("link", { name: "Home" })).toHaveAttribute("href", "/?s=work");
  expect(sidebar.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings?s=work");
});

const projectData: HomeData = {
  ...data,
  agents: [
    ...data.agents,
    { ...data.agents[0]!, paneId: "w:1:p9", paneLabel: "Coordinator pane", status: "blocked" },
  ],
  projects: [{
    slug: "nenu", name: "Nenu Project", goal: "A focused project hub", status: "active",
    coordinator: { paneId: "w:1:p9", agent: "claude", liveStatus: "blocked" },
    threads: [{ id: "t-0007", title: "Project navigation", parentId: "root", role: "worker", status: "open" }],
  }],
};

it("lists projects with their coordinator status and keeps project panes out of other chats", () => {
  const { sidebar } = setup(projectData, "/pane/w%3A1%3Ap9?s=work");
  const link = sidebar.getByRole("link", { name: /^Nenu Project/ });
  expect(link).toHaveAttribute("href", "/project/nenu?s=work");
  expect(link).toHaveAccessibleName("Nenu Project, coordinator needs you, 1 open task");
  // The open pane is the project's coordinator, so its row inside the project is the current one.
  expect(sidebar.getByRole("link", { name: /^Coordinator/ })).toHaveAttribute("aria-current", "page");
  expect(sidebar.queryByRole("link", { name: /Coordinator pane/ })).not.toBeInTheDocument();
  expect(within(sidebar.getByRole("region", { name: "Other chats" })).getByRole("link", { name: /Improve interface/ })).toBeInTheDocument();
});

it("groups chats by recency with a status for each", () => {
  const now = Date.now();
  const { sidebar } = setup({
    ...data,
    agents: [
      { ...data.agents[0]!, paneId: "a", paneLabel: "Fresh", lastActiveAt: now },
      { ...data.agents[0]!, paneId: "b", paneLabel: "Last week", status: "done", lastActiveAt: now - 3 * 86_400_000 },
      { ...data.agents[0]!, paneId: "c", paneLabel: "Ancient", status: "idle" },
    ],
  });
  expect(within(sidebar.getByRole("region", { name: "Today" })).getByRole("link")).toHaveAccessibleName("Fresh, working");
  expect(within(sidebar.getByRole("region", { name: "Last 7 days" })).getByRole("link")).toHaveAccessibleName("Last week, done");
  expect(within(sidebar.getByRole("region", { name: "Older" })).getByRole("link")).toHaveAccessibleName("Ancient, idle");
});

it("searches projects by thread metadata and chats by name, then closes on Escape", async () => {
  const { sidebar, user } = setup(projectData);
  await user.click(sidebar.getByRole("button", { name: "Search" }));
  const search = sidebar.getByRole("searchbox", { name: "Search projects and chats" });
  expect(search).toHaveFocus();
  await user.type(search, "t-0007");
  expect(sidebar.getByRole("link", { name: /Nenu Project/ })).toBeInTheDocument();
  expect(sidebar.queryByRole("link", { name: /Improve interface/ })).not.toBeInTheDocument();
  await user.clear(search);
  await user.type(search, "improve");
  expect(sidebar.queryByRole("link", { name: /Nenu Project/ })).not.toBeInTheDocument();
  expect(sidebar.getByRole("link", { name: /Improve interface/ })).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(sidebar.queryByRole("searchbox")).not.toBeInTheDocument();
  expect(sidebar.getByRole("link", { name: /Nenu Project/ })).toBeInTheDocument();
});

it("filters without disturbing a mounted composer draft", async () => {
  const { sidebar, user } = setup();
  const draft = screen.getByRole("textbox", { name: "Draft" });
  await user.type(draft, " plus edits");
  await user.click(sidebar.getByRole("button", { name: "Search" }));
  await user.type(sidebar.getByRole("searchbox"), "missing");
  expect(sidebar.getByText("No matching projects or chats")).toBeInTheDocument();
  await user.click(sidebar.getByRole("button", { name: "Collapse sidebar" }));
  expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
  expect(draft).toHaveValue("Keep this draft plus edits");
});

it("disables New chat on a read-only device", () => {
  const { sidebar } = setup({ ...data, device: { enforced: true, device: "phone", authorized: false } });
  expect(sidebar.getByRole("button", { name: "New chat" })).toBeDisabled();
});

it("keeps desktop reopening outside the composer region and preserves the mounted draft", async () => {
  const { sidebar, user } = setup();
  const draft = screen.getByRole("textbox", { name: "Draft" });
  const collapse = sidebar.getByRole("button", { name: "Collapse sidebar" });
  await user.click(collapse);
  const expand = screen.getByRole("button", { name: "Expand sidebar" });
  expect(expand.closest(".workbench-main")).toBeNull();
  expect(expand.closest(".workbench-sidebar-rail")).not.toBeNull();
  expect(expand).toHaveFocus();
  await user.keyboard("{Enter}");
  expect(screen.queryByRole("button", { name: "Expand sidebar" })).not.toBeInTheDocument();
  expect(collapse).toHaveFocus();
  expect(collapse).toHaveAttribute("aria-expanded", "true");
  expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
});

it("can reopen the mobile workspace drawer after navigation and Escape", async () => {
  const { user } = setup();
  const trigger = screen.getByRole("button", { name: "Open navigation" });
  await user.click(trigger);
  await user.click(within(screen.getByRole("dialog", { name: "Navigation" })).getByRole("link", { name: /Improve interface/ }));
  expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
  await user.click(trigger);
  expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();
});
