import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, cleanup as cleanupRender, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { HomeData } from "@/lib/loaders";
import type { AgentView } from "@/lib/types";
import { declarations } from "@/test/css-rules";
import { WorkbenchSidebar, type SidebarRequest } from "./workbench-sidebar";

function pane(paneId: string, paneLabel: string, lastActiveAt = 0): AgentView {
  return { paneId, paneLabel, lastActiveAt, workspaceId: "w", workspaceLabel: "w", workspaceNumber: 1, tabId: "t", agent: "claude", status: "idle", cwd: "/", focused: false };
}

beforeEach(() => localStorage.clear());

describe("the sidebar's workspaces", () => {
  const herd = {
    agents: [
      { ...pane("d1", "", 50), paneLabel: undefined, workspaceId: "w2", workspaceLabel: "Design", tabId: "t-coord", terminalTitle: "Landing vs Max", status: "done" },
      { ...pane("d2", "", 40), paneLabel: undefined, workspaceId: "w2", workspaceLabel: "Design", tabId: "t-panels", tabLabel: "panels", terminalTitle: "Panel prod", status: "working" },
      { ...pane("d3", "", 30), paneLabel: undefined, workspaceId: "w2", workspaceLabel: "Design", tabId: "t-panels", tabLabel: "panels", terminalTitle: "Panel ventas", status: "blocked" },
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
    sessions: [], session: undefined,
  } as unknown as HomeData;

  let router: ReturnType<typeof createMemoryRouter>;
  function open(path: string) {
    router = createMemoryRouter([
      { path: "/", element: <WorkbenchSidebar data={herd} /> },
      { path: "/pane/:paneId", element: <WorkbenchSidebar data={herd} /> },
    ], { initialEntries: [path] });
    render(<RouterProvider router={router} />);
    return userEvent.setup();
  }
  const workspaces = () => within(screen.getByRole("region", { name: "Workspaces" }));
  // On a desk the tree is Search's: it shows under the box until something is typed.
  async function openTree(path: string) {
    const user = open(path);
    await user.click(screen.getByRole("button", { name: /^Search/ }));
    return user;
  }

  it("puts the workspace that moved last first, marks and opens the one on screen, and lists a split tab's panes with their state", async () => {
    await openTree("/pane/d1");
    expect(workspaces().getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["Nenu", "Design"]);

    const design = screen.getByRole("region", { name: "Design" });
    expect(within(design).getByRole("link", { name: /^Design/ })).toHaveAttribute("aria-current", "true");
    expect(within(screen.getByRole("region", { name: "Nenu" })).getByRole("link", { name: /^Nenu/ })).not.toHaveAttribute("aria-current");
    expect(within(design).getByRole("button", { name: "Design panes" })).toHaveAttribute("aria-expanded", "true");
    // The workspace opens on the agent asking for you.
    expect(within(design).getByRole("link", { name: /^Design/ })).toHaveAttribute("href", "/pane/d3");
    // A one-pane tab's row is named after its agent, as the chat it opens is.
    expect(within(design).getByRole("link", { name: /^Landing vs Max/ })).toHaveAttribute("aria-current", "page");
    expect(within(design).getByRole("link", { name: /^Landing vs Max/ })).toHaveTextContent("Landing vs Maxdone");
    const panels = within(design).getByRole("group", { name: "panels" });
    expect(within(panels).getAllByRole("link").map((link) => link.textContent)).toEqual(["Panel prodworking", "Panel ventasneeds you"]);

    // A workspace of one tab is that tab's row: nothing to unfold, the pane listed nowhere under it.
    const nenu = within(screen.getByRole("region", { name: "Nenu" }));
    expect(nenu.queryByRole("button")).toBeNull();
    expect(nenu.getByRole("link", { name: /^Nenu/ })).toHaveAttribute("href", "/pane/n1");
    expect(screen.queryByText("Workspaces brief")).not.toBeInTheDocument();
  });

  it("remembers a fold", async () => {
    const user = await openTree("/");
    // On Home nothing is on screen: the workspace holding a blocked agent opens.
    expect(screen.getByRole("button", { name: "Design panes" })).toHaveAttribute("aria-expanded", "true");
    await user.click(screen.getByRole("button", { name: "Design panes" }));
    expect(screen.queryByText("Panel prod")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("collie:sidebar:v1")!)).toEqual({ workspaces: { w2: false }, tabs: {} });
    // A tab's fold is remembered beside its workspace's.
    await user.click(screen.getByRole("button", { name: "Design panes" }));
    await user.click(screen.getByRole("button", { name: /^panels,/ }));
    expect(screen.queryByText("Panel prod")).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem("collie:sidebar:v1")!)).toEqual({ workspaces: { w2: true }, tabs: { "t-panels": false } });
  });

  it("opens a workspace of one tab from its row, split or not, with nothing to unfold, on a desk and a phone", async () => {
    const ops = [
      { ...pane("o1", "Deploy", 20), workspaceId: "w3", workspaceLabel: "Ops", tabId: "t-ops" },
      { ...pane("o2", "Rollback", 10), workspaceId: "w3", workspaceLabel: "Ops", tabId: "t-ops", status: "blocked" },
    ];
    const three = {
      ...herd,
      agents: [...herd.agents, ...ops],
      workspaces: [...herd.workspaces, { workspaceId: "w3", number: 3, label: "Ops", focused: false, activeTabId: "t-ops", tabCount: 1, paneCount: 2 }],
      tabs: [...herd.tabs, { tabId: "t-ops", workspaceId: "w3", number: 1, label: "deploys", focused: false, paneCount: 2 }],
    } as unknown as HomeData;
    for (const variant of ["sidebar", "drawer"] as const) {
      cleanupRender();
      router = createMemoryRouter([
        { path: "/", element: <WorkbenchSidebar data={three} variant={variant} /> },
        { path: "/pane/:paneId", element: <WorkbenchSidebar data={three} variant={variant} /> },
      ], { initialEntries: ["/"] });
      render(<RouterProvider router={router} />);
      const user = userEvent.setup();
      if (variant === "sidebar") await user.click(screen.getByRole("button", { name: /^Search/ }));
      // Its row opens the pane the workspace opens on everywhere: in a split tab, the agent asking for you.
      for (const [name, href] of [["Nenu", "/pane/n1"], ["Ops", "/pane/o2"]] as const) {
        const section = within(workspaces().getByRole("region", { name }));
        expect(section.queryByRole("button")).toBeNull();
        expect(section.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual([href]);
      }
      // Two tabs keep their fold.
      expect(workspaces().getByRole("button", { name: "Design panes" })).toHaveAttribute("aria-expanded", variant === "drawer" ? "false" : "true");
      await user.click(within(workspaces().getByRole("region", { name: "Ops" })).getByRole("link", { name: /^Ops/ }));
      expect(router.state.location.pathname).toBe("/pane/o2");
    }
  });

  it("opens a workspace of one session from its row though shells sit in other tabs, on a desk and a phone", async () => {
    const withShells = {
      ...herd,
      shellPanes: [
        { ...pane("s1", "vpn"), workspaceId: "w1", workspaceLabel: "Nenu", tabId: "t-vpn", agent: "shell", kind: "shell" },
        { ...pane("s2", "logs"), workspaceId: "w1", workspaceLabel: "Nenu", tabId: "t-logs", agent: "shell", kind: "shell" },
      ],
      workspaces: herd.workspaces.map((ws) => ws.workspaceId === "w1" ? { ...ws, tabCount: 3, paneCount: 3 } : ws),
      tabs: [...herd.tabs,
        { tabId: "t-vpn", workspaceId: "w1", number: 2, label: "vpn", focused: false, paneCount: 1 },
        { tabId: "t-logs", workspaceId: "w1", number: 3, label: "logs", focused: false, paneCount: 1 }],
    } as unknown as HomeData;
    for (const variant of ["sidebar", "drawer"] as const) {
      cleanupRender();
      router = createMemoryRouter([
        { path: "/", element: <WorkbenchSidebar data={withShells} variant={variant} /> },
        { path: "/pane/:paneId", element: <WorkbenchSidebar data={withShells} variant={variant} /> },
      ], { initialEntries: ["/"] });
      render(<RouterProvider router={router} />);
      const user = userEvent.setup();
      if (variant === "sidebar") await user.click(screen.getByRole("button", { name: /^Search/ }));
      const nenu = within(workspaces().getByRole("region", { name: "Nenu" }));
      expect(nenu.queryByRole("button")).toBeNull();
      expect(nenu.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/pane/n1"]);
      // Two sessions in two tabs keep their fold.
      expect(workspaces().getByRole("button", { name: "Design panes" })).toBeInTheDocument();
      await user.click(nenu.getByRole("link", { name: /^Nenu/ }));
      expect(router.state.location.pathname).toBe("/pane/n1");
    }
  });

  it("draws a tab of several panes as a row that folds them, its panes one level in, on a desk and a phone", async () => {
    const member = (paneId: string, tabId: string, title: string, status: AgentView["status"], kind?: "shell"): AgentView =>
      ({ ...pane(paneId, title, 5), workspaceId: "w4", workspaceLabel: "crew", tabId, status, ...(kind ? { agent: "shell", kind } : {}) });
    const crew = {
      ...herd,
      agents: [...herd.agents, member("c1", "t-lead", "Crew lead", "idle"),
        member("c2", "t-workers", "Checkout flow", "working"), member("c3", "t-workers", "Payment retries", "done"), member("c4", "t-workers", "Search index", "idle")],
      shellPanes: [member("c5", "t-server", "Dev server", "unknown", "shell")],
      workspaces: [...herd.workspaces, { workspaceId: "w4", number: 4, label: "crew", focused: false, activeTabId: "t-lead", tabCount: 3, paneCount: 5 }],
      tabs: [...herd.tabs,
        { tabId: "t-lead", workspaceId: "w4", number: 1, label: "lead", focused: false, paneCount: 1 },
        { tabId: "t-server", workspaceId: "w4", number: 2, label: "server", focused: false, paneCount: 1 },
        { tabId: "t-workers", workspaceId: "w4", number: 3, label: "workers", focused: false, paneCount: 3 }],
    } as unknown as HomeData;
    for (const variant of ["sidebar", "drawer"] as const) {
      cleanupRender();
      router = createMemoryRouter([
        { path: "/", element: <WorkbenchSidebar data={crew} variant={variant} /> },
        { path: "/pane/:paneId", element: <WorkbenchSidebar data={crew} variant={variant} /> },
      ], { initialEntries: ["/"] });
      render(<RouterProvider router={router} />);
      const user = userEvent.setup();
      if (variant === "sidebar") await user.click(screen.getByRole("button", { name: /^Search/ }));
      await user.click(workspaces().getByRole("button", { name: "crew panes" }));
      const section = within(workspaces().getByRole("region", { name: "crew" }));
      // One-pane tabs stay their pane's row; the split tab is one row, folded while nothing in it needs you.
      expect(section.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/pane/c1", "/pane/c1", "/pane/c5"]);
      const workers = section.getByRole("button", { name: /^workers,/ });
      expect(workers).toHaveAccessibleName("workers, working, 3 panes");
      expect(workers).toHaveAttribute("aria-expanded", "false");
      expect(workers).toHaveTextContent("3 panes");
      await user.click(workers);
      expect(workers).toHaveAttribute("aria-expanded", "true");
      const panes = within(section.getByRole("group", { name: "workers" }));
      expect(panes.getAllByRole("link").map((link) => link.textContent)).toEqual(["Checkout flowworking", "Payment retriesdone", "Search index, idle"]);
      expect(panes.getByRole("link", { name: /^Search index/ }).closest(".nav-pane")).toHaveClass("nav-pane-nested");
      // A split tab with an agent asking for you starts open.
      if (variant === "drawer") await user.click(workspaces().getByRole("button", { name: "Design panes" }));
      expect(workspaces().getByRole("button", { name: /^panels,/ })).toHaveAccessibleName("panels, needs you, 2 panes");
      expect(workspaces().getByRole("button", { name: /^panels,/ })).toHaveAttribute("aria-expanded", "true");
      await user.click(panes.getByRole("link", { name: /^Payment retries/ }));
      expect(router.state.location.pathname).toBe("/pane/c3");
    }
  });

  it("searches agents by name: the matches in a list, the first picked, arrows move the pick and Enter opens it", async () => {
    const user = open("/");
    await user.click(screen.getByRole("button", { name: /^Search/ }));
    const box = screen.getByRole("searchbox");
    await user.type(box, "panel");
    const results = screen.getByRole("listbox", { name: "Search results" });
    expect(within(results).queryByRole("region")).toBeNull();
    const options = () => within(results).getAllByRole("option");
    // Named as everywhere else, where it lives underneath, the newest to move first.
    expect(options().map((option) => option.textContent)).toEqual(["Panel prodDesign · panels, working", "Panel ventasDesign · panels, needs you"]);
    expect(options()[0]!.querySelector("mark")).toHaveTextContent("Panel");
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
    expect(box).toHaveAttribute("aria-activedescendant", options()[0]!.id);

    await user.keyboard("{ArrowDown}");
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    expect(options()[0]).toHaveAttribute("aria-selected", "false");
    await user.keyboard("{Enter}");
    expect(router.state.location.pathname).toBe("/pane/d3");
  });

  it("keeps the results in place and the pick on its row while polls move the agents", async () => {
    let poll!: (data: HomeData) => void;
    function Live() {
      const [data, setData] = useState(herd);
      poll = setData;
      return <WorkbenchSidebar data={data} />;
    }
    router = createMemoryRouter([{ path: "/", element: <Live /> }, { path: "/pane/:paneId", element: <Live /> }]);
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /^Search/ }));
    await user.type(screen.getByRole("searchbox"), "a");
    const titles = () => screen.getAllByRole("option").map((option) => option.querySelector(".nav-pane-title")?.textContent);
    const picked = () => screen.getAllByRole("option").find((option) => option.getAttribute("aria-selected") === "true")?.querySelector(".nav-pane-title")?.textContent;
    expect(titles()).toEqual(["Workspaces brief", "Landing vs Max", "Panel prod", "Panel ventas"]);
    await user.keyboard("{ArrowDown}{ArrowDown}");
    expect(picked()).toBe("Panel prod");

    // Panel ventas moves: the list does not reorder under the pick.
    act(() => poll({ ...herd, agents: herd.agents.map((agent) => agent.paneId === "d3" ? { ...agent, lastActiveAt: 100 } : agent) }));
    expect(titles()).toEqual(["Workspaces brief", "Landing vs Max", "Panel prod", "Panel ventas"]);
    expect(picked()).toBe("Panel prod");

    // A row above it closes: the pick stays on the row it was on.
    act(() => poll({ ...herd, agents: herd.agents.filter((agent) => agent.paneId !== "n1") }));
    expect(titles()).toEqual(["Landing vs Max", "Panel prod", "Panel ventas"]);
    expect(picked()).toBe("Panel prod");
    await user.keyboard("{Enter}");
    expect(router.state.location.pathname).toBe("/pane/d2");
  });

  it("keeps a search through a navigation it did not make, and ends it once its pick is on screen", async () => {
    const user = open("/pane/d1");
    await user.click(screen.getByRole("button", { name: /^Search/ }));
    await user.type(screen.getByRole("searchbox"), "panel");
    // The chat on screen closes and its page replaces itself: the half-typed search stays.
    await act(() => router.navigate("/pane/n1", { replace: true }));
    expect(screen.getByRole("searchbox")).toHaveValue("panel");

    await user.click(screen.getByRole("searchbox"));
    await user.keyboard("{Enter}");
    expect(router.state.location.pathname).toBe("/pane/d2");
    expect(screen.queryByRole("searchbox")).toBeNull();
  });

  it("says when nothing matches", async () => {
    const user = open("/");
    await user.click(screen.getByRole("button", { name: /^Search/ }));
    await user.type(screen.getByRole("searchbox"), "nothing like it");
    expect(screen.getByText("No matches for “nothing like it”")).toBeInTheDocument();
    expect(screen.queryByRole("option")).toBeNull();
  });
});

describe("the sidebar", () => {
  const at = (paneId: string, workspaceId: string, status: AgentView["status"] = "idle"): AgentView =>
    ({ ...pane(paneId, paneId), workspaceId, workspaceLabel: workspaceId, tabId: `${workspaceId}:t`, status });
  const herd = {
    agents: [at("c", "w1", "working"), at("lead", "w1"), at("depo", "w1", "blocked"), at("merca", "w1"), at("stray", "w1"), at("loose", "w2", "working")],
    shellPanes: [],
    workspaces: [
      { workspaceId: "w1", number: 1, label: "Acme ws", focused: true, activeTabId: "w1:t", tabCount: 1, paneCount: 5 },
      { workspaceId: "w2", number: 2, label: "globex", focused: false, activeTabId: "w2:t", tabCount: 1, paneCount: 1 },
    ],
    tabs: [
      { tabId: "w1:t", workspaceId: "w1", number: 1, label: "main", focused: true, paneCount: 5 },
      { tabId: "w2:t", workspaceId: "w2", number: 1, label: "main", focused: true, paneCount: 1 },
    ],
    sessions: [], session: undefined, bridge: "connected", error: false,
  } as unknown as HomeData;

  function open(path = "/", source: HomeData = herd) {
    const router = createMemoryRouter([
      { path: "/", element: <WorkbenchSidebar data={source} /> },
      { path: "/pane/:paneId", element: <WorkbenchSidebar data={source} /> },
    ], { initialEntries: [path] });
    render(<RouterProvider router={router} />);
    return userEvent.setup();
  }

  it("counts what needs you on Home, and keeps no Needs you list of its own", () => {
    open();
    expect(screen.getByRole("link", { name: "Home, 1 needs you" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Needs you/ })).not.toBeInTheDocument();
  });

  it("brings the tree back to where it was scrolled after a search", async () => {
    const user = open();
    const scroller = document.querySelector<HTMLElement>(".nav-scroll")!;
    const scrollTo = (top: number) => { scroller.scrollTop = top; fireEvent.scroll(scroller); };
    scrollTo(300);

    await user.click(screen.getByRole("button", { name: /^Search/ }));
    await user.type(screen.getByRole("searchbox"), "panel");
    scrollTo(40);
    await user.keyboard("{Escape}");
    expect(screen.getByRole("region", { name: "Chats" })).toBeInTheDocument();
    expect(scroller.scrollTop).toBe(300);
  });

  it("names a chat in the drawer's Recent as the chat names itself, with its workspace and tab under it", () => {
    const source = { ...herd, agents: herd.agents.map((agent) => agent.paneId === "c" ? { ...agent, tabLabel: "lead" } : agent) };
    const router = createMemoryRouter([{ path: "/pane/:paneId", element: <WorkbenchSidebar data={source} variant="drawer" /> }], { initialEntries: ["/pane/loose"] });
    render(<RouterProvider router={router} />);
    const recent = within(screen.getByRole("region", { name: "Recent" }));
    const chat = recent.getByRole("link", { name: /^cw1 · lead/ });
    expect(chat.querySelector(".nav-pane-detail")).toHaveTextContent("w1 · lead");
  });

  it("marks Home as the page on screen only on Home", () => {
    open("/");
    expect(screen.getByRole("link", { name: /^Home\b/ })).toHaveAttribute("aria-current", "page");
  });

  it("leaves Home unmarked in a chat", () => {
    open("/pane/depo");
    expect(screen.getByRole("link", { name: /^Home\b/ })).not.toHaveAttribute("aria-current");
  });

  describe("in the phone's sheets", () => {
    const sheet = (request?: SidebarRequest) => {
      const router = createMemoryRouter([{ path: "/", element: <WorkbenchSidebar data={herd} variant="sheet" request={request} /> }]);
      render(<RouterProvider router={router} />);
    };

    it("holds what Browse did under its box until you type, then only the results", async () => {
      sheet({ target: "search", seq: 1 });
      expect(screen.getByRole("searchbox")).toHaveFocus();
      expect(screen.getByRole("region", { name: "Workspaces" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
      await userEvent.setup().type(screen.getByRole("searchbox"), "panel");
      expect(screen.queryByRole("region", { name: "Workspaces" })).toBeNull();
      expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
    });
  });

  it("orients an empty herd: where agents come from, and on a phone a way to start one", async () => {
    const empty = { ...herd, agents: [], workspaces: [], tabs: [] } as unknown as HomeData;
    const onNewChat = vi.fn();
    const router = createMemoryRouter([{ path: "/", element: <WorkbenchSidebar data={empty} variant="sheet" onNewChat={onNewChat} /> }]);
    render(<RouterProvider router={router} />);
    expect(screen.getByText("No agents yet")).toBeInTheDocument();
    // The button below names the way to start; the words only add where else agents come from.
    expect(screen.getByText("Agents you start in Herdr show up here too.")).toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "New agent" }));
    expect(onNewChat).toHaveBeenCalledOnce();
  });

  it("keeps an empty desk sidebar to one quiet line, since Home beside it leads the start", () => {
    const empty = { ...herd, agents: [], workspaces: [], tabs: [] } as unknown as HomeData;
    const router = createMemoryRouter([{ path: "/", element: <WorkbenchSidebar data={empty} onNewChat={vi.fn()} /> }]);
    render(<RouterProvider router={router} />);
    expect(screen.getByText("No agents yet.")).toHaveClass("nav-empty");
    expect(screen.queryByRole("heading", { name: /No agents yet/ })).toBeNull();
    expect(screen.queryByText(/show up here/)).toBeNull();
  });

  it("names only the host in the desk's footer, beside Settings: no link dot while Herdr answers, no counts", () => {
    open();
    const footer = document.querySelector<HTMLElement>(".nav-host")!;
    expect(footer).toHaveTextContent(/^localhost$/);
    expect(footer.querySelector(".rounded-full")).toBeNull();
    expect(within(footer).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  });

  it("shows the desk footer's red dot only once Herdr is out of reach, and says so", () => {
    open("/", { ...herd, bridge: "disconnected" } as HomeData);
    const footer = document.querySelector<HTMLElement>(".nav-host")!;
    expect(footer.querySelector(".rounded-full")).toHaveClass("bg-status-blocked");
    expect(footer).toHaveTextContent("Not connected");
  });

  it("keeps a phone sheet's footer to the link dot and the host: what it holds is Home's to count", () => {
    const router = createMemoryRouter([{ path: "/", element: <WorkbenchSidebar data={herd} variant="sheet" request={{ target: "search", seq: 1 }} /> }]);
    render(<RouterProvider router={router} />);
    const footer = document.querySelector<HTMLElement>(".nav-host")!;
    expect(footer.querySelector(".rounded-full")).toHaveClass("bg-status-done");
    expect(footer).toHaveTextContent("herdr · localhost");
    expect(footer).not.toHaveTextContent(/workspaces|agents/);
  });

  it("keeps a row's shortcut out of sight until a pointer rests on the row or a key lands on it", () => {
    const nav = readFileSync(resolve(import.meta.dirname, "../styles/nav.css"), "utf8");
    const hover = ["@layer components", "@media (hover: hover)"];
    expect(declarations(nav, ".nav-kbd", hover).opacity).toBe("0");
    expect(declarations(nav, ".nav-row:is(:hover, :focus-visible) > .nav-kbd", hover).opacity).toBe("1");
    open("/", herd);
    expect(screen.getByRole("button", { name: /^Search/ })).toHaveAttribute("aria-keyshortcuts", "Meta+K");
  });
});

describe("the desk sidebar, drawn as Cursor's", () => {
  const now = new Date(2026, 9, 6, 12, 0, 0).getTime();
  const MIN = 60_000;
  const DAY = 24 * 60 * MIN;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
  });
  afterEach(() => vi.useRealTimers());

  const at = (paneId: string, workspaceId: string, extra: Partial<AgentView> = {}): AgentView =>
    ({ ...pane(paneId, paneId), workspaceId, workspaceLabel: workspaceId, tabId: `${workspaceId}:t`, ...extra });
  const herd = {
    agents: [
      at("flow", "w1", { paneLabel: "Checkout flow", status: "working", lastActiveAt: now - MIN }),
      at("hook", "w1", { paneLabel: "Payments webhook", status: "blocked", lastActiveAt: now - 4 * MIN }),
      at("badge", "w1", { paneLabel: "Cart badge", lastActiveAt: now - 3 * DAY }),
      at("Docs pass", "w2", { lastActiveAt: now - 12 * DAY }), at("Old spike", "w2", { lastActiveAt: now - 60 * DAY }),
    ],
    shellPanes: [at("zsh", "w2")],
    workspaces: [
      { workspaceId: "w1", number: 1, label: "Acme ws", focused: true, activeTabId: "w1:t", tabCount: 1, paneCount: 3 },
      { workspaceId: "w2", number: 2, label: "globex", focused: false, activeTabId: "w2:t", tabCount: 1, paneCount: 3 },
    ],
    tabs: [
      { tabId: "w1:t", workspaceId: "w1", number: 1, label: "main", focused: true, paneCount: 3 },
      { tabId: "w2:t", workspaceId: "w2", number: 1, label: "main", focused: true, paneCount: 3 },
    ],
    sessions: [], session: undefined, bridge: "connected", error: false,
  } as unknown as HomeData;

  function open(path = "/", source: HomeData = herd, onNewChat?: () => void) {
    const router = createMemoryRouter([
      { path: "/", element: <WorkbenchSidebar data={source} onNewChat={onNewChat} /> },
      { path: "/pane/:paneId", element: <WorkbenchSidebar data={source} onNewChat={onNewChat} /> },
    ], { initialEntries: [path] });
    render(<RouterProvider router={router} />);
    return userEvent.setup({ advanceTimers: () => undefined });
  }
  const section = (name: string) => within(screen.getByRole("region", { name }));
  const rowNames = (name: string) => section(name).queryAllByRole("link").map((link) => link.querySelector(".nav-row-text")?.textContent);

  it("leads with New chat, Search and Home", () => {
    open("/", herd, vi.fn());
    const top = [...document.querySelectorAll(".nav-top > .nav-row")].map((row) => row.querySelector(".nav-row-text")?.textContent);
    expect(top).toEqual(["New chat", "Search", "Home"]);
  });

  it("groups the chats by their last real activity, under periods named for what they hold", () => {
    open();
    const groups = screen.getByRole("region", { name: "Chats" });
    expect(within(groups).getAllByRole("heading").map((heading) => heading.textContent)).toEqual(["Today", "Previous 7 days", "Previous 30 days", "Older"]);
    expect(rowNames("Today")).toEqual(["Checkout flow", "Payments webhook"]);
    expect(rowNames("Previous 7 days")).toEqual(["Cart badge"]);
    expect(rowNames("Previous 30 days")).toEqual(["Docs pass"]);
    expect(rowNames("Older")).toEqual(["Old spike"]);
    // A bare shell is no chat.
    expect(within(groups).queryByText("zsh")).toBeNull();
  });

  it("marks the chat on screen and says its state", () => {
    open("/pane/hook");
    expect(section("Today").getByRole("link", { name: /^Payments webhook/ })).toHaveAttribute("aria-current", "page");
    expect(section("Today").getByRole("link", { name: /^Payments webhook/ })).toHaveAccessibleName("Payments webhook, needs you");
  });

  it("keeps the workspace tree out of the bar until Search opens, then browses it under the box", async () => {
    const user = open();
    expect(screen.queryByRole("region", { name: "Workspaces" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /^Search/ }));
    expect(screen.getByRole("searchbox")).toHaveFocus();
    // A fold in the tree keeps it up; Escape brings the bar back.
    await user.click(screen.getByRole("heading", { name: "Workspaces" }));
    expect(screen.getByRole("region", { name: "Workspaces" })).toBeInTheDocument();
    await user.click(screen.getByRole("searchbox"));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("region", { name: "Workspaces" })).toBeNull();
    expect(screen.getByRole("region", { name: "Chats" })).toBeInTheDocument();
  });

  it("says what needs you on Home as a quiet count beside a small dot, never a red pill", () => {
    open("/pane/flow");
    const home = screen.getByRole("link", { name: "Home, 1 needs you" });
    expect(home.querySelector(".nav-badge")).toBeNull();
    expect(home.querySelector(".nav-row-meta")).toHaveTextContent("1");
  });

  it("keeps each chat where it was while its agent works, puts a new one where it belongs, and reorders on a return", () => {
    let show: (data: HomeData) => void = () => undefined;
    function Live() {
      const [source, setSource] = useState(herd);
      show = setSource;
      return <WorkbenchSidebar data={source} />;
    }
    render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Live /> }])} />);
    expect(rowNames("Today")).toEqual(["Checkout flow", "Payments webhook"]);
    const moved = herd.agents.map((agent) => agent.paneId === "hook" ? { ...agent, lastActiveAt: now } : agent);
    act(() => show({ ...herd, agents: [...moved, at("fresh", "w2", { lastActiveAt: now - MIN / 2 })] }));
    expect(rowNames("Today")).toEqual(["fresh", "Checkout flow", "Payments webhook"]);
    expect(section("Today").getByRole("button", { name: "1 update" })).toBeInTheDocument();
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(rowNames("Today")).toEqual(["Payments webhook", "fresh", "Checkout flow"]);
    expect(section("Today").queryByRole("button", { name: /update/ })).toBeNull();
  });

  it("folds the chats past twelve, and a period with none on screen draws no heading until they open", async () => {
    const fleet = Array.from({ length: 12 }, (_, i) => at(`fleet${i}`, "w2", { lastActiveAt: now - (10 + i) * MIN }));
    const user = open("/", { ...herd, agents: [...herd.agents, ...fleet] });
    const headings = () => within(screen.getByRole("region", { name: "Chats" })).queryAllByRole("heading").map((heading) => heading.textContent);
    expect(headings()).toEqual(["Today"]);
    await user.click(screen.getByRole("button", { name: /^Show \d+ more$/ }));
    expect(headings()).toEqual(["Today", "Previous 7 days", "Previous 30 days", "Older"]);
    await user.click(screen.getByRole("button", { name: "Show less" }));
    expect(headings()).toEqual(["Today"]);
  });

  it("shows a chat that asks for you past More after the rows on screen, and moves none of them", () => {
    const fleet = Array.from({ length: 13 }, (_, i) => at(`fleet${i}`, "w2", { lastActiveAt: now - (10 + i) * MIN }));
    const crowd = { ...herd, agents: [...herd.agents, ...fleet] };
    let show: (data: HomeData) => void = () => undefined;
    function Live() {
      const [source, setSource] = useState(crowd);
      show = setSource;
      return <WorkbenchSidebar data={source} />;
    }
    render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Live /> }])} />);
    const before = rowNames("Today");
    expect(before).not.toContain("fleet12");
    act(() => show({ ...crowd, agents: crowd.agents.map((agent) => agent.paneId === "fleet12" ? { ...agent, status: "blocked" as const, lastActiveAt: now, lastSeenAt: now - DAY } : agent) }));
    expect(rowNames("Today")).toEqual([...before, "fleet12"]);
    expect(section("Today").getByRole("link", { name: /^fleet12/ }).querySelector("[data-unread]")).toHaveTextContent("+1");
  });

  it("marks a chat that finished or needs you since you last opened it with a quiet +1, and not the one on screen", () => {
    const finished = { ...herd, agents: herd.agents.map((agent) =>
      agent.paneId === "hook" || agent.paneId === "flow" ? { ...agent, status: agent.paneId === "flow" ? "done" as const : agent.status, lastActiveAt: now, lastSeenAt: now - MIN } : agent) };
    open("/pane/hook", finished);
    const flow = section("Today").getByRole("link", { name: /^Checkout flow/ });
    expect(flow.querySelector("[data-unread]")).toHaveTextContent("+1");
    expect(flow).toHaveAccessibleName(/, new$/);
    expect(section("Today").getByRole("link", { name: /^Payments webhook/ }).querySelector("[data-unread]")).toBeNull();
  });
});
