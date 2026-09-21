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
  const router = createMemoryRouter([{ path: "*", element: <WorkbenchShell data={testData}><AppHeader bridge="connected" error={false}><span>Screen</span></AppHeader><textarea aria-label="Draft" defaultValue="Keep this draft" /></WorkbenchShell> }], { initialEntries: [initialEntry] });
  render(<RouterProvider router={router} />);
  return { router, user: userEvent.setup(), sidebar: within(screen.getByRole("complementary", { name: "Workspace sidebar" })) };
}

it("uses one shared mobile header without the old brand or session row", () => {
  setup({ ...data, sessions: [{ name: "default", isPrimary: true, reachable: true, agents: 1, working: 1, blocked: 0 }, { name: "remote", isPrimary: false, reachable: true, agents: 0, working: 0, blocked: 0 }] });
  const main = document.querySelector(".workbench-main")!;
  expect(main.querySelectorAll(".workbench-app-header")).toHaveLength(1);
  expect(main.querySelector(".workbench-mobile-bar")).toBeNull();
  expect(within(main as HTMLElement).getByRole("button", { name: "Open workspaces" })).toBeInTheDocument();
  expect(within(main as HTMLElement).queryByText("Nenu Code")).toBeNull();
  expect(within(main as HTMLElement).queryByRole("button", { name: /Session:/ })).toBeNull();
});

it("keeps project, pane and settings links scoped to the active session", () => {
  const { sidebar } = setup();
  expect(sidebar.getByRole("link", { name: /Improve interface/ })).toHaveAttribute("href", "/pane/w%3A1%3Ap2?s=work");
  expect(sidebar.getByRole("link", { name: "Nenu" })).toHaveAttribute("href", "/space/w%3A1?s=work");
  expect(sidebar.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings?s=work");
});

it("lists registered projects, marks the current project and searches their thread metadata", async () => {
  const projectData: HomeData = {
    ...data,
    projects: [{
      slug: "nenu", name: "Nenu Project", goal: "A focused project hub", status: "active",
      threads: [{ id: "t-0007", title: "Project navigation", parentId: "root", role: "worker", status: "open" }],
    }],
  };
  const { sidebar, user } = setup(projectData, "/project/nenu?s=work");
  const link = sidebar.getByRole("link", { name: "Nenu Project" });
  expect(link).toHaveAttribute("href", "/project/nenu?s=work");
  expect(link).toHaveAttribute("aria-current", "page");

  const search = sidebar.getByRole("searchbox");
  await user.type(search, "t-0007");
  expect(sidebar.getByRole("link", { name: "Nenu Project" })).toBeInTheDocument();
  await user.clear(search);
  await user.type(search, "unrelated");
  expect(sidebar.queryByRole("link", { name: "Nenu Project" })).not.toBeInTheDocument();
});

it("renders a keyboard-accessible workspace, tab and pane tree", async () => {
  const { sidebar, user } = setup({
    ...data,
    tabs: [
      { tabId: "t1", workspaceId: "w:1", number: 1, label: "Main", focused: true, paneCount: 2 },
      { tabId: "t2", workspaceId: "w:1", number: 2, label: "Later", focused: false, paneCount: 0 },
    ],
    agents: [
      ...data.agents,
      { ...data.agents[0]!, paneId: "w:1:p3", paneLabel: "Test interface" },
    ],
  });
  const workspaceToggle = sidebar.getByRole("button", { name: "Collapse Nenu" });
  const tabToggle = sidebar.getByRole("button", { name: "Collapse tab Main" });
  const paneLink = sidebar.getByRole("link", { name: /Improve interface/ });

  expect(workspaceToggle).toHaveAttribute("aria-expanded", "true");
  expect(workspaceToggle).toHaveAttribute("aria-controls");
  expect(tabToggle).toHaveAttribute("aria-expanded", "true");
  expect(tabToggle).toHaveAttribute("aria-controls");
  expect(paneLink).toBeInTheDocument();

  tabToggle.focus();
  await user.keyboard("{Enter}");
  expect(tabToggle).toHaveAttribute("aria-expanded", "false");
  expect(sidebar.queryByRole("link", { name: /Improve interface/ })).not.toBeInTheDocument();

  await user.click(workspaceToggle);
  expect(sidebar.getByRole("button", { name: "Expand Nenu" })).toHaveAttribute("aria-expanded", "false");
  expect(sidebar.queryByRole("button", { name: "Collapse tab Main" })).not.toBeInTheDocument();
});

it("shares expanded state with the mobile workspace drawer", async () => {
  const { sidebar, user } = setup({
    ...data,
    tabs: [
      { tabId: "t1", workspaceId: "w:1", number: 1, label: "Main", focused: true, paneCount: 1 },
      { tabId: "t2", workspaceId: "w:1", number: 2, label: "Later", focused: false, paneCount: 0 },
    ],
  });
  await user.click(sidebar.getByRole("button", { name: "Collapse Nenu" }));

  const trigger = screen.getByRole("button", { name: "Open workspaces" });
  await user.click(trigger);
  const drawer = within(screen.getByRole("dialog", { name: "Workspaces" }));
  expect(drawer.getByRole("button", { name: "Expand Nenu" })).toHaveAttribute("aria-expanded", "false");

  await user.click(drawer.getByRole("button", { name: "Expand Nenu" }));
  expect(drawer.getByRole("button", { name: "Collapse Nenu" })).toHaveAttribute("aria-expanded", "true");
  expect(drawer.getByRole("link", { name: /Improve interface/ })).toBeInTheDocument();
});

it("filters projects without disturbing a mounted composer draft", async () => {
  const { sidebar, user } = setup();
  const draft = screen.getByRole("textbox", { name: "Draft" });
  await user.type(draft, " plus edits");
  await user.type(sidebar.getByRole("searchbox"), "missing");
  expect(sidebar.getByText("No matching projects or threads")).toBeInTheDocument();
  await user.click(sidebar.getByRole("button", { name: "Collapse sidebar" }));
  expect(screen.getByRole("textbox", { name: "Draft" })).toBe(draft);
  expect(draft).toHaveValue("Keep this draft plus edits");
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
  const trigger = screen.getByRole("button", { name: "Open workspaces" });
  await user.click(trigger);
  await user.click(within(screen.getByRole("dialog", { name: "Workspaces" })).getByRole("link", { name: /Improve interface/ }));
  expect(screen.queryByRole("dialog", { name: "Workspaces" })).not.toBeInTheDocument();
  await user.click(trigger);
  expect(screen.getByRole("dialog", { name: "Workspaces" })).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  expect(screen.getByRole("dialog", { name: "Workspaces" })).toBeInTheDocument();
});
