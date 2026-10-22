import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, MemoryRouter, Outlet, RouterProvider } from "react-router";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { AgentView, ProjectThreadView, ProjectView } from "@/lib/types";
import { server } from "@/test/setup";
import { __forgetSummaries } from "@/hooks/use-thread-summaries";
import { ProjectTasks } from "@/components/project-tasks";
import { ProjectRoute } from "./project";

// A project that organizes coordinators (ADR 0092): a row per coordinator that enters its chat, its
// threads folded under it (ADR 0115), and a node can move under another from the tree its chat lists.

// A desk: row actions show as words, not behind a ⋯.
vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: () => false }));

const node = (id: string, title: string, parentId: string, extra: Partial<ProjectThreadView> = {}): ProjectThreadView =>
  ({ id, title, parentId, role: "worker", status: "open", ...extra });
const pane = (paneId: string): AgentView => ({ paneId, workspaceId: "w", workspaceLabel: "w", workspaceNumber: 1, tabId: "t", agent: "claude", status: "idle", cwd: "/", focused: false });

/** Lead runs Docs (waiting on you) and Checkout, which runs Pay; Hotfix sits at the top level; Plan is History. Organizations can move every open one. */
const threads: ProjectThreadView[] = [
  node("t-1", "Plan", "root", { role: "coordinator", status: "resolved" }),
  node("t-3", "Lead", "root", { role: "coordinator", paneId: "lead", liveStatus: "idle", agent: "claude", movable: true }),
  node("t-4", "Docs", "t-3", { group: "waiting-on-you", movable: true }),
  node("t-5", "Checkout", "t-3", { role: "coordinator", group: "working", movable: true }),
  node("t-6", "Pay", "t-5", { group: "idle", movable: true }),
  node("t-7", "Hotfix", "root", { group: "idle", movable: true }),
];
const project: ProjectView = { slug: "hub", name: "Hub", goal: "Ship it", status: "active", source: "json", nodeActions: true, waitingAsks: 0, threads };

function home(projects: ProjectView[], agents: AgentView[] = [pane("lead")]): HomeData {
  return { bridge: "connected", agents, shellPanes: [], workspaces: [], tabs: [], projects, device: undefined, sessions: [], session: undefined, snoozedUntil: null, update: undefined, error: false, authError: false };
}

const ROOT_STATUS = { text: "# Status\nObjective: (none)\n\n## Asked\n\n## Decisions\n", updated: "2026-10-17T10:00:00Z" };

beforeEach(() => {
  sessionStorage.clear();
  __forgetSummaries();
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
      { path: "asks", element: <p>ASKS</p> },
    ],
  }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return { router, user: userEvent.setup() };
}

/** The titles of a list's own rows, not of the ones nested inside them. */
const titlesOf = (list: HTMLElement) => [...list.children].map((item) => item.querySelector(".task-main .font-medium")?.textContent);

describe("a project that organizes coordinators", () => {
  it("is a row per coordinator, the project coordinator's last with the threads started from the project, each folded", async () => {
    setup(home([project]));
    const lead = await screen.findByRole("listitem", { name: "Lead" });
    expect(within(screen.getByRole("list", { name: "Coordinators" })).getAllByRole("listitem").map((row) => row.getAttribute("aria-label")))
      .toEqual(["Lead", "Checkout", "Project coordinator"]);
    // The row says what is live there, in one line.
    expect(within(lead).getByRole("button", { name: /^Open Lead/ })).toHaveAccessibleDescription("1 needs you");
    // Folded: no thread shows until its row unfolds.
    expect(screen.queryByRole("button", { name: /^Docs/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Hotfix/ })).not.toBeInTheDocument();
    // No project coordinator to start as if it were missing, and not its empty STATUS.md on top.
    expect(screen.queryByText("Not running")).not.toBeInTheDocument();
    expect(screen.queryByText("Objective: (none)")).not.toBeInTheDocument();
    // Starting it is one small action beside New.
    expect(screen.getByRole("button", { name: "Start project coordinator" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New coordinator" })).toBeInTheDocument();
  });

  it("says what a coordinator is doing, never that it is ready for review", async () => {
    const reported = threads.map((thread) => thread.id === "t-3" ? { ...thread, liveStatus: "done" as const, group: "ready-for-review", verdict: "done" as const } : thread);
    setup(home([{ ...project, threads: reported }]));
    const lead = await screen.findByRole("listitem", { name: "Lead" });
    expect(lead).not.toHaveTextContent(/review/i);
  });

  it("enters a coordinator's chat on a tap anywhere on its row; one with no chat opens its page", async () => {
    const { user, router } = setup(home([project]));
    await user.click(await screen.findByRole("button", { name: /^Open Lead/ }));
    expect(router.state.location.pathname).toBe("/pane/lead");
    await router.navigate(-1);
    await user.click(await screen.findByRole("button", { name: /^Open Checkout/ }));
    expect(router.state.location.pathname).toBe("/project/hub/node/t-5");
  });

  it("unfolds a row's threads in place, where it has some, and keeps the fold for the tab", async () => {
    const { user } = setup(home([project]));
    const lead = await screen.findByRole("listitem", { name: "Lead" });
    await user.click(within(lead).getByRole("button", { name: "Show Lead threads" }));
    expect(within(lead).getByRole("group", { name: "Lead threads" })).toHaveTextContent("Docs");
    // + shows on a desk's hover; a touch screen hides it (project.css) and starts a thread inside the chat.
    expect(within(lead).getByRole("button", { name: "New thread under Lead" })).toHaveClass("desk-card-add");
    expect(JSON.parse(sessionStorage.getItem("nenu.folds.hub") ?? "{}")).toEqual({ "t-3": true });
    // A row with no thread has no chevron.
    const lone: ProjectView = { ...project, threads: [...threads, node("t-8", "Wholesale", "root", { role: "coordinator", group: "idle" })] };
    cleanup();
    setup(home([lone]));
    const wholesale = await screen.findByRole("listitem", { name: "Wholesale" });
    expect(within(wholesale).queryByRole("button", { name: /threads$/ })).not.toBeInTheDocument();
  });

  it("leads with what waits on you there, and leaves the goal to the desk", async () => {
    const { user, router } = setup(home([{ ...project, waitingAsks: 2 }]));
    const waiting = await screen.findByRole("link", { name: /2 asks wait on you/ });
    expect(screen.queryByText("Ship it")).not.toBeInTheDocument();
    await user.click(waiting);
    expect(router.state.location.pathname).toBe("/asks");
    expect(router.state.location.search).toBe("?project=hub");
  });

  it("heads the page with the project coordinator's STATUS.md while it says something, even with no coordinator running it", async () => {
    server.use(http.get("/api/org/summary", () => HttpResponse.json({ ok: true, coordinator: null, usage: null, threads: [],
      status: { ...ROOT_STATUS, text: "# Status\nObjective: Ship wholesale\n## Needs your decision\n- Stock layout", objective: "Ship wholesale", needsDecision: ["Stock layout"] } })));
    setup(home([project]));
    expect(await screen.findByRole("region", { name: "Status" })).toHaveTextContent("Stock layout");
  });

  it("keeps its page while the project coordinator runs, which its own row enters", async () => {
    const running: ProjectView = { ...project, coordinator: { paneId: "coord", agent: "codex", liveStatus: "working" },
      threads: [...threads, node("t-8", "Wholesale", "root", { role: "coordinator", group: "idle" })] };
    const { router, user } = setup(home([running], [pane("coord"), pane("lead")]));
    const own = await screen.findByRole("listitem", { name: "Project coordinator" });
    expect(router.state.location.pathname).toBe("/project/hub");
    expect(within(screen.getByRole("list", { name: "Coordinators" })).getAllByRole("listitem").map((row) => row.getAttribute("aria-label")))
      .toEqual(["Lead", "Checkout", "Wholesale", "Project coordinator"]);
    expect(within(own).getByRole("button", { name: /^Open Project coordinator/ })).toHaveAccessibleDescription("working");
    expect(screen.queryByRole("button", { name: "Start project coordinator" })).not.toBeInTheDocument();
    // Its STATUS.md is in its chat, not over this page.
    expect(screen.queryByText("Objective: (none)")).not.toBeInTheDocument();
    await user.click(within(own).getByRole("button", { name: /^Open Project coordinator/ }));
    expect(router.state.location.pathname).toBe("/pane/coord");
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

// Move is a row action of the tree a coordinator's chat lists under Threads (ProjectTasks).
function tree(shown: ProjectView) {
  const view = render(<MemoryRouter><ProjectTasks project={shown} panes={[pane("lead")]} readOnly={false} onOpenPane={() => {}} onOpenNode={() => {}} onChanged={() => {}} /></MemoryRouter>);
  return { ...view, user: userEvent.setup() };
}

describe("Move to…", () => {
  it("offers the top level and the open coordinators outside the node, and moves it there", async () => {
    let posted: unknown;
    server.use(http.post("/api/org/node/move", async ({ request }) => {
      posted = await request.json();
      return HttpResponse.json({ ok: true, moved: { id: "t-7", parent: "t-5" } });
    }));
    const { user } = tree({ ...project, nodeMoves: true });
    await user.click(await screen.findByRole("button", { name: "Move Hotfix" }));
    const dialog = within(screen.getByRole("dialog", { name: "Move this thread" }));
    expect(dialog.getAllByRole("radio").map((radio) => radio.closest("label")?.textContent)).toEqual(["Lead", "Checkout"]);
    await user.click(dialog.getByRole("radio", { name: "Checkout" }));
    await user.click(dialog.getByRole("button", { name: "Move" }));
    await waitFor(() => expect(posted).toEqual({ project: "hub", id: "t-7", parent: "t-5" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Move this thread" })).not.toBeInTheDocument());
  });

  it("says why Organizations refused, and keeps the dialog open", async () => {
    server.use(http.post("/api/org/node/move", () => HttpResponse.json({ ok: false, error: "node `t-5` does not have permission to spawn" }, { status: 502 })));
    const { user } = tree({ ...project, nodeMoves: true });
    await user.click(await screen.findByRole("button", { name: "Move Hotfix" }));
    const dialog = within(screen.getByRole("dialog", { name: "Move this thread" }));
    await user.click(dialog.getByRole("radio", { name: "Checkout" }));
    await user.click(dialog.getByRole("button", { name: "Move" }));
    expect(await dialog.findByRole("alert")).toHaveTextContent("does not have permission to spawn");
  });

  it("offers no Move where there is nowhere to go, or where Organizations has no node move", async () => {
    const first = tree({ ...project, nodeMoves: true });
    // Lead sits at the top level and the only other coordinator is its own.
    expect(await screen.findByRole("button", { name: "Move Hotfix" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move Lead" })).not.toBeInTheDocument();
    first.unmount();
    tree(project);
    expect(await screen.findByRole("button", { name: "Close Hotfix" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Move/ })).not.toBeInTheDocument();
  });

  it("offers Move only on a node whose actions Organizations lists it in", async () => {
    const fixed = threads.map((thread) => thread.id === "t-7" ? { ...thread, movable: undefined } : thread);
    tree({ ...project, nodeMoves: true, threads: fixed });
    expect(await screen.findByRole("button", { name: "Close Hotfix" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move Hotfix" })).not.toBeInTheDocument();
  });
});

// The STATUS.md heads the page, so the list under it must not be drawn before it and then pushed down.
describe("loading a project's page", () => {
  const workers: ProjectView = { ...project, threads: [node("t-7", "Hotfix", "root", { group: "idle" }), node("t-8", "Docs", "root", { group: "working" })] };
  const STATUS = { text: "# Status\nObjective: Ship wholesale", updated: "2026-10-17T10:00:00Z", objective: "Ship wholesale" };
  const answer = () => HttpResponse.json({ ok: true, coordinator: null, usage: null, threads: [], status: STATUS });
  const pending = () => new Promise<never>(() => {});

  it("draws the list together with its STATUS.md, never before it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((done) => { release = done; });
    server.use(http.get("/api/org/summary", async () => { await gate; return answer(); }));
    setup(home([workers]));
    await screen.findByRole("heading", { name: "Hub" });
    expect(screen.queryByRole("list", { name: "Open threads" })).not.toBeInTheDocument();
    release();
    const status = await screen.findByRole("region", { name: "Status" });
    expect(status).toHaveTextContent("Ship wholesale");
    expect(screen.getByRole("list", { name: "Open threads" })).toBeInTheDocument();
  });

  it("opened again with the same stamps, draws its STATUS.md in the first frame while it reads behind it", async () => {
    server.use(http.get("/api/org/summary", answer));
    setup(home([workers]));
    await screen.findByRole("region", { name: "Status" });
    cleanup();
    server.use(http.get("/api/org/summary", pending));
    setup(home([workers]));
    await screen.findAllByRole("heading", { name: "Hub" });
    expect(screen.getByRole("region", { name: "Status" })).toHaveTextContent("Ship wholesale");
    expect(screen.getByRole("list", { name: "Open threads" })).toBeInTheDocument();
  });

  it("waits for a STATUS.md edited since, rather than draw the old one", async () => {
    server.use(http.get("/api/org/summary", answer));
    setup(home([workers]));
    await screen.findByRole("region", { name: "Status" });
    cleanup();
    server.use(http.get("/api/org/summary", pending));
    setup(home([{ ...workers, statusUpdated: "2026-10-17T11:00:00Z" }]));
    await screen.findByRole("heading", { name: "Hub" });
    expect(screen.queryByRole("region", { name: "Status" })).not.toBeInTheDocument();
    expect(screen.queryByRole("list", { name: "Open threads" })).not.toBeInTheDocument();
  });

  it("draws without it when the read takes over a second", async () => {
    server.use(http.get("/api/org/summary", pending));
    setup(home([workers]));
    expect(await screen.findByRole("list", { name: "Open threads" }, { timeout: 2_000 })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Status" })).not.toBeInTheDocument();
  });
});
