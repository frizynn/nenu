import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider, useParams } from "react-router";
import { vi } from "vitest";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { useStatus } from "@/lib/status";
import type { AgentView, TabView, WorkspaceView } from "@/lib/types";
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
    bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], device: undefined, sessions: [],
    session: undefined, snoozedUntil: null, update: undefined, error: false, authError: false, ...over,
  };
}

function StatusProbe() {
  return <p data-testid="status">{useStatus()?.text ?? ""}</p>;
}

function PaneStub() {
  return <p>{`pane:${useParams().paneId}`}</p>;
}

/** `current` is what the root loader answers, so a test can change the snapshot under the page. */
function setup(path: string, initial: HomeData) {
  let current = initial;
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID, path: "/", loader: () => current, element: <><Outlet /><StatusProbe /></>,
    children: [
      { index: true, element: <p>HOME</p> },
      { path: "space/:spaceId", element: <SpaceRoute /> },
      { path: "pane/:paneId", element: <PaneStub /> },
    ],
  }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return { router, user: userEvent.setup(), setData: (next: HomeData) => { current = next; } };
}

// `nenu` holds three tabs (Herdr's active one is `review`), `api` one pane and `empty` none.
const herd = home({
  workspaces: [workspace("w1", "nenu", "w1:t2"), workspace("w2", "api", "w2:t1"), workspace("w3", "empty", "")],
  tabs: [tab("w1:t1", "redesign"), tab("w1:t2", "review"), tab("w1:t3", "3"), tab("w2:t1", "1")],
  agents: [
    pane("w1:a", "w1:t1", { status: "working" }),
    pane("w1:b", "w1:t2"),
    pane("w2:solo", "w2:t1"),
  ],
  shellPanes: [pane("w1:s", "w1:t3", { kind: "shell", agent: "shell" })],
});

it("opens the pane a workspace opens on everywhere, replacing the workspace link in history", async () => {
  const { router } = setup("/space/w1", herd);
  expect(await screen.findByText("pane:w1:b")).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/pane/w1%3Ab");
  expect(router.state.historyAction).toBe("REPLACE");
});

it("opens the agent asking for you, wherever it sits", async () => {
  const { router } = setup("/space/w1", { ...herd, agents: herd.agents.map((a) => a.paneId === "w1:a" ? { ...a, status: "blocked" as const } : a) });
  expect(await screen.findByText("pane:w1:a")).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/pane/w1%3Aa");
});

it("opens a workspace that holds a single pane straight onto it", async () => {
  const { router } = setup("/space/w2", herd);
  expect(await screen.findByText("pane:w2:solo")).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/pane/w2%3Asolo");
});

it("shows a workspace without a pane as an empty chat that starts one", async () => {
  const { user } = setup("/space/w3", herd);
  expect(await screen.findByRole("heading", { name: "Nothing runs in this workspace yet" })).toBeInTheDocument();
  expect(screen.getByText("empty")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Start an agent or a shell" }));
  expect(openNewAgent).toHaveBeenCalledWith({ kind: "tab", workspaceId: "w3" });
});

it("offers nothing to start on a read-only device", async () => {
  setup("/space/w3", { ...herd, device: { enforced: true, device: "spare-phone", authorized: false } });
  expect(await screen.findByRole("heading", { name: "Nothing runs in this workspace yet" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Start an agent or a shell" })).toBeNull();
});

it("goes Home from a workspace Herdr no longer has, and says so in the app's own word", async () => {
  setup("/space/w9", herd);
  expect(await screen.findByText("HOME")).toBeInTheDocument();
  expect(screen.getByTestId("status")).toHaveTextContent("Workspace not found");
});
