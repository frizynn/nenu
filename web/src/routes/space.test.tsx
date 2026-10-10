import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider, useParams } from "react-router";
import { http, HttpResponse } from "msw";
import { vi } from "vitest";

import { server } from "@/test/setup";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { AgentView, TabView, WorkspaceView } from "@/lib/types";
import { __resetShownTabs } from "@/components/space-view";
import { SpaceRoute } from "./space";

const openNewAgent = vi.fn();
vi.mock("@/lib/spawn", async (original) => ({ ...(await original<typeof import("@/lib/spawn")>()), openNewAgent: (target: unknown) => openNewAgent(target) }));

const workspace = (workspaceId: string, label: string, activeTabId: string): WorkspaceView =>
  ({ workspaceId, number: 1, label, focused: false, activeTabId, tabCount: 1, paneCount: 1 });
const tab = (tabId: string, label: string): TabView =>
  ({ tabId, workspaceId: tabId.split(":")[0]!, number: 1, label, focused: false, paneCount: 1 });
const pane = (paneId: string, tabId: string, extra: Partial<AgentView> = {}): AgentView => ({
  paneId, tabId, workspaceId: tabId.split(":")[0]!, workspaceLabel: "nenu", workspaceNumber: 1,
  agent: "claude", status: "idle", cwd: "/home/you/nenu", focused: false, ...extra,
});

function home(over: Partial<HomeData>): HomeData {
  return {
    bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], projects: [], device: undefined, sessions: [],
    session: undefined, snoozedUntil: null, update: undefined, error: false, authError: false, ...over,
  };
}

function PaneStub() {
  return <p>{`pane:${useParams().paneId}`}</p>;
}

/** `current` is what the root loader answers, so a test can change the snapshot under the page. */
function setup(path: string, initial: HomeData) {
  let current = initial;
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID, path: "/", loader: () => current, element: <Outlet />,
    children: [
      { index: true, element: <p>HOME</p> },
      { path: "space/:spaceId", element: <SpaceRoute /> },
      { path: "pane/:paneId", element: <PaneStub /> },
    ],
  }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return { router, user: userEvent.setup(), setData: (next: HomeData) => { current = next; } };
}

// Two workspaces: `nenu` with three tabs (Herdr's active one is `review`), and `api` holding one pane.
const herd = home({
  workspaces: [workspace("w1", "nenu", "w1:t2"), workspace("w2", "api", "w2:t1")],
  tabs: [tab("w1:t1", "redesign"), tab("w1:t2", "review"), tab("w1:t3", "3"), tab("w2:t1", "1")],
  agents: [
    pane("w1:a", "w1:t1", { paneLabel: "Landing", status: "working", terminalTitle: "Reviewing the diff", lastActiveAt: Date.now() - 3 * 60_000 }),
    pane("w1:b", "w1:t2", { paneLabel: "Review PR", cwd: "/home/you/nenu/worktrees/pr" }),
    pane("w2:solo", "w2:t1"),
  ],
  shellPanes: [pane("w1:s", "w1:t3", { kind: "shell", agent: "shell" })],
});

beforeEach(() => __resetShownTabs());

it("lists only this workspace's tabs, opens on Herdr's active one, and switches without an All filter", async () => {
  const { router, user } = setup("/space/w1", herd);
  expect(await screen.findByRole("heading", { name: "nenu" })).toBeInTheDocument();
  expect(screen.getByText("~/nenu")).toBeInTheDocument();

  const tabs = within(screen.getByRole("group", { name: "Tabs" }));
  expect(tabs.getAllByRole("button").map((b) => b.lastChild?.textContent)).toEqual(["redesign", "review", "Tab 3"]);
  expect(screen.queryByRole("button", { name: "All" })).toBeNull();
  // The other workspace is the sidebar's to list, not this page's.
  expect(screen.queryByText("api", { selector: "main *" })).toBeNull();

  // Herdr's active tab is on screen, and a pane outside the workspace folder says where it sits.
  const review = within(screen.getByRole("list", { name: "review panes" }));
  expect(review.getByRole("link", { name: /Review PR/ })).toHaveAttribute("href", "/pane/w1%3Ab");
  expect(review.getByText("claude · idle · ~/nenu/worktrees/pr")).toBeInTheDocument();

  await user.click(tabs.getByRole("button", { name: /redesign/ }));
  const redesign = within(screen.getByRole("list", { name: "redesign panes" }));
  expect(redesign.getByText("claude · working · Reviewing the diff")).toBeInTheDocument();
  expect(redesign.getByText("3m")).toBeInTheDocument();
  // A tab switch is not a navigation: it shows at once, with no snapshot read in between.
  expect(router.state.location.search).toBe("");
});

it("opens a pane's chat from its row, and Back returns to the tab it was in", async () => {
  const { router, user } = setup("/space/w1", herd);
  await user.click(await screen.findByRole("button", { name: /Tab 3/ }));
  await user.click(screen.getByRole("link", { name: /shell/ }));
  expect(await screen.findByText("pane:w1:s")).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/pane/w1%3As");

  await router.navigate(-1);
  expect(await screen.findByRole("list", { name: "Tab 3 panes" })).toBeInTheDocument();
});

it("opens a workspace that holds a single pane straight onto it", async () => {
  const { router } = setup("/space/w2", herd);
  expect(await screen.findByText("pane:w2:solo")).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/pane/w2%3Asolo");
});

it("starts a new tab in this workspace", async () => {
  const { user } = setup("/space/w1", herd);
  await user.click(await screen.findByRole("button", { name: "New tab" }));
  expect(openNewAgent).toHaveBeenCalledWith({ kind: "tab", workspaceId: "w1" });
});

it("moves to the tab beside the one it closes", async () => {
  let closed = "";
  server.use(http.post(/\/api\/tab\/[^/]+\/close$/, ({ request }) => {
    closed = decodeURIComponent(new URL(request.url).pathname.split("/")[3]!);
    return HttpResponse.json({ ok: true });
  }));
  const { user, setData } = setup("/space/w1", herd);
  await user.click(within(await screen.findByRole("group", { name: "Tabs" })).getByRole("button", { name: /review/ }));
  await user.click(screen.getByRole("button", { name: "review actions" }));
  await user.click(screen.getByRole("button", { name: "Close tab" }));
  setData({ ...herd, tabs: herd.tabs.filter((t) => t.tabId !== "w1:t2"), agents: herd.agents.filter((a) => a.tabId !== "w1:t2") });
  await user.click(screen.getByRole("button", { name: /^Tap again to close/ }));

  expect(await screen.findByRole("list", { name: "redesign panes" })).toBeInTheDocument();
  expect(closed).toBe("w1:t2");
  expect(within(screen.getByRole("group", { name: "Tabs" })).queryByRole("button", { name: /review/ })).toBeNull();
});
