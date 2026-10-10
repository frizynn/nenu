import { useContext, useEffect, useState, type ReactNode } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { onTestFinished } from "vitest";
import { WorkbenchShell } from "./workbench-shell";
import { AppHeader } from "./app-header";
import { QuickJump } from "./home-panels";
import { setLocked } from "@/lib/idle";
import { openNewDialog, useNewDialogOpen } from "./new-agent-sheet";
import type { HomeData } from "@/lib/loaders";
import { WorkbenchNavigationContext } from "@/lib/workbench-navigation";

const data: HomeData = {
  bridge: "connected", device: undefined, session: "work", sessions: [],
  error: false, authError: false, snoozedUntil: null, update: undefined,
  tabs: [], shellPanes: [],
  workspaces: [{ workspaceId: "w:1", number: 1, label: "Nenu", focused: true, activeTabId: "t1", tabCount: 1, paneCount: 1 }],
  agents: [{ paneId: "w:1:p2", workspaceId: "w:1", workspaceLabel: "Nenu", workspaceNumber: 1, tabId: "t1", agent: "codex", status: "working", cwd: "/dev/collie", focused: true, paneLabel: "Improve interface" }],
};

beforeEach(() => localStorage.clear());

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

it("lists projects with their coordinator status, and the loose chat under Workspaces", () => {
  const { sidebar } = setup(projectData, "/pane/w%3A1%3Ap9?s=work");
  const link = sidebar.getByRole("link", { name: /^Nenu Project/ });
  expect(link).toHaveAttribute("href", "/project/nenu?s=work");
  expect(link).toHaveAccessibleName("Nenu Project, coordinator needs you, 1 open task");
  // The open pane is the project's coordinator, so its row inside the project is the current one.
  expect(sidebar.getByRole("link", { name: /^Coordinator/ })).toHaveAttribute("aria-current", "page");
  expect(within(sidebar.getByRole("region", { name: "Workspaces" })).getByRole("link", { name: /Improve interface/ })).toBeInTheDocument();
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

it("disables New on a read-only device, in the sidebar and the tab bar", () => {
  const { sidebar } = setup({ ...data, device: { enforced: true, device: "phone", authorized: false } });
  expect(sidebar.getByRole("button", { name: "New" })).toBeDisabled();
  expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "New" })).toBeDisabled();
});

it("shows the tab bar off a pane, and its tabs open the navigation in the matching mode", async () => {
  const { user } = setup({ ...data, agents: [{ ...data.agents[0]!, status: "blocked" }] });
  const bar = within(screen.getByRole("navigation", { name: "Primary" }));
  expect(bar.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  await user.click(bar.getByRole("button", { name: "Needs you, 1" }));
  const sheet = within(screen.getByRole("dialog", { name: "Needs you" }));
  // The tab bar already offers New, Search and Home, so the sheet starts at the list.
  expect(sheet.queryByRole("button", { name: "New" })).not.toBeInTheDocument();
  expect(sheet.getByRole("link", { name: /Improve interface/ })).toBeInTheDocument();
  await user.keyboard("{Escape}");
  await user.click(bar.getByRole("button", { name: "Search" }));
  expect(within(screen.getByRole("dialog", { name: "Search" })).getByRole("searchbox")).toHaveFocus();
});

it("hides the tab bar on a pane, where the composer owns the bottom edge", () => {
  setup(data, "/pane/w%3A1%3Ap2?s=work");
  expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
});

it("searches with Cmd+K and reaches every action from the collapsed rail", async () => {
  const matchMedia = window.matchMedia;
  window.matchMedia = (query) => ({ matches: query === "(min-width: 1024px)", media: query }) as MediaQueryList;
  onTestFinished(() => { window.matchMedia = matchMedia; });
  const { sidebar, user } = setup({ ...data, agents: [{ ...data.agents[0]!, status: "blocked" }] });
  await user.click(sidebar.getByRole("button", { name: "Collapse sidebar" }));
  const rail = within(screen.getByRole("navigation", { name: "Collapsed sidebar" }));
  expect(rail.getByRole("link", { name: "Nenu" })).toHaveAttribute("href", "/space/w%3A1?s=work");
  expect(rail.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings?s=work");
  await user.click(rail.getByRole("button", { name: "Needs you, 1" }));
  expect(sidebar.getByRole("button", { name: "Needs you, 1" })).toHaveAttribute("aria-pressed", "true");
  await user.keyboard("{Meta>}k{/Meta}");
  expect(sidebar.getByRole("searchbox")).toHaveFocus();
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

it("remembers a collapsed sidebar across a reload", async () => {
  const first = setup();
  await first.user.click(first.sidebar.getByRole("button", { name: "Collapse sidebar" }));
  first.router.dispose();
  document.body.innerHTML = "";
  setup();
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
});

/** Stands in for a project frame: a button docks or undocks a thread. */
function DockProbe() {
  const onDock = useContext(WorkbenchNavigationContext)?.onDock;
  const [docked, setDocked] = useState(false);
  useEffect(() => {
    if (!docked) return;
    onDock?.(true);
    return () => onDock?.(false);
  }, [docked, onDock]);
  return <button type="button" onClick={() => setDocked(!docked)}>{docked ? "Undock" : "Dock"}</button>;
}

it("folds to the rail while a thread is docked, unless expanded during that dock, without moving focus", async () => {
  const router = createMemoryRouter([{ path: "*", element: <WorkbenchShell data={data}><DockProbe /></WorkbenchShell> }]);
  render(<RouterProvider router={router} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Dock" }));
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Undock" })).toHaveFocus();

  await user.click(screen.getByRole("button", { name: "Expand sidebar" }));
  expect(screen.queryByRole("button", { name: "Expand sidebar" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Undock" }));
  expect(screen.queryByRole("button", { name: "Expand sidebar" })).not.toBeInTheDocument();

  // The next dock folds it again, and undocking brings back the operator's own choice.
  await user.click(screen.getByRole("button", { name: "Dock" }));
  expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Undock" }));
  expect(screen.queryByRole("button", { name: "Expand sidebar" })).not.toBeInTheDocument();
  expect(localStorage.getItem("nenu:sidebar-collapsed:v1")).toBe("0");
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

function desktop() {
  const matchMedia = window.matchMedia;
  window.matchMedia = (query) => ({ matches: query === "(min-width: 1024px)", media: query }) as MediaQueryList;
  onTestFinished(() => { window.matchMedia = matchMedia; });
}

it("gives Cmd+K to Home's jump box even when Home mounts after the shell", async () => {
  desktop();
  const shell = (page: ReactNode) => <WorkbenchShell data={data}>{page}</WorkbenchShell>;
  const router = createMemoryRouter([
    { path: "/pane/:paneId", element: shell(<p>Pane</p>) },
    { path: "/", element: shell(<QuickJump agents={data.agents} session="work" now={Date.now()} />) },
  ], { initialEntries: ["/pane/w%3A1%3Ap2?s=work"] });
  render(<RouterProvider router={router} />);
  await router.navigate("/?s=work");
  await userEvent.setup().keyboard("{Meta>}k{/Meta}");
  expect(await screen.findByRole("searchbox", { name: "Jump to a project or chat" })).toHaveFocus();
  expect(screen.queryByRole("searchbox", { name: "Search projects and chats" })).not.toBeInTheDocument();
});

function NewDialogProbe() {
  return useNewDialogOpen() ? <p>New dialog</p> : null;
}

it("ignores Cmd+K and Cmd+N behind the idle lock", async () => {
  desktop();
  onTestFinished(() => { setLocked(false); openNewDialog(false); });
  const element = <WorkbenchShell data={data}><NewDialogProbe /></WorkbenchShell>;
  render(<RouterProvider router={createMemoryRouter([{ path: "*", element }], { initialEntries: ["/?s=work"] })} />);
  const user = userEvent.setup();
  setLocked(true);
  await user.keyboard("{Meta>}k{/Meta}{Meta>}n{/Meta}");
  expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
  expect(screen.queryByText("New dialog")).not.toBeInTheDocument();
  setLocked(false);
  await user.keyboard("{Meta>}n{/Meta}");
  expect(screen.getByText("New dialog")).toBeInTheDocument();
});

it("leaves Ctrl+K to a text field off Apple platforms, and opens search from elsewhere", async () => {
  desktop();
  const { sidebar, user } = setup(data, "/pane/w%3A1%3Ap2?s=work");
  await user.click(screen.getByRole("textbox", { name: "Draft" }));
  await user.keyboard("{Control>}k{/Control}");
  expect(sidebar.queryByRole("searchbox")).not.toBeInTheDocument();
  (document.activeElement as HTMLElement).blur();
  await user.keyboard("{Control>}k{/Control}");
  expect(sidebar.getByRole("searchbox")).toHaveFocus();
});
