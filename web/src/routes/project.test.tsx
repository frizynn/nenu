import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { vi } from "vitest";

import { server } from "@/test/setup";

import { ROOT_ROUTE_ID, type HomeData, type PaneData } from "@/lib/loaders";
import { animateNavigations } from "@/lib/motion";
import type { AgentView, ProjectView } from "@/lib/types";
import { DetailRoute } from "./detail";
import { ProjectRoute } from "./project";

// The chat itself is covered elsewhere; this stub shows what the project frame hands it.
interface StubProps { paneId: string; project?: { role: string }; title?: string; headerAction?: ReactNode; headerTrail?: ReactNode; overlay?: ReactNode; strip?: ReactNode; conversationFooter?: ReactNode; projectChips?: { thread?: { title: string }; threads: unknown[] }; docked?: { header: (view: { terminal: boolean; canToggle: boolean; setTerminal: (t: boolean) => void; menu?: ReactNode }) => ReactNode } }
vi.mock("@/components/agent-chat", () => ({
  AgentChat: ({ paneId, project, title, headerAction, headerTrail, overlay, strip, conversationFooter, projectChips, docked }: StubProps) => (
    <div data-testid={docked ? "docked" : "chat"} data-role={project?.role}>
      {docked ? docked.header({ terminal: false, canToggle: true, setTerminal: () => {}, menu: <button type="button">More actions</button> }) : <header><h1>{title ?? "untitled"}</h1>{headerAction}{headerTrail}</header>}
      {strip === undefined ? <nav aria-label="Workspace tabs" /> : strip}
      {overlay ?? <div data-testid="conversation">{`conversation:${paneId}`}{conversationFooter}</div>}
      {projectChips && <p data-testid="chips">{`chips for ${projectChips.thread?.title ?? "the project"}`}</p>}
    </div>
  ),
}));

let wide = false;
// The width decides the frame; the pointer stays fine (a desk's hover actions) whatever the width.
vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: (query: string) => query.includes("min-width") && wide }));
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
  // As the app's router: every navigation it starts remembers the page it came from.
  animateNavigations(router);
  render(<RouterProvider router={router} />);
  return { router, user: userEvent.setup() };
}

/** The titles of a list's own items, not of the ones nested inside them. */
const titlesOf = (list: HTMLElement) => [...list.children].map((item) => item.querySelector(".task-main .font-medium")?.textContent);

it("opens a project on its coordinator's chat, and switches Chat, Threads and PRs on a phone", async () => {
  const { router, user } = setup("/project/hub", home([pane("coord"), pane("worker"), pane("docs")]));
  expect(await screen.findByTestId("conversation")).toHaveTextContent("conversation:coord");
  expect(router.state.location.pathname).toBe("/pane/coord");
  expect(screen.getByRole("heading", { name: "Hub" })).toBeInTheDocument();
  expect(screen.getByTestId("chat")).toHaveAttribute("data-role", "coordinator");
  // The tabs list the threads, so the conversation carries no cards of them as well.
  expect(screen.queryByRole("region", { name: "Threads" })).not.toBeInTheDocument();

  const tabs = within(screen.getByRole("tablist", { name: "Project" }));
  await user.click(tabs.getByRole("tab", { name: /Threads/ }));
  await waitFor(() => expect(screen.queryByTestId("conversation")).not.toBeInTheDocument());
  // The tab lives in the URL, in place: a reload or a way back lands on it, and it adds no history.
  expect(router.state.location.search).toBe("?view=threads");
  expect(router.state.historyAction).toBe("REPLACE");
  expect(titlesOf(screen.getByRole("list", { name: "Open threads" }))).toEqual(["Docs", "Build"]);
  // Merge only where Organizations says nothing blocks it.
  await user.click(tabs.getByRole("tab", { name: /PRs/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: /^Docs/ })).toHaveTextContent("PR #9 · Ready to merge"));
  expect(screen.getByRole("button", { name: /^Build/ })).toHaveTextContent("PR #12 · Checks running 1/2");
  expect(screen.getByRole("button", { name: "Merge Docs" })).toHaveTextContent(/^Merge$/);
  expect(screen.queryByRole("button", { name: "Merge Build" })).not.toBeInTheDocument();
  await user.click(tabs.getByRole("tab", { name: "Chat" }));
  expect(await screen.findByTestId("conversation")).toBeInTheDocument();
  expect(router.state.location.search).toBe("");
  expect(screen.queryByRole("region", { name: "Threads" })).not.toBeInTheDocument();

  // A thread opens from the Threads tab, one level down: a push, with no flash of the coordinator's Chat.
  await user.click(tabs.getByRole("tab", { name: /Threads/ }));
  await user.click(within(await screen.findByRole("list", { name: "Open threads" })).getByRole("button", { name: /^Build/ }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/pane/worker"));
  expect(router.state.historyAction).toBe("PUSH");
  // The coordinator's conversation is still mounted until the route re-renders; wait for the swap.
  await waitFor(() => expect(screen.getByTestId("conversation")).toHaveTextContent("conversation:worker"));
  expect(screen.getByRole("heading", { name: "Build" })).toBeInTheDocument();
  expect(screen.getByTestId("chat")).toHaveAttribute("data-role", "worker");
  // A thread shows what its coordinator shows, in the same place: Chat, Threads and PRs under the title.
  const own = within(screen.getByRole("tablist", { name: "Project" }));
  expect(own.getByRole("tab", { name: "Chat" })).toHaveAttribute("aria-selected", "true");
  expect(screen.queryByRole("navigation", { name: "Threads" })).not.toBeInTheDocument();
  // Its PR, siblings and background work ride in the row under the composer's box.
  expect(screen.getByTestId("chips")).toHaveTextContent("chips for Build");

  // A sibling from the thread's Threads tab takes the thread's place, so the history keeps one entry per level.
  await user.click(own.getByRole("tab", { name: /Threads/ }));
  await user.click(within(await screen.findByRole("list", { name: "Open threads" })).getByRole("button", { name: /^Docs/ }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/pane/docs"));
  expect(router.state.historyAction).toBe("REPLACE");
});

it("counts on a phone's PRs tab only the pull requests still open, never a resolved thread's", async () => {
  // A resolved thread's PR is no longer read by Organizations, so its "open" is as of when the thread closed.
  const stale: ProjectView = { ...project, threads: [...project.threads,
    { id: "T3", title: "Old", parentId: "root", role: "worker", status: "resolved", pr: { number: 1618, state: "open" } }] };
  setup("/pane/coord", home([pane("coord"), pane("worker"), pane("docs")], [stale]));
  expect(await screen.findByRole("tab", { name: /^PRs/ })).toHaveTextContent(/^PRs2$/);
});

it("merges a thread's PR from a phone's PRs tab only after confirming", async () => {
  let posted: unknown;
  server.use(http.post("/api/org/thread/merge", async ({ request }) => { posted = await request.json(); return HttpResponse.json({ ok: true, merged: { id: "T2", pr: "9" } }); }));
  const { user } = setup("/pane/coord", home([pane("coord"), pane("worker"), pane("docs")]));
  await user.click(await screen.findByRole("tab", { name: /^PRs/ }));
  await user.click(await screen.findByRole("button", { name: "Merge Docs" }));
  expect(posted).toBeUndefined();
  await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Merge" }));
  await waitFor(() => expect(posted).toEqual({ project: "hub", id: "T2" }));
});

/** The pane's Overview, the first tab of a desk's session panel. */
async function overviewPanel(user: ReturnType<typeof userEvent.setup>) {
  const panel = within(await screen.findByRole("complementary", { name: "Session panel" }));
  await user.click(panel.getByRole("tab", { name: "Overview" }));
  // The Overview is a lazy chunk: under load it lands a beat after the tab is picked.
  await panel.findByRole("region", { name: /^This (thread|coordinator)$/ });
  return panel;
}

it("docks a thread beside its coordinator on a wide screen and closes it again", async () => {
  wide = true;
  server.use(http.get("/api/pane/:id", () => HttpResponse.json({ paneId: "worker", text: "", truncated: false, revision: 1 })));
  const { router, user } = setup("/pane/coord", home([pane("coord"), pane("worker"), pane("docs")]));
  const panel = await overviewPanel(user);
  expect(screen.queryByRole("tablist", { name: "Project" })).not.toBeInTheDocument();
  await user.click(panel.getByRole("button", { name: /^Build/ }));
  expect(router.state.location.search).toBe("?thread=worker");
  expect(await screen.findByTestId("docked")).toHaveAttribute("data-role", "worker");
  const docked = within(screen.getByTestId("docked"));
  expect(docked.getByText("conversation:worker")).toBeInTheDocument();
  expect(docked.getByTestId("chips")).toHaveTextContent("chips for Build");
  // The docked header keeps the chat's own menu (keys, find, files and the rest).
  expect(docked.getByRole("button", { name: "More actions" })).toBeInTheDocument();
  // The panel steps aside for the docked thread.
  expect(screen.queryByRole("complementary", { name: "Session panel" })).not.toBeInTheDocument();
  await user.click(docked.getByRole("button", { name: "Close thread" }));
  expect(router.state.location.search).toBe("");
  expect(await screen.findByRole("region", { name: "This coordinator" })).toBeInTheDocument();
});

describe("a wide screen, the thread's overview as the session panel's first tab", () => {
  beforeEach(() => { wide = true; });

  it("lists the coordinator's threads only in its panel, never as cards under its chat", async () => {
    const { user } = setup("/pane/coord", home([pane("coord"), pane("worker"), pane("docs")]));
    const panel = await overviewPanel(user);
    expect(panel.getByRole("button", { name: /^Build/ })).toBeInTheDocument();
    expect(screen.getAllByRole("region", { name: "Threads" })).toHaveLength(1);
    await user.click(panel.getByRole("button", { name: "Hide session panel" }));
    expect(await screen.findByRole("button", { name: "Show session panel" })).toBeInTheDocument();
    expect(screen.getByTestId("conversation")).toHaveTextContent("conversation:coord");
    expect(screen.queryByRole("region", { name: "Threads" })).not.toBeInTheDocument();
    expect(screen.queryByRole("article")).not.toBeInTheDocument();
  });

  it("lists a thread's siblings once: the panel, not chips above the chat as well", async () => {
    const { user } = setup("/pane/worker", home([pane("coord"), pane("worker"), pane("docs")]));
    const panel = await overviewPanel(user);
    expect(panel.getByRole("button", { name: /^Docs/ })).toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Threads" })).not.toBeInTheDocument();
    await user.click(panel.getByRole("button", { name: "Hide session panel" }));
    expect(within(screen.getByRole("navigation", { name: "Threads" })).getByRole("button", { name: /Docs/ })).toBeInTheDocument();
  });

  it("names the thread's coordinator and its pull request, and goes up to that coordinator from its name", async () => {
    const { router, user } = setup("/pane/worker", home([pane("coord"), pane("worker"), pane("docs")]));
    const panel = await overviewPanel(user);
    const own = within(panel.getByRole("region", { name: "This thread" }));
    expect(own.getByText("#12")).toBeInTheDocument();
    expect(panel.queryByRole("tablist", { name: "Project sections" })).not.toBeInTheDocument();
    await user.click(own.getByRole("button", { name: /^Hub/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/coord"));
  });
});

it("keeps a phone thread's way to the project's threads and coordinator when its siblings are stopped", async () => {
  // Only this thread runs and the coordinator is gone.
  const docsStopped = { ...project, threads: project.threads.map((thread) => thread.id === "T2" ? { ...thread, paneId: undefined } : thread) };
  const { router, user } = setup("/pane/worker", home([pane("worker")], [docsStopped]));
  expect(await screen.findByTestId("conversation")).toHaveTextContent("conversation:worker");
  const tabs = within(screen.getByRole("tablist", { name: "Project" }));
  await user.click(tabs.getByRole("tab", { name: /^Threads2$/ }));
  await waitFor(() => expect(screen.queryByTestId("conversation")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: /^Build/ }).closest("li")).toHaveAttribute("aria-current", "true");
  expect(screen.getByRole("button", { name: "Close Docs" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /Coordinator/ })).toBeInTheDocument();
  await user.click(tabs.getByRole("tab", { name: "Chat" }));
  expect(await screen.findByTestId("conversation")).toHaveTextContent("conversation:worker");
  expect(router.state.location.pathname).toBe("/pane/worker");
});

it("opens a phone coordinator on the tab its URL names, as a reload or a way back does", async () => {
  setup("/pane/coord?view=prs", home([pane("coord"), pane("worker"), pane("docs")]));
  expect(await screen.findByRole("button", { name: "Merge Docs" })).toBeInTheDocument();
  expect(screen.queryByTestId("conversation")).not.toBeInTheDocument();
  expect(screen.getAllByRole("tab", { name: /^PRs/ })[0]).toHaveAttribute("aria-selected", "true");
});

describe("a coordinator under the project", () => {
  // Lead runs Build; the project's own coordinator is not running.
  const org: ProjectView = {
    slug: "hub", name: "Hub", goal: "Ship it", status: "active",
    threads: [
      { id: "L", title: "Lead", parentId: "root", role: "coordinator", status: "open", paneId: "lead", liveStatus: "idle", agent: "claude" },
      { id: "B", title: "Build", parentId: "L", role: "worker", status: "open", paneId: "worker", liveStatus: "working" },
    ],
  };

  it("lists its own row in its threads, never the project coordinator as not running", async () => {
    const { router, user } = setup("/pane/lead", home([pane("lead"), pane("worker")], [org]));
    await user.click(await screen.findByRole("tab", { name: /Threads/ }));
    const own = await screen.findByRole("button", { name: /^Coordinator/ });
    expect(screen.queryByRole("button", { name: "Start coordinator" })).not.toBeInTheDocument();
    expect(screen.queryByText("Not running")).not.toBeInTheDocument();
    expect(own).toHaveTextContent("You're here");
    expect(own.closest("li")).toHaveAttribute("aria-current", "true");

    // A thread it runs lists the same coordinator above its siblings, one tap from its chat.
    await user.click(screen.getByRole("button", { name: /^Build/ }));
    await screen.findByRole("heading", { name: "Build" });
    await user.click(screen.getByRole("tab", { name: /^Threads/ }));
    await waitFor(() => expect(router.state.location.search).toBe("?view=threads"));
    const lead = await screen.findByRole("button", { name: /^Coordinator/ });
    expect(lead).not.toHaveTextContent("You're here");
    // Up the tree: it entered from the coordinator's Threads, so this is a step back, not one more entry.
    await user.click(lead);
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/lead"));
    expect(router.state.historyAction).toBe("POP");
    expect(router.state.location.search).toBe("?view=threads");
  });

  it("names the project above it and its own threads in the panel beside it on a wide screen", async () => {
    wide = true;
    const { user } = setup("/pane/lead", home([pane("lead"), pane("worker")], [org]));
    const panel = await overviewPanel(user);
    expect(panel.queryByRole("button", { name: "Start coordinator" })).not.toBeInTheDocument();
    // It answers to the project, and lists the threads it runs as its own.
    expect(within(panel.getByRole("region", { name: "This coordinator" })).getByRole("button", { name: /^Hub/ })).toBeInTheDocument();
    expect(within(panel.getByRole("region", { name: "Threads" })).getByRole("button", { name: /^Build/ })).toBeInTheDocument();
  });
});

it("shows the organization with a way to start the coordinator when none is running", async () => {
  const { router } = setup("/project/hub", home([pane("worker")], [{ ...project, coordinator: undefined }]));
  expect(await screen.findByRole("button", { name: "Start coordinator" })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/project/hub");
  const main = within(screen.getByRole("main"));
  expect(main.getByRole("heading", { name: "Hub" })).toBeInTheDocument();
  expect(within(main.getByRole("list", { name: "Open threads" })).getByRole("button", { name: /^Build/ })).toBeInTheDocument();
});

it("opens the coordinator's chat once Start has brought it up", async () => {
  let running = false;
  server.use(http.post("/api/org/project/open", () => { running = true; return HttpResponse.json({ ok: true, message: "started codex as hp-hub" }); }));
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID, path: "/", element: <Outlet />,
    loader: () => running ? home([pane("coord"), pane("worker")]) : home([pane("worker")], [{ ...project, coordinator: undefined }]),
    children: [
      { path: "project/:projectSlug", element: <ProjectRoute /> },
      { path: "pane/:paneId", element: <p>PANE</p> },
    ],
  }], { initialEntries: ["/project/hub"] });
  render(<RouterProvider router={router} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole("button", { name: "Start coordinator" }));
  const window = within(await screen.findByRole("dialog", { name: "Start the coordinator" }));
  await window.findByRole("radio", { name: "Codex" });
  await user.click(window.getByRole("button", { name: "Start" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/pane/coord"));
});

it("leaves chats outside a project unframed", async () => {
  setup("/pane/solo", home([pane("solo")]));
  expect(await screen.findByTestId("conversation")).toHaveTextContent("conversation:solo");
  expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
});
