import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { vi } from "vitest";

import { ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import type { AgentView, ProjectView } from "@/lib/types";
import { DetailRoute } from "./detail";
import { ProjectRoute } from "./project";

// The chat itself is covered elsewhere; this stub shows what the project frame hands it.
vi.mock("@/components/agent-chat", () => ({
  AgentChat: ({ paneId, title, subheader, overlay }: { paneId: string; title?: string; subheader?: ReactNode; overlay?: ReactNode }) => (
    <div>
      <h1>{title ?? "untitled"}</h1>
      {subheader}
      {overlay ?? <p data-testid="conversation">{`conversation:${paneId}`}</p>}
    </div>
  ),
}));

function pane(paneId: string): AgentView {
  return { paneId, workspaceId: "w", workspaceLabel: "w", workspaceNumber: 1, tabId: "t", agent: "claude", status: "working", cwd: "/", focused: false };
}

const project: ProjectView = {
  slug: "hub", name: "Hub", goal: "Ship it", status: "active",
  coordinator: { paneId: "coord", agent: "claude", liveStatus: "working" },
  threads: [{ id: "T1", title: "Build", parentId: "root", role: "worker", status: "open", paneId: "worker", liveStatus: "working" }],
};

function home(agents: AgentView[]): HomeData {
  return { bridge: "connected", agents, shellPanes: [], workspaces: [], tabs: [], projects: [project], device: undefined, sessions: [], session: undefined, snoozedUntil: null, update: undefined, error: false, authError: false };
}

function setup(path: string, data: HomeData) {
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID, path: "/", loader: () => data, element: <Outlet />,
    children: [
      { index: true, element: <p>HOME</p> },
      { path: "project/:projectSlug", element: <ProjectRoute /> },
      {
        path: "pane/:paneId", element: <DetailRoute />,
        loader: ({ params }): PaneData => ({ paneId: params.paneId ?? "", session: undefined, text: "", truncated: false, requestedLines: 600, revision: 0, error: false, authError: false }),
      },
    ],
  }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return { router, user: userEvent.setup() };
}

it("opens a project on its coordinator's chat, then switches between Chat and Tasks in place", async () => {
  const { router, user } = setup("/project/hub", home([pane("coord"), pane("worker")]));
  expect(await screen.findByTestId("conversation")).toHaveTextContent("conversation:coord");
  expect(router.state.location.pathname).toBe("/pane/coord");
  expect(screen.getByRole("heading", { name: "Hub" })).toBeInTheDocument();

  const tasks = screen.getByRole("tab", { name: /Tasks/ });
  expect(screen.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
  await user.click(tasks);
  expect(tasks).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByTestId("conversation")).not.toBeInTheDocument();

  // Opening a task shows that thread's chat, still framed by its project.
  await user.click(screen.getByRole("button", { name: /^Build/ }));
  expect(router.state.location.pathname).toBe("/pane/worker");
  expect(await screen.findByTestId("conversation")).toHaveTextContent("conversation:worker");
  expect(screen.getByRole("heading", { name: "Build" })).toBeInTheDocument();
  expect(screen.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
});

it("shows the task list as the project page when no coordinator is running", async () => {
  const { router } = setup("/project/hub", home([pane("worker")]));
  expect(await screen.findByText(/coordinator is not running/)).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/project/hub");
  const list = within(screen.getByRole("main"));
  expect(list.getByRole("heading", { name: "Hub" })).toBeInTheDocument();
  expect(list.getByRole("button", { name: /^Build/ })).toBeInTheDocument();
});

it("leaves chats outside a project unframed", async () => {
  setup("/pane/solo", home([pane("solo")]));
  expect(await screen.findByTestId("conversation")).toHaveTextContent("conversation:solo");
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
});
