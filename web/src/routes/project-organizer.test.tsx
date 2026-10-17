import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { AgentView, ProjectThreadView, ProjectView } from "@/lib/types";
import { server } from "@/test/setup";
import { ProjectRoute } from "./project";

// A project that organizes coordinators (ADR 0092): each folds over its card and work, the project's
// own first while it runs, the threads at the top level apart, and a node can move under another.

// A desk: row actions show as words, not behind a ⋯.
vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => false }));

const node = (id: string, title: string, parentId: string, extra: Partial<ProjectThreadView> = {}): ProjectThreadView =>
  ({ id, title, parentId, role: "worker", status: "open", ...extra });
const pane = (paneId: string): AgentView => ({ paneId, workspaceId: "w", workspaceLabel: "w", workspaceNumber: 1, tabId: "t", agent: "claude", status: "idle", cwd: "/", focused: false });

/** Lead runs Docs (waiting on you) and Checkout, which runs Pay; Hotfix sits at the top level; Plan is History. */
const threads: ProjectThreadView[] = [
  node("t-1", "Plan", "root", { role: "coordinator", status: "resolved" }),
  node("t-3", "Lead", "root", { role: "coordinator", paneId: "lead", liveStatus: "idle", agent: "claude" }),
  node("t-4", "Docs", "t-3", { group: "waiting-on-you" }),
  node("t-5", "Checkout", "t-3", { role: "coordinator", group: "working" }),
  node("t-6", "Pay", "t-5", { group: "idle" }),
  node("t-7", "Hotfix", "root", { group: "idle" }),
];
const project: ProjectView = { slug: "hub", name: "Hub", goal: "Ship it", status: "active", source: "json", nodeActions: true, waitingAsks: 0, threads };

function home(projects: ProjectView[], agents: AgentView[] = [pane("lead")]): HomeData {
  return { bridge: "connected", agents, shellPanes: [], workspaces: [], tabs: [], projects, device: undefined, sessions: [], session: undefined, snoozedUntil: null, update: undefined, error: false, authError: false };
}

const ROOT_STATUS = { text: "# Status\nObjective: (none)\n\n## Asked\n\n## Decisions\n", updated: "2026-10-17T10:00:00Z" };

beforeEach(() => {
  sessionStorage.clear();
  server.use(
    http.get("/api/org/summary", () => HttpResponse.json({
      ok: true, coordinator: null, usage: null,
      // The project coordinator's STATUS.md is the empty template; Lead's has an objective.
      status: ROOT_STATUS,
      threads: [{ id: "t-3", captures: [], deliverables: [], status: { text: "# Status\nObjective: Launch wholesale", updated: "2026-10-17T10:00:00Z", objective: "Launch wholesale" } }],
    })),
    http.get("/api/org/asks", () => HttpResponse.json({ ok: true, asks: [], decisions: [] })),
  );
});

function setup(data: HomeData, path = "/project/hub") {
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID, path: "/", loader: () => data, element: <Outlet />,
    children: [
      { path: "project/:projectSlug", element: <ProjectRoute /> },
      { path: "project/:projectSlug/node/:nodeId", element: <p>NODE</p> },
      { path: "pane/:paneId", element: <p>PANE</p> },
    ],
  }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return { router, user: userEvent.setup() };
}

/** The titles of a list's own rows, not of the ones nested inside them. */
const titlesOf = (list: HTMLElement) => [...list.children].map((item) => item.querySelector(".task-main .font-medium")?.textContent);

describe("a project that organizes coordinators", () => {
  it("lists its coordinators, folded, and the threads at its top level apart, with no project coordinator as a header", async () => {
    setup(home([project]));
    const coordinators = await screen.findByRole("list", { name: "Coordinators" });
    expect(titlesOf(coordinators)).toEqual(["Lead"]);
    // Folded, the row says what it holds.
    expect(within(coordinators).getByRole("button", { name: /^Lead ?Idle/ })).toHaveTextContent("Idle · 3 open · 1 needs you");
    expect(titlesOf(screen.getByRole("list", { name: "Open threads" }))).toEqual(["Hotfix"]);
    // No project coordinator to start as if it were missing, and not its empty STATUS.md on top.
    expect(screen.queryByText("Not running")).not.toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Project coordinator" })).not.toBeInTheDocument();
    expect(screen.queryByText("Objective: (none)")).not.toBeInTheDocument();
    // Starting it is one small action beside New.
    expect(screen.getByRole("button", { name: "Start project coordinator" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New coordinator" })).toBeInTheDocument();
  });

  it("opens a coordinator's row on its card, its work, and New under it", async () => {
    const { user, router } = setup(home([project]));
    await user.click(await screen.findByRole("button", { name: "Lead threads" }));
    const inside = within(screen.getByRole("group", { name: "Inside Lead" }));
    expect(await inside.findByRole("region", { name: "Coordinator card" })).toHaveTextContent("Launch wholesale");
    // The tree beside the card lists its agents, so the card does not.
    expect(inside.queryByRole("heading", { name: /^Agents/ })).not.toBeInTheDocument();
    expect(titlesOf(inside.getByRole("list", { name: "Lead threads" }))).toEqual(["Checkout", "Docs"]);
    // A nested coordinator folds the same way, closed until opened.
    expect(inside.queryByRole("button", { name: /^Pay/ })).not.toBeInTheDocument();
    await user.click(inside.getByRole("button", { name: "Checkout threads" }));
    expect(within(screen.getByRole("group", { name: "Inside Checkout" })).getByRole("button", { name: /^Pay/ })).toBeInTheDocument();
    expect(inside.getByRole("button", { name: "New thread under Lead" })).toBeInTheDocument();
    expect(inside.getByRole("button", { name: "New coordinator under Lead" })).toBeInTheDocument();
    // The row itself still opens the coordinator's chat.
    await user.click(screen.getByRole("button", { name: /^Lead ?Idle/ }));
    expect(router.state.location.pathname).toBe("/pane/lead");
  });

  it("keeps what was opened when the page is left and come back to", async () => {
    const first = setup(home([project]));
    await first.user.click(await screen.findByRole("button", { name: "Lead threads" }));
    expect(screen.getByRole("group", { name: "Inside Lead" })).toBeInTheDocument();
    first.router.dispose();
    document.body.innerHTML = "";
    setup(home([project]));
    expect(await screen.findByRole("group", { name: "Inside Lead" })).toBeInTheDocument();
  });

  it("heads the page with the project coordinator's STATUS.md while it says something, even with no coordinator running it", async () => {
    server.use(http.get("/api/org/summary", () => HttpResponse.json({ ok: true, coordinator: null, usage: null, threads: [],
      status: { ...ROOT_STATUS, text: "# Status\nObjective: Ship wholesale\n## Needs your decision\n- Stock layout", objective: "Ship wholesale", needsDecision: ["Stock layout"] } })));
    setup(home([project]));
    expect(await screen.findByRole("region", { name: "Status" })).toHaveTextContent("Stock layout");
  });

  it("puts the project coordinator first while it runs, instead of opening its chat", async () => {
    const running: ProjectView = { ...project, coordinator: { paneId: "coord", agent: "codex", liveStatus: "working" },
      threads: [...threads, node("t-8", "Wholesale", "root", { role: "coordinator", group: "idle" })] };
    const { router, user } = setup(home([running], [pane("coord"), pane("lead")]));
    const own = await screen.findByRole("region", { name: "Project coordinator" });
    expect(router.state.location.pathname).toBe("/project/hub");
    expect(titlesOf(within(own).getByRole("list"))).toEqual(["Project coordinator"]);
    expect(titlesOf(screen.getByRole("list", { name: "Coordinators" }))).toEqual(["Lead", "Wholesale"]);
    expect(own.compareDocumentPosition(screen.getByRole("list", { name: "Coordinators" })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Start project coordinator" })).not.toBeInTheDocument();
    // Its STATUS.md is under its own card now, not over the page.
    expect(screen.queryByText("Objective: (none)")).not.toBeInTheDocument();
    await user.click(within(own).getByRole("button", { name: "Project coordinator threads" }));
    expect(screen.getByRole("group", { name: "Inside Project coordinator" })).toBeInTheDocument();
  });
});

describe("a project with no coordinator under it", () => {
  it("opens its own coordinator's chat while it runs, as before", async () => {
    const solo: ProjectView = { ...project, coordinator: { paneId: "coord", agent: "codex", liveStatus: "working" }, threads: [node("t-7", "Hotfix", "root")] };
    const { router } = setup(home([solo], [pane("coord")]));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/coord"));
  });

  it("offers to start its coordinator over its threads, as before, also from an Organizations without coordinators", async () => {
    for (const shape of [{}, { source: "files" as const, nodeActions: false }]) {
      const flat: ProjectView = { ...project, ...shape, threads: [node("t-7", "Hotfix", "root"), node("t-9", "Docs", "root")] };
      const { router } = setup(home([flat], []));
      expect(await screen.findByRole("button", { name: "Start coordinator" })).toBeInTheDocument();
      expect(screen.getByText("Not running")).toBeInTheDocument();
      expect(screen.queryByRole("list", { name: "Coordinators" })).not.toBeInTheDocument();
      expect(titlesOf(screen.getByRole("list", { name: "Open threads" }))).toEqual(["Hotfix", "Docs"]);
      router.dispose();
      document.body.innerHTML = "";
    }
  });
});

describe("Move to…", () => {
  it("offers the top level and the open coordinators outside the node, and moves it there", async () => {
    let posted: unknown;
    server.use(http.post("/api/org/node/move", async ({ request }) => {
      posted = await request.json();
      return HttpResponse.json({ ok: true, moved: { id: "t-4", parent: "t-5" } });
    }));
    const { user } = setup(home([{ ...project, nodeMoves: true }]));
    await user.click(await screen.findByRole("button", { name: "Lead threads" }));
    await user.click(screen.getByRole("button", { name: "Move Docs" }));
    const dialog = within(screen.getByRole("dialog", { name: "Move this thread" }));
    expect(dialog.getAllByRole("radio").map((radio) => radio.closest("label")?.textContent)).toEqual(["Hub, at the top level", "Checkout"]);
    await user.click(dialog.getByRole("radio", { name: "Checkout" }));
    await user.click(dialog.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(posted).toEqual({ project: "hub", id: "t-4", parent: "t-5" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Move this thread" })).not.toBeInTheDocument());
  });

  it("says why Organizations refused, and keeps the dialog open", async () => {
    server.use(http.post("/api/org/node/move", () => HttpResponse.json({ ok: false, error: "node `t-5` does not have permission to spawn" }, { status: 502 })));
    const { user } = setup(home([{ ...project, nodeMoves: true }]));
    await user.click(await screen.findByRole("button", { name: "Lead threads" }));
    await user.click(screen.getByRole("button", { name: "Move Docs" }));
    const dialog = within(screen.getByRole("dialog", { name: "Move this thread" }));
    await user.click(dialog.getByRole("radio", { name: "Checkout" }));
    await user.click(dialog.getByRole("button", { name: "Move" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("does not have permission to spawn");
  });

  it("offers no Move where there is nowhere to go, or where Organizations has no node move", async () => {
    const first = setup(home([{ ...project, nodeMoves: true }]));
    // Lead sits at the top level and the only other coordinator is its own.
    expect(await screen.findByRole("button", { name: "Move Hotfix" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move Lead" })).not.toBeInTheDocument();
    first.router.dispose();
    document.body.innerHTML = "";
    setup(home([project]));
    expect(await screen.findByRole("button", { name: "Close Hotfix" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Move/ })).not.toBeInTheDocument();
  });
});
