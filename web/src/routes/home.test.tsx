import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { HomeRoute } from "./home";
import { WorkbenchShell } from "@/components/workbench-shell";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";

vi.mock("@/components/update-banner", () => ({ UpdateBanner: () => null }));
const newSpace = vi.fn();
vi.mock("@/hooks/use-spaces", () => ({ useSpaceActions: () => ({ newSpace }) }));
const data: HomeData = {
  bridge: "connected", device: undefined, session: "work", sessions: [], error: false, authError: false,
  snoozedUntil: null, update: undefined, tabs: [], shellPanes: [],
  workspaces: [{ workspaceId: "w1", number: 1, label: "Nenu", focused: true, activeTabId: "t1", tabCount: 1, paneCount: 2 }],
  agents: [
    { paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "Nenu", workspaceNumber: 1, tabId: "t1", agent: "codex", status: "idle", cwd: "/dev/collie", focused: false, paneLabel: "Earlier thread" },
    { paneId: "w1:p2", workspaceId: "w1", workspaceLabel: "Nenu", workspaceNumber: 1, tabId: "t1", agent: "claude", status: "blocked", cwd: "/dev/collie", focused: true, paneLabel: "Review changes" },
  ],
};

async function setup(value = data) {
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, loader: () => value, element: <WorkbenchShell data={value}><Outlet /></WorkbenchShell>, children: [
    { path: "/", element: <HomeRoute /> },
    { path: "/space/:spaceId", element: <p>Project opened</p> },
    { path: "/pane/:paneId", element: <p>Pane opened</p> },
    { path: "/project/:projectSlug", element: <p>Project page</p> },
  ] }], { initialEntries: ["/?s=work"] });
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { name: "What should we work on?" });
  return { router, user: userEvent.setup(), main: within(document.querySelector("main")!) };
}

it("organizes work by project instead of duplicating a flat thread list", async () => {
  const { user, router } = await setup();
  expect(screen.queryByRole("region", { name: "Threads" })).not.toBeInTheDocument();
  expect(within(document.querySelector("header")!).getByText("Home")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Settings" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open workspace Nenu" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Collapse tab Other panes" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Open workspace Nenu" }));
  expect(router.state.location.pathname).toBe("/space/w1");
  expect(router.state.location.search).toBe("?s=work");
});

it("keeps workspace creation on its explicit existing shell flow", async () => {
  const { user, main } = await setup({ ...data, agents: [], workspaces: [] });
  expect(screen.getByText("Start a chat to launch your first agent.")).toBeInTheDocument();
  await user.click(main.getByRole("button", { name: "New chat" }));
  expect(screen.getByRole("dialog", { name: "New space" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Create space & open shell" })).toBeInTheDocument();
  expect(newSpace).not.toHaveBeenCalled();
});

it("does not claim an empty live herd or allow creation from stale disconnected data", async () => {
  const { main } = await setup({ ...data, error: true, agents: [], workspaces: [] });
  expect(screen.getByText(/Showing your last workspace snapshot/)).toBeInTheDocument();
  expect(main.getByRole("button", { name: "New chat" })).toBeDisabled();
  expect(screen.queryByText("Start a chat to launch your first agent.")).not.toBeInTheDocument();
});

it("keeps existing threads navigable while workspace creation is read-only", async () => {
  const { main } = await setup({ ...data, device: { enforced: true, device: "phone", authorized: false } });
  expect(main.getByRole("button", { name: "New chat" })).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("Read-only");
  expect(screen.getByRole("button", { name: "Open pane Earlier thread" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Open pane Review changes" })).toBeInTheDocument();
});

it("keeps every pane available inside its project tab", async () => {
  const agents = Array.from({ length: 11 }, (_, index) => ({ ...data.agents[0]!, paneId: `pane${index}`, paneLabel: `Thread ${index}` }));
  await setup({ ...data, agents });
  expect(screen.getAllByRole("button", { name: /^Open pane Thread / })).toHaveLength(11);
});

it("lists projects with a live summary and recent chats outside projects", async () => {
  const now = Date.now();
  const { user, router, main } = await setup({
    ...data,
    agents: [
      { ...data.agents[0]!, paneId: "c1", paneLabel: "Coordinator pane", status: "working", lastActiveAt: now },
      { ...data.agents[1]!, lastActiveAt: now - 2 * 86_400_000 },
    ],
    projects: [{
      slug: "hub", name: "Hub", status: "active",
      coordinator: { paneId: "c1", agent: "codex", liveStatus: "working" },
      threads: [{ id: "T1", title: "Stuck", parentId: "root", role: "worker", status: "open", paneId: "x", liveStatus: "blocked" }],
    }],
  });
  const project = main.getByRole("button", { name: /Hub/ });
  expect(project).toHaveTextContent("1 working · 1 blocked");
  const recent = within(main.getByRole("region", { name: "Recent chats" }));
  expect(recent.getByRole("link", { name: "Review changes, needs you" })).toBeInTheDocument();
  expect(recent.queryByRole("link", { name: /Coordinator pane/ })).not.toBeInTheDocument();
  await user.click(project);
  expect(router.state.location.pathname).toBe("/project/hub");
});
