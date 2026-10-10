import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { vi } from "vitest";

import { server } from "@/test/setup";

import { ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import type { AgentView, ProjectView } from "@/lib/types";
import { DetailRoute } from "./detail";
import { ProjectRoute } from "./project";

// The chat itself is covered elsewhere; this stub shows what the project frame hands it.
interface StubProps { paneId: string; title?: string; headerAction?: ReactNode; overlay?: ReactNode; strip?: ReactNode; conversationFooter?: ReactNode; composerTop?: ReactNode; docked?: { header: (view: { terminal: boolean; canToggle: boolean; setTerminal: (t: boolean) => void; menu?: ReactNode }) => ReactNode } }
vi.mock("@/components/agent-chat", () => ({
  AgentChat: ({ paneId, title, headerAction, overlay, strip, conversationFooter, composerTop, docked }: StubProps) => (
    <div data-testid={docked ? "docked" : "chat"}>
      {docked ? docked.header({ terminal: false, canToggle: true, setTerminal: () => {}, menu: <button type="button">More actions</button> }) : <header><h1>{title ?? "untitled"}</h1>{headerAction}</header>}
      {strip === undefined ? <nav aria-label="Workspace tabs" /> : strip}
      {overlay ?? <div data-testid="conversation">{`conversation:${paneId}`}{conversationFooter}</div>}
      {composerTop}
    </div>
  ),
}));

let wide = false;
vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => wide }));
afterEach(() => { wide = false; });

function pane(paneId: string): AgentView {
  return { paneId, workspaceId: "w", workspaceLabel: "w", workspaceNumber: 1, tabId: "t", agent: "claude", status: "working", cwd: "/", focused: false };
}

const project: ProjectView = {
  slug: "hub", name: "Hub", goal: "Ship it", status: "active", prActions: true,
  coordinator: { paneId: "coord", agent: "claude", liveStatus: "working" },
  threads: [
    { id: "T1", title: "Build", parentId: "root", role: "worker", status: "open", paneId: "worker", liveStatus: "working",
      pr: { number: 12, state: "open", checks: { passed: 1, failed: 0, pending: 1 }, mergeBlocker: "checks pending" } },
    { id: "T2", title: "Docs", parentId: "root", role: "worker", status: "open", paneId: "docs", liveStatus: "idle", group: "ready-for-review",
      pr: { number: 9, state: "open", review: "approved", checks: { passed: 3, failed: 0, pending: 0 }, mergeBlocker: null } },
  ],
};

function home(agents: AgentView[], projects: ProjectView[] = [project]): HomeData {
  return { bridge: "connected", agents, shellPanes: [], workspaces: [], tabs: [], projects, device: undefined, sessions: [], session: undefined, snoozedUntil: null, update: undefined, error: false, authError: false };
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

it("opens a project on its coordinator's chat with thread cards, and switches Chat, Threads and PRs on a phone", async () => {
  const { router, user } = setup("/project/hub", home([pane("coord"), pane("worker"), pane("docs")]));
  expect(await screen.findByTestId("conversation")).toHaveTextContent("conversation:coord");
  expect(router.state.location.pathname).toBe("/pane/coord");
  expect(screen.getByRole("heading", { name: "Hub" })).toBeInTheDocument();

  // Cards under the conversation: Merge only where Organizations says nothing blocks it.
  const cards = within(screen.getByRole("region", { name: "Threads" }));
  expect(within(cards.getByRole("article", { name: "Docs" })).getByRole("button", { name: "Merge it" })).toBeInTheDocument();
  expect(within(cards.getByRole("article", { name: "Build" })).queryByRole("button", { name: "Merge it" })).not.toBeInTheDocument();

  const tabs = within(screen.getByRole("tablist", { name: "Project" }));
  await user.click(tabs.getByRole("tab", { name: /Threads/ }));
  expect(screen.queryByTestId("conversation")).not.toBeInTheDocument();
  expect(screen.getByText("Ready to review")).toBeInTheDocument();
  await user.click(tabs.getByRole("tab", { name: /PRs/ }));
  expect(screen.getByRole("button", { name: /^Docs/ })).toHaveTextContent("PR #9 · approved · checks passed");
  await user.click(tabs.getByRole("tab", { name: "Chat" }));
  expect(screen.getByTestId("conversation")).toBeInTheDocument();

  // A thread shows its siblings as chips and its PR above the composer.
  await user.click(within(screen.getByRole("article", { name: "Build" })).getByRole("button", { name: /Build/ }));
  expect(router.state.location.pathname).toBe("/pane/worker");
  expect(await screen.findByTestId("conversation")).toHaveTextContent("conversation:worker");
  expect(screen.getByRole("heading", { name: "Build" })).toBeInTheDocument();
  const chips = within(screen.getByRole("navigation", { name: "Threads" }));
  expect(chips.getByRole("button", { name: /Build/ })).toHaveAttribute("aria-current", "page");
  expect(chips.getByRole("button", { name: /coordinator/ })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "CI 1/2, checks" })).toBeInTheDocument();
});

it("merges a thread's PR from its card only after confirming", async () => {
  let posted: unknown;
  server.use(http.post("/api/org/thread/merge", async ({ request }) => { posted = await request.json(); return HttpResponse.json({ ok: true, merged: { id: "T2", pr: "9" } }); }));
  const { user } = setup("/pane/coord", home([pane("coord"), pane("worker"), pane("docs")]));
  await user.click(await screen.findByRole("button", { name: "Merge it" }));
  expect(posted).toBeUndefined();
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Merge" }));
  await waitFor(() => expect(posted).toEqual({ project: "hub", id: "T2" }));
});

it("docks a thread beside its coordinator on a wide screen and closes it again", async () => {
  wide = true;
  server.use(http.get("/api/pane/:id", () => HttpResponse.json({ paneId: "worker", text: "", truncated: false, revision: 1 })));
  const { router, user } = setup("/pane/coord", home([pane("coord"), pane("worker"), pane("docs")]));
  expect(await screen.findByRole("tablist", { name: "Project panel" })).toBeInTheDocument();
  expect(screen.queryByRole("tablist", { name: "Project" })).not.toBeInTheDocument();
  await user.click(within(screen.getByRole("article", { name: "Build" })).getByRole("button", { name: /Build/ }));
  expect(router.state.location.search).toBe("?thread=worker");
  const docked = within(await screen.findByTestId("docked"));
  expect(docked.getByText("conversation:worker")).toBeInTheDocument();
  expect(docked.getByRole("button", { name: "CI 1/2, checks" })).toBeInTheDocument();
  // The docked header keeps the chat's own menu (keys, find, files and the rest).
  expect(docked.getByRole("button", { name: "More actions" })).toBeInTheDocument();
  // The panel steps aside for the docked thread.
  expect(screen.queryByRole("tablist", { name: "Project panel" })).not.toBeInTheDocument();
  await user.click(docked.getByRole("button", { name: "Close thread" }));
  expect(router.state.location.search).toBe("");
  expect(await screen.findByRole("tablist", { name: "Project panel" })).toBeInTheDocument();
});

it("keeps a phone thread's way to the project's threads and coordinator when it has no chips", async () => {
  // Only this thread runs and the coordinator is gone: no chips, so the workspace strip stays.
  const docsStopped = { ...project, threads: project.threads.map((thread) => thread.id === "T2" ? { ...thread, paneId: undefined } : thread) };
  const { router, user } = setup("/pane/worker", home([pane("worker")], [docsStopped]));
  expect(await screen.findByTestId("conversation")).toHaveTextContent("conversation:worker");
  expect(screen.queryByRole("navigation", { name: "Threads" })).not.toBeInTheDocument();
  expect(screen.getByRole("navigation", { name: "Workspace tabs" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Threads, 2 open" }));
  expect(screen.queryByTestId("conversation")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Build/ }).closest("li")).toHaveAttribute("aria-current", "true");
  expect(screen.getByRole("button", { name: "Close Docs" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Coordinator/ })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back to chat" }));
  expect(screen.getByTestId("conversation")).toHaveTextContent("conversation:worker");
  expect(router.state.location.pathname).toBe("/pane/worker");
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
