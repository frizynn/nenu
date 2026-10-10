import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { AgentView, ProjectThreadView, ProjectView } from "@/lib/types";
import { server } from "@/test/setup";
import { NodeRoute } from "./node";
import { ProjectRoute } from "./project";

const node = (id: string, title: string, parentId: string, extra: Partial<ProjectThreadView> = {}): ProjectThreadView =>
  ({ id, title, parentId, role: "worker", status: "open", ...extra });
const pane = (paneId: string): AgentView => ({ paneId, workspaceId: "w", workspaceLabel: "w", workspaceNumber: 1, tabId: "t", agent: "claude", status: "working", cwd: "/", focused: false });

const project: ProjectView = {
  slug: "hub", name: "Hub", status: "active", nodeActions: true,
  threads: [
    node("t-1", "Plan", "root", { role: "coordinator", status: "resolved", updated: "2026-10-01T00:00:00Z" }),
    node("t-2", "Step", "t-1", { status: "resolved", branch: "hp/step", pr: { url: "https://github.com/acme/hub/pull/4", number: 4, state: "merged" } }),
    node("t-3", "Lead", "root", { role: "coordinator", paneId: "lead", liveStatus: "idle" }),
    node("t-4", "Docs", "t-3", { group: "idle", note: "pane closed" }),
  ],
};

function setup(path: string) {
  const data: HomeData = { bridge: "connected", agents: [pane("lead")], shellPanes: [], workspaces: [], tabs: [], projects: [project], device: undefined,
    sessions: [], session: undefined, snoozedUntil: null, update: undefined, error: false, authError: false };
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID, path: "/", loader: () => data, element: <Outlet />,
    children: [
      { path: "project/:projectSlug", element: <ProjectRoute /> },
      { path: "project/:projectSlug/node/:nodeId", element: <NodeRoute /> },
      { path: "pane/:paneId", element: <p>PANE</p> },
    ],
  }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return { router, user: userEvent.setup() };
}

it("opens a resolved node's detail from History on the project page, and walks up to its coordinator", async () => {
  const { router, user } = setup("/project/hub");
  await user.click(await screen.findByRole("button", { name: /^History/ }));
  await user.click(screen.getByRole("button", { name: "Plan threads" }));
  await user.click(screen.getByRole("button", { name: /^Step/ }));
  expect(router.state.location.pathname).toBe("/project/hub/node/t-2");
  const main = within(screen.getByRole("main"));
  expect(main.getByRole("heading", { name: "Step" })).toBeInTheDocument();
  expect(main.getByRole("region", { name: "Node" })).toHaveTextContent("Resolved");
  expect(main.getByRole("region", { name: "Node" })).toHaveTextContent("PR #4 merged");
  expect(main.getByText("hp/step")).toBeInTheDocument();
  // Nothing to close or chat with once it is resolved.
  expect(main.queryByRole("button", { name: /^Close/ })).not.toBeInTheDocument();
  expect(main.queryByRole("button", { name: "Open chat" })).not.toBeInTheDocument();

  await user.click(main.getByRole("link", { name: "Plan" }));
  expect(router.state.location.pathname).toBe("/project/hub/node/t-1");
  // A coordinator's detail lists the work it ran, as every organization view does.
  await user.click(await screen.findByRole("button", { name: /^History · 1 thread/ }));
  expect(within(screen.getByRole("list", { name: "History" })).getByRole("button", { name: /^Step/ })).toBeInTheDocument();
});

it("offers a live node's chat without jumping to it, and closes an open one after confirming", async () => {
  let posted: unknown;
  server.use(http.post("/api/org/node/resolve", async ({ request }) => { posted = await request.json(); return HttpResponse.json({ ok: true }); }));
  const { router, user } = setup("/project/hub/node/t-3");
  const main = within(await screen.findByRole("main"));
  expect(router.state.location.pathname).toBe("/project/hub/node/t-3");
  expect(within(main.getByRole("list", { name: "Open threads" })).getByRole("button", { name: /^Docs/ })).toHaveTextContent("pane closed");
  // Lead still runs Docs, so Close explains instead of closing.
  await user.click(main.getByRole("button", { name: "Close coordinator" }));
  expect(screen.getByRole("dialog", { name: "Close its work first" })).toHaveTextContent("Lead still has 1 open under it.");
  await user.click(screen.getByRole("button", { name: "OK" }));
  await user.click(main.getByRole("button", { name: "Open chat" }));
  expect(router.state.location.pathname).toBe("/pane/lead");

  await router.navigate("/project/hub/node/t-4");
  // A node's own detail carries what Organizations noted about it.
  expect(await screen.findByRole("region", { name: "Node" })).toHaveTextContent("pane closed");
  await user.click(screen.getByRole("button", { name: "Close thread" }));
  await user.click(within(screen.getByRole("dialog", { name: "Close this thread?" })).getByRole("button", { name: "Close thread" }));
  await waitFor(() => expect(posted).toEqual({ project: "hub", id: "t-4" }));
});

it("says so when the node is not in the project", async () => {
  setup("/project/hub/node/t-9");
  expect(await screen.findByText("This node is not in the project any more.")).toBeInTheDocument();
});
