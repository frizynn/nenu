import { useContext, useEffect, useState } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider, useMatch } from "react-router";
import { onTestFinished } from "vitest";
import { WorkbenchShell } from "./workbench-shell";
import { AppHeader } from "./app-header";
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

/** A chat's title as agent-chat draws it on a phone: the navigation opens from it, as it once did from the mark. */
function ChatTitle() {
  const navigation = useContext(WorkbenchNavigationContext);
  if (!useMatch("/pane/:paneId")) return <span>Screen</span>;
  return <button type="button" data-chat-title aria-haspopup="dialog" aria-expanded={navigation?.open} onClick={navigation?.onOpen}>Chat title</button>;
}

function setup(testData: HomeData = data, initialEntry = "/?s=work") {
  const element = <WorkbenchShell data={testData}><AppHeader bridge="connected" error={false}><ChatTitle /></AppHeader><textarea aria-label="Draft" defaultValue="Keep this draft" /></WorkbenchShell>;
  const routes = ["/pane/:paneId", "/pane/:paneId/history", "/project/:projectSlug", "/project/:projectSlug/node/:nodeId", "*"].map((path) => ({ path, element }));
  const router = createMemoryRouter(routes, { initialEntries: [initialEntry] });
  const { unmount } = render(<RouterProvider router={router} />);
  return { router, unmount, user: userEvent.setup(), sidebar: within(screen.getByRole("complementary", { name: "Workspace sidebar" })) };
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
  expect(sidebar.getByRole("option", { name: /^Project navigation/ })).toHaveAttribute("href", "/project/nenu/node/t-0007?s=work");
  expect(sidebar.queryByRole("option", { name: /Improve interface/ })).not.toBeInTheDocument();
  await user.clear(search);
  await user.type(search, "improve");
  expect(sidebar.queryByRole("option", { name: /Nenu Project/ })).not.toBeInTheDocument();
  expect(sidebar.getByRole("option", { name: /Improve interface/ })).toBeInTheDocument();
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
  expect(sidebar.getByText("No matches for “missing”")).toBeInTheDocument();
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

it("hides the tab bar on a pane and its History, where the composer owns the bottom edge", () => {
  for (const path of ["/pane/w%3A1%3Ap2?s=work", "/pane/w%3A1%3Ap2/history?s=work"]) {
    const { unmount } = setup(data, path);
    expect(screen.queryByRole("navigation", { name: "Primary" }), path).not.toBeInTheDocument();
    unmount();
  }
});

// The coordinator's pane w:1:p9 is not running, so the project page is its organization.
const restingProject: HomeData = { ...projectData, agents: data.agents };

it("keeps the tab bar on a project page and a node page, which draw no composer", () => {
  // A node page stays put even while its project's coordinator runs.
  for (const [home, path] of [[restingProject, "/project/nenu?s=work"], [projectData, "/project/nenu/node/t-0007?s=work"]] as const) {
    const { unmount } = setup(home, path);
    expect(screen.getByRole("navigation", { name: "Primary" }), path).toBeInTheDocument();
    unmount();
  }
});

it("draws no tab bar on a project whose live coordinator is opening its pane", () => {
  // The router stays on /project/:slug while the pane loads; a tab bar there would sit alone on an empty page.
  setup(projectData, "/project/nenu?s=work");
  expect(screen.queryByRole("navigation", { name: "Primary" })).not.toBeInTheDocument();
});

it("draws New as a tab with its own label, like its neighbours", () => {
  setup();
  const bar = within(screen.getByRole("navigation", { name: "Primary" }));
  for (const name of ["Home", "Browse", "Search", "New"]) expect(bar.getByRole(name === "Home" ? "link" : "button", { name })).toHaveTextContent(name);
});

it("searches with Cmd+K and reaches every action from the collapsed rail", async () => {
  const matchMedia = window.matchMedia;
  window.matchMedia = (query) => ({ matches: query === "(min-width: 1024px)", media: query }) as MediaQueryList;
  onTestFinished(() => { window.matchMedia = matchMedia; });
  const { sidebar, user } = setup({ ...data, agents: [{ ...data.agents[0]!, status: "blocked" }] });
  await user.click(sidebar.getByRole("button", { name: "Collapse sidebar" }));
  const rail = within(screen.getByRole("navigation", { name: "Collapsed sidebar" }));
  // A workspace of one pane opens that pane.
  expect(rail.getByRole("link", { name: /^Nenu\b/ })).toHaveAttribute("href", "/pane/w%3A1%3Ap2?s=work");
  expect(rail.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings?s=work");
  await user.click(rail.getByRole("button", { name: "Needs you, 1" }));
  expect(sidebar.getByRole("button", { name: "Needs you, 1" })).toHaveAttribute("aria-pressed", "true");
  await user.keyboard("{Meta>}k{/Meta}");
  expect(sidebar.getByRole("searchbox")).toHaveFocus();
});

// A workspace of two tabs: an agent in tab "1", a shell in "vpn" the operator had open last.
const ops: HomeData = {
  ...data,
  workspaces: [{ workspaceId: "w:2", number: 2, label: "ops", focused: false, activeTabId: "t-a", tabCount: 2, paneCount: 2 }],
  tabs: [
    { tabId: "t-a", workspaceId: "w:2", number: 1, label: "1", focused: false, paneCount: 1 },
    { tabId: "t-b", workspaceId: "w:2", number: 2, label: "vpn", focused: false, paneCount: 1 },
  ],
  agents: [{ paneId: "w:2:rag", workspaceId: "w:2", workspaceLabel: "ops", workspaceNumber: 2, tabId: "t-a", agent: "claude", status: "working", cwd: "/dev/ops", focused: false, paneLabel: "Search metrics" }],
  shellPanes: [{ paneId: "w:2:vpn", workspaceId: "w:2", workspaceLabel: "ops", workspaceNumber: 2, tabId: "t-b", agent: "shell", kind: "shell", status: "idle", cwd: "/dev/ops", focused: false, lastSeenAt: 5 }],
};
const opsPane = "/pane/w%3A2%3Avpn?s=work";

it("opens a workspace on the same pane from the sidebar, search and the collapsed rail", async () => {
  const matchMedia = window.matchMedia;
  window.matchMedia = (query) => ({ matches: query === "(min-width: 1024px)", media: query }) as MediaQueryList;
  onTestFinished(() => { window.matchMedia = matchMedia; });
  const { sidebar, user, router } = setup(ops);
  const workspaces = () => within(sidebar.getByRole("region", { name: "Workspaces" }));
  expect(workspaces().getByRole("link", { name: /^ops/ })).toHaveAttribute("href", opsPane);

  await user.keyboard("{Meta>}k{/Meta}");
  await user.type(sidebar.getByRole("searchbox"), "op");
  expect(sidebar.getByRole("option", { name: /^ops/ })).toHaveAttribute("href", opsPane);
  await user.click(sidebar.getByRole("option", { name: /^ops/ }));
  expect(router.state.location.pathname + router.state.location.search).toBe(opsPane);

  await user.click(sidebar.getByRole("button", { name: "Collapse sidebar" }));
  const rail = within(screen.getByRole("navigation", { name: "Collapsed sidebar" }));
  expect(rail.getByRole("link", { name: /^ops\b/ })).toHaveAttribute("href", opsPane);
});

it("opens a workspace on the same pane from the phone's Browse", async () => {
  const { user, router } = setup(ops);
  await user.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Browse" }));
  const sheet = within(screen.getByRole("dialog", { name: "Navigation" }));
  await user.click(sheet.getByRole("link", { name: /^ops/ }));
  expect(router.state.location.pathname + router.state.location.search).toBe(opsPane);
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

it("can reopen the mobile workspace drawer from the chat title after navigation and Escape", async () => {
  const { router, user } = setup(herd, "/pane/dev%3Amobile?s=work");
  const trigger = screen.getByRole("button", { name: "Chat title" });
  await user.click(trigger);
  await user.click(within(screen.getByRole("region", { name: "Recent" })).getByRole("link", { name: /Rediseño de Nenu/ }));
  expect(router.state.location.pathname).toBe("/pane/dev%3Adone");
  expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
  await user.click(trigger);
  expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  expect(screen.getByRole("dialog", { name: "Navigation" })).toBeInTheDocument();
});

it("keeps the Browse sheet on the tapped row, marked as opening, until its chat is on screen", async () => {
  let land!: () => void;
  const landed = new Promise<null>((resolve) => { land = () => resolve(null); });
  const element = <WorkbenchShell data={data}><span>Screen</span></WorkbenchShell>;
  const router = createMemoryRouter([{ path: "/pane/:paneId", element, loader: () => landed }, { path: "*", element }], { initialEntries: ["/?s=work"] });
  render(<RouterProvider router={router} />);
  const user = userEvent.setup();
  await user.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Browse" }));
  const row = within(screen.getByRole("dialog", { name: "Navigation" })).getByRole("link", { name: /^Nenu/ });
  await user.click(row);
  // A slow read leaves the sheet up, with the tapped row saying it is on its way.
  expect(await within(row).findByText("Opening")).toBeInTheDocument();
  expect(screen.getByRole("dialog", { name: "Navigation" })).toContainElement(row);
  land();
  await vi.waitFor(() => expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument());
  expect(router.state.location.pathname).toBe("/pane/w%3A1%3Ap2");
});

function desktop() {
  const matchMedia = window.matchMedia;
  window.matchMedia = (query) => ({ matches: query === "(min-width: 1024px)", media: query }) as MediaQueryList;
  onTestFinished(() => { window.matchMedia = matchMedia; });
}

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

// A herd like the operator's: a project, and loose workspaces whose chats moved at different times.
const herd: HomeData = {
  ...data,
  workspaces: [
    { workspaceId: "w:dev", number: 1, label: "Developer", focused: true, activeTabId: "t-dev", tabCount: 1, paneCount: 3 },
    { workspaceId: "w:awam", number: 2, label: "AWAM producto", focused: false, activeTabId: "t-awam", tabCount: 1, paneCount: 1 },
    { workspaceId: "w:psag", number: 3, label: "psag", focused: false, activeTabId: "t-psag", tabCount: 1, paneCount: 1 },
  ],
  tabs: [
    { tabId: "t-dev", workspaceId: "w:dev", number: 1, label: "1", focused: true, paneCount: 3 },
    { tabId: "t-awam", workspaceId: "w:awam", number: 1, label: "bench", focused: false, paneCount: 1 },
    { tabId: "t-psag", workspaceId: "w:psag", number: 1, label: "1", focused: false, paneCount: 1 },
  ],
  agents: [
    { paneId: "dev:mobile", workspaceId: "w:dev", workspaceLabel: "Developer", workspaceNumber: 1, tabId: "t-dev", agent: "claude", status: "working", cwd: "/", focused: true, paneLabel: "Brief de nenu-mobile", lastActiveAt: 40, lastSeenAt: 70 },
    { paneId: "dev:send", workspaceId: "w:dev", workspaceLabel: "Developer", workspaceNumber: 1, tabId: "t-dev", agent: "claude", status: "blocked", cwd: "/", focused: false, paneLabel: "Brief nenu-send", lastActiveAt: 60 },
    { paneId: "dev:done", workspaceId: "w:dev", workspaceLabel: "Developer", workspaceNumber: 1, tabId: "t-dev", agent: "claude", status: "done", cwd: "/", focused: false, paneLabel: "Rediseño de Nenu", lastActiveAt: 90 },
    { paneId: "awam:bench", workspaceId: "w:awam", workspaceLabel: "AWAM producto", workspaceNumber: 2, tabId: "t-awam", agent: "claude", status: "working", cwd: "/", focused: false, paneLabel: "Afirmaciones marcadas", lastActiveAt: 80 },
    { paneId: "psag:t76", workspaceId: "w:psag", workspaceLabel: "psag", workspaceNumber: 3, tabId: "t-psag", agent: "claude", status: "idle", cwd: "/", focused: false, paneLabel: "T-76 Mejoras", lastActiveAt: 5 },
  ],
  projects: [{
    slug: "awam", name: "AWAM Comercio SaaS", goal: "", status: "active",
    threads: [{ id: "t-0101", title: "Migración de stock", parentId: "root", role: "worker", status: "open" }],
  }],
};

it("opens the chat title's drawer from the top: what needs you, the chats that moved last, then folded projects and workspaces", async () => {
  const { user } = setup(herd, "/pane/dev%3Amobile?s=work");
  await user.click(screen.getByRole("button", { name: "Chat title" }));
  const drawer = screen.getByRole("dialog", { name: "Navigation" });
  // A drawer from the left edge, not the sheet that rises from the bottom.
  expect(drawer.querySelector(".side-sheet-panel")).not.toBeNull();
  const nav = within(drawer);
  expect(nav.getByRole("link", { name: "Nenu home" })).toHaveAttribute("href", "/?s=work");
  // 65 by 23 to the eye; the shared .hit-area gives a touch screen its 44 px reach (N1).
  expect(nav.getByRole("link", { name: "Nenu home" })).toHaveClass("hit-area");

  const sections = nav.getAllByRole("region").filter((region) => region.parentElement?.classList.contains("nav-scroll"));
  expect(sections.map((region) => region.getAttribute("aria-label"))).toEqual(["Needs you", "Recent", "Projects", "Workspaces"]);
  const needs = within(nav.getByRole("region", { name: "Needs you" })).getAllByRole("link");
  expect(needs.map((link) => [link.querySelector(".nav-pane-title")?.textContent, link.querySelector(".nav-pane-detail")?.textContent]))
    .toEqual([["Brief nenu-send", "Developer"]]);
  const recent = within(nav.getByRole("region", { name: "Recent" })).getAllByRole("link");
  expect(recent.map((link) => link.querySelector(".nav-pane-title")?.textContent))
    .toEqual(["Rediseño de Nenu", "Afirmaciones marcadas", "Brief de nenu-mobile", "T-76 Mejoras"]);
  expect(recent[2]).toHaveAttribute("aria-current", "page");

  expect(nav.getByRole("button", { name: "AWAM Comercio SaaS tasks" })).toHaveAttribute("aria-expanded", "false");
  const workspaces = within(nav.getByRole("region", { name: "Workspaces" }));
  expect(workspaces.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["Developer", "AWAM producto", "psag"]);
  for (const name of ["Developer", "AWAM producto", "psag"]) expect(workspaces.getByRole("button", { name: `${name} panes` })).toHaveAttribute("aria-expanded", "false");
  expect(workspaces.getByRole("link", { name: /^Developer/ })).toHaveAttribute("aria-current", "true");

  // Opening one lasts while the drawer is open; the next open is compact again.
  await user.click(workspaces.getByRole("button", { name: "Developer panes" }));
  expect(workspaces.getByRole("button", { name: "Developer panes" })).toHaveAttribute("aria-expanded", "true");
  await user.click(nav.getByRole("button", { name: "Close" }));
  await user.click(screen.getByRole("button", { name: "Chat title" }));
  expect(within(screen.getByRole("dialog", { name: "Navigation" })).getByRole("button", { name: "Developer panes" })).toHaveAttribute("aria-expanded", "false");
});

it("searches and starts something new from the drawer's header", async () => {
  const { user } = setup(herd, "/pane/dev%3Amobile?s=work");
  render(<NewDialogProbe />);
  await user.click(screen.getByRole("button", { name: "Chat title" }));
  const nav = within(screen.getByRole("dialog", { name: "Navigation" }));
  await user.click(nav.getByRole("button", { name: "Search" }));
  const search = nav.getByRole("searchbox", { name: "Search projects and chats" });
  expect(search).toHaveFocus();
  await user.type(search, "psag");
  expect(nav.queryByRole("region", { name: "Recent" })).not.toBeInTheDocument();
  expect(nav.getByRole("option", { name: /^psag/ })).toBeInTheDocument();
  expect(nav.queryByRole("option", { name: /^AWAM producto/ })).not.toBeInTheDocument();
  await user.click(nav.getByRole("button", { name: "New" }));
  expect(screen.queryByRole("dialog", { name: "Navigation" })).not.toBeInTheDocument();
  expect(screen.getByText("New dialog")).toBeInTheDocument();
});

it("leaves Needs you and Recent to Home in the tab bar's Browse, and folds every project and workspace there", async () => {
  const { user } = setup(herd, "/?s=work");
  await user.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "Browse" }));
  const sheet = within(screen.getByRole("dialog", { name: "Navigation" }));
  expect(sheet.queryByRole("region", { name: "Recent" })).not.toBeInTheDocument();
  expect(sheet.queryByRole("region", { name: "Needs you" })).not.toBeInTheDocument();
  expect(sheet.getByRole("button", { name: "AWAM Comercio SaaS tasks" })).toHaveAttribute("aria-expanded", "false");
  expect(sheet.getByRole("button", { name: "Developer panes" })).toHaveAttribute("aria-expanded", "false");
});

// The audit's folded rail: six client-*-portal workspaces read as six "C" tiles, api and acme as two "A".
const fleetNames = ["nenu", "api", "acme-enterprise-billing-platform-migration", "data-pipeline-backfill-2026-q4-customer-events", "personal-site",
  ...["alpha", "bravo", "charlie", "delta", "echo", "foxtrot"].map((word) => `client-${word}-portal`)];
const fleet: HomeData = {
  ...data,
  workspaces: fleetNames.map((label, i) => ({ workspaceId: `w:${i}`, number: i + 1, label, focused: false, activeTabId: `t${i}`, tabCount: 1, paneCount: 1 })),
  tabs: fleetNames.map((_, i) => ({ tabId: `t${i}`, workspaceId: `w:${i}`, number: 1, label: "1", focused: false, paneCount: 1 })),
  agents: fleetNames.map((label, i) => ({ paneId: `w:${i}:p`, workspaceId: `w:${i}`, workspaceLabel: label, workspaceNumber: i + 1, tabId: `t${i}`,
    agent: "claude", status: i === 2 ? "blocked" : "idle", cwd: "/", focused: false, paneLabel: `Task ${i}` })),
};

/** What a rail tile shows, without the words only a screen reader hears. */
function shownText(element: HTMLElement): string {
  const copy = element.cloneNode(true) as HTMLElement;
  copy.querySelectorAll(".sr-only").forEach((node) => node.remove());
  return copy.textContent!.trim();
}

it("folds every workspace to two letters no other tile shares, and names it on hover and focus", async () => {
  desktop();
  const { sidebar, user } = setup(fleet);
  await user.click(sidebar.getByRole("button", { name: "Collapse sidebar" }));
  const rail = within(screen.getByRole("navigation", { name: "Collapsed sidebar" }));
  const tiles = fleetNames.map((name) => rail.getByRole("link", { name: new RegExp(`^${name}\\b`) }));
  const shown = tiles.map(shownText);
  for (const monogram of shown) expect(monogram).toMatch(/^[A-Z0-9]{2}$/);
  expect(new Set(shown).size).toBe(fleetNames.length);
  // The dot on a tile is spoken with its name.
  expect(tiles[2]).toHaveAccessibleName("acme-enterprise-billing-platform-migration, needs you");

  await user.hover(tiles[5]!);
  expect(await screen.findByRole("tooltip", { hidden: true })).toHaveTextContent("client-alpha-portal");
  await user.unhover(tiles[5]!);
  await waitFor(() => expect(screen.queryByRole("tooltip", { hidden: true })).not.toBeInTheDocument());

  tiles[5]!.focus();
  await user.tab();
  expect(tiles[6]).toHaveFocus();
  expect(screen.getByRole("tooltip", { hidden: true })).toHaveTextContent("client-bravo-portal");
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("tooltip", { hidden: true })).not.toBeInTheDocument());
  expect(tiles[6]).toHaveFocus();
});

/** The fleet's folded rail with client-alpha-portal's name up; from there the test drives the clock. */
async function railNamed() {
  desktop();
  const { sidebar, user } = setup(fleet);
  await user.click(sidebar.getByRole("button", { name: "Collapse sidebar" }));
  const nav = screen.getByRole("navigation", { name: "Collapsed sidebar" });
  const tile = within(nav).getByRole("link", { name: /^client-alpha-portal\b/ });
  await user.hover(tile);
  expect(await screen.findByRole("tooltip", { hidden: true })).toHaveTextContent("client-alpha-portal");
  vi.useFakeTimers();
  onTestFinished(() => { vi.useRealTimers(); });
  return { nav, tile };
}
const railName = () => screen.queryByRole("tooltip", { hidden: true });

it("keeps a rail item's name up when the pointer slips into the gap and back", async () => {
  const { nav, tile } = await railNamed();
  // A browser moving within the rail sends only pointerover; user-event's pointerout would read as leaving it.
  fireEvent.pointerOver(nav);
  fireEvent.pointerOver(tile);
  act(() => vi.advanceTimersByTime(250));
  expect(railName()).toHaveTextContent("client-alpha-portal");
});

it("keeps a rail item's name up while the pointer rests on it, to read it", async () => {
  const { nav } = await railNamed();
  // Out of the tile, over the rail's edge and onto the name itself.
  fireEvent.pointerOver(nav);
  fireEvent.pointerOver(railName()!);
  act(() => vi.advanceTimersByTime(250));
  expect(railName()).toHaveTextContent("client-alpha-portal");
});

it("closes a rail item's name on Escape wherever focus is, fading it out before it goes", async () => {
  await railNamed();
  const draft = screen.getByRole("textbox", { name: "Draft" });
  draft.focus();
  fireEvent.keyDown(draft, { key: "Escape" });
  expect(railName()).toBeInTheDocument();
  act(() => vi.advanceTimersByTime(150));
  expect(railName()).not.toBeInTheDocument();
});
