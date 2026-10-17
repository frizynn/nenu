import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { onTestFinished } from "vitest";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { ProjectView } from "@/lib/types";
import { openNewAgent } from "@/lib/spawn";
import { server } from "@/test/setup";
import { NewAgentHost, openNewDialog } from "./new-agent-sheet";
import NewDialog, { newContext, projectCommand } from "./new-dialog";

const HOME = "/home/me";
const project: ProjectView = {
  slug: "acme",
  name: "Acme",
  status: "active",
  workspaceIds: ["w:2"],
  threads: [{ id: "t-1", title: "Coordinator", parentId: "root", role: "coordinator", status: "open" }],
};
const base: HomeData = {
  bridge: "connected", device: undefined, session: "work", sessions: [],
  error: false, authError: false, snoozedUntil: null, update: undefined, tabs: [], shellPanes: [],
  workspaces: [
    { workspaceId: "w:1", number: 1, label: "Nenu", focused: true, activeTabId: "t1", tabCount: 1, paneCount: 1 },
    { workspaceId: "w:2", number: 2, label: "rediseño mobile", focused: false, activeTabId: "t2", tabCount: 1, paneCount: 1 },
  ],
  agents: [
    { paneId: "w:2:p1", workspaceId: "w:2", workspaceLabel: "rediseño mobile", workspaceNumber: 2, tabId: "t2", agent: "codex", status: "idle", cwd: `${HOME}/code/acme`, focused: true },
  ],
  projects: [project],
};

const posts: Record<string, unknown[]> = {};
beforeEach(() => {
  localStorage.clear();
  for (const key of Object.keys(posts)) delete posts[key];
  const record = (path: string, reply: Record<string, unknown>) => http.post(path, async ({ request }) => {
    (posts[path] ??= []).push(await request.json());
    return HttpResponse.json(reply);
  });
  const pane = { paneId: "w:9:p1", workspaceId: "w:9", workspaceLabel: "new", tabId: "t9", cwd: HOME };
  server.use(
    http.get("/api/dirs", () => HttpResponse.json({ path: HOME, home: HOME, entries: ["code"], truncated: false })),
    http.get("/api/org/start-options", () => HttpResponse.json({ ok: true, templates: [], profiles: ["claude"] })),
    record("/api/tab", { ok: true, pane }),
    record("/api/workspace", { ok: true, pane }),
    record("/api/pane/:paneId/start", { ok: true }),
    record("/api/org/project/create", { ok: true, project: { slug: "panel-mayorista", name: "Panel mayorista" } }),
    record("/api/org/node/start", { ok: true, node: { id: "t-2" } }),
  );
});

function setup({ data = base, entry = "/pane/w%3A2%3Ap1?s=work", host = false }: { data?: HomeData; entry?: string; host?: boolean } = {}) {
  const onClose = vi.fn();
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID,
    path: "/",
    loader: () => data,
    element: <>{host ? <NewAgentHost /> : <NewDialog onClose={onClose} />}<Outlet /></>,
    children: [
      { path: "pane/:paneId", element: <p>Pane page</p> },
      { path: "project/:projectSlug", element: <p>Project page</p> },
      { path: "project/:projectSlug/node/:nodeId", element: <p>Node page</p> },
      { path: "space/:spaceId", element: <p>Space page</p> },
    ],
  }], { initialEntries: [entry] });
  render(<RouterProvider router={router} />);
  return { router, onClose, user: userEvent.setup() };
}

function desktop() {
  const matchMedia = window.matchMedia;
  window.matchMedia = (query) => ({
    matches: query === "(min-width: 1024px)" || query === "(pointer: fine)", media: query,
    addEventListener: () => {}, removeEventListener: () => {},
  }) as unknown as MediaQueryList;
  onTestFinished(() => { window.matchMedia = matchMedia; });
}

/** The kind rows of the list, by the name each one starts with. */
const kinds = (create: { getAllByRole: (role: "button") => HTMLElement[] }) => create.getAllByRole("button").map((row) => row.textContent);

it("groups what it starts, naming the workspace on screen, then lists every project and a new one", async () => {
  setup();
  const create = within(await screen.findByRole("navigation", { name: "Create" }));
  expect(create.getAllByRole("heading").map((h) => h.textContent)).toEqual(["Start an agent", "Projects"]);
  expect(kinds(create)).toEqual([
    expect.stringMatching(/^Here in rediseño mobile/),
    expect.stringMatching(/^In a new folder/),
    expect.stringMatching(/^Quick question/),
    expect.stringMatching(/^Acme1 coordinator/),
    expect.stringMatching(/^New project/),
  ]);
  expect(create.queryByLabelText("In")).toBeNull();
});

it("lists no project until there is one, and Here in until there is a workspace", async () => {
  setup({ data: { ...base, projects: [], workspaces: [], agents: [] }, entry: "/?s=work" });
  const create = within(await screen.findByRole("navigation", { name: "Create" }));
  expect(kinds(create)).toEqual([expect.stringMatching(/^In a new folder/), expect.stringMatching(/^Quick question/), expect.stringMatching(/^New project/)]);
});

it("opens a project on its step, offering New only where the project can start something", async () => {
  const paused: ProjectView = { ...project, slug: "old", name: "Old", status: "paused", workspaceIds: [] };
  const { user } = setup({ data: { ...base, projects: [paused, project] }, entry: "/space/w%3A1?s=work" });
  await user.click(await screen.findByRole("button", { name: /^Old/ }));
  expect(screen.getByRole("dialog", { name: "Old" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^New thread/ })).toBeNull();
  expect(screen.queryByRole("button", { name: /^New coordinator/ })).toBeNull();
  await user.click(screen.getByRole("button", { name: "Back" }));
  await user.click(screen.getByRole("button", { name: /^Acme/ }));
  await user.click(screen.getByRole("button", { name: /^New thread/ }));
  expect(screen.getByRole("dialog", { name: "New thread" })).toBeInTheDocument();
  // The step chose the project and the role, so the form asks for neither again.
  expect(screen.queryByLabelText("Project")).toBeNull();
  expect(screen.queryByRole("radiogroup", { name: "Role" })).toBeNull();
  // Back from the form returns to the project's step, not the list.
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("dialog", { name: "Acme" })).toBeInTheDocument();
});

it("names each step in the sheet's one title, and steps back from its header", async () => {
  const { user } = setup();
  expect(await screen.findByRole("dialog", { name: "New" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /^Here in/ }));
  expect(screen.getByRole("dialog", { name: "New tab" })).toBeInTheDocument();
  expect(screen.getAllByRole("heading", { name: /^New/ }).map((h) => h.textContent)).toEqual(["New tab"]);
  await user.click(screen.getByRole("button", { name: /^Directory/ }));
  expect(await screen.findByRole("dialog", { name: "Choose a folder" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("dialog", { name: "New tab" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Directory/ })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("dialog", { name: "New" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
});

it("draws one header, the sheet's own, at every step", async () => {
  const { user } = setup();
  const dialog = await screen.findByRole("dialog", { name: "New" });
  const header = () => ({
    headings: within(dialog).getAllByRole("heading", { level: 2 }).map((h) => h.textContent),
    closes: within(dialog).getAllByRole("button", { name: "Close" }).length,
  });
  expect(header()).toEqual({ headings: ["New"], closes: 1 });
  await user.click(screen.getByRole("button", { name: /^Here in/ }));
  expect(header()).toEqual({ headings: ["New tab"], closes: 1 });
  await user.click(screen.getByRole("button", { name: /^Directory/ }));
  await screen.findByRole("dialog", { name: "Choose a folder" });
  expect(header()).toEqual({ headings: ["Choose a folder"], closes: 1 });
});

it("steps back on a desk only from the folder picker, where the list of kinds stays in view", async () => {
  desktop();
  const { user } = setup({ entry: "/?s=work" });
  expect(await screen.findByRole("dialog", { name: "New tab" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
  await user.click(screen.getByRole("button", { name: /^Directory/ }));
  await user.click(await screen.findByRole("button", { name: "Back" }));
  expect(screen.getByRole("dialog", { name: "New tab" })).toBeInTheDocument();
});

it("moves focus to each step as it opens, so a keyboard never drops out of the sheet", async () => {
  const { user } = setup();
  const dialog = await screen.findByRole("dialog", { name: "New" });
  screen.getByRole("button", { name: /^Here in/ }).focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("heading", { name: "New tab" })).toHaveFocus();
  screen.getByRole("button", { name: /^Directory/ }).focus();
  await user.keyboard("{Enter}");
  expect(await screen.findByRole("heading", { name: "Choose a folder" })).toHaveFocus();
  screen.getByRole("button", { name: "Back" }).focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("heading", { name: "New tab" })).toHaveFocus();
  screen.getByRole("button", { name: "Back" }).focus();
  await user.keyboard("{Enter}");
  expect(screen.getByRole("heading", { name: "New" })).toHaveFocus();
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
});

it("puts the caret in the first thing to type on a desk", async () => {
  desktop();
  const { user } = setup({ entry: "/project/acme?s=work" });
  expect(await screen.findByRole("heading", { name: "Acme" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /^New coordinator/ }));
  await waitFor(() => expect(screen.getByLabelText("Title")).toHaveFocus());
  await user.click(screen.getByRole("button", { name: /^New project/ }));
  expect(screen.getByLabelText("Name")).toHaveFocus();
  await user.click(screen.getByRole("button", { name: /^Quick question/ }));
  expect(screen.getByLabelText("Message")).toHaveFocus();
});

it("opens from a tab's + on New tab in that workspace, one Back from the list", async () => {
  const { user } = setup({ host: true });
  onTestFinished(() => openNewAgent(null));
  act(() => openNewAgent({ kind: "tab", workspaceId: "w:1" }));
  expect(await screen.findByRole("dialog", { name: "New tab" })).toBeInTheDocument();
  expect(screen.getByLabelText("Workspace")).toHaveValue("w:1");
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("dialog", { name: "New" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Here in Nenu/ })).toBeInTheDocument();
});

it("opens from Home's composer on New workspace with the message already written", async () => {
  setup({ host: true, entry: "/?s=work" });
  onTestFinished(() => openNewAgent(null));
  act(() => openNewAgent({ kind: "workspace", message: "Audit the auth flow" }));
  expect(await screen.findByRole("dialog", { name: "New workspace" })).toBeInTheDocument();
  expect(screen.getByLabelText("First message (optional)")).toHaveValue("Audit the auth flow");
  expect(screen.getAllByRole("dialog")).toHaveLength(1);
});

it("opens from New on the list, and closes from its header", async () => {
  const { user } = setup({ host: true, entry: "/?s=work" });
  onTestFinished(() => openNewDialog(false));
  act(() => openNewDialog());
  expect(await screen.findByRole("dialog", { name: "New" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("starts over when New is asked for again over an open flow", async () => {
  setup({ host: true });
  onTestFinished(() => { openNewAgent(null); openNewDialog(false); });
  act(() => openNewAgent({ kind: "tab", workspaceId: "w:1" }));
  expect(await screen.findByRole("dialog", { name: "New tab" })).toBeInTheDocument();
  act(() => openNewDialog());
  expect(await screen.findByRole("dialog", { name: "New" })).toBeInTheDocument();
});

it("opens a tab with the chosen agent in the workspace on screen, then opens its pane", async () => {
  const { user, router, onClose } = setup();
  await user.click(await screen.findByRole("button", { name: /^Here in/ }));
  expect(screen.getByLabelText("Workspace")).toHaveValue("w:2");
  await user.click(screen.getByRole("radio", { name: "Codex" }));
  await user.click(screen.getByRole("button", { name: "Start Codex" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts["/api/tab"]).toEqual([{ workspaceId: "w:2", cwd: `${HOME}/code/acme` }]);
  expect(router.state.location.pathname).toBe("/pane/w%3A9%3Ap1");
  await waitFor(() => expect(posts["/api/pane/:paneId/start"]).toEqual([{ agent: "codex", permission: "ask" }]));
});

it("creates a project, keeping the exact command it runs folded away until asked, and opens it", async () => {
  const { user, router, onClose } = setup();
  await user.click(await screen.findByRole("button", { name: /^New project/ }));
  await user.type(await screen.findByLabelText("Name"), "Panel mayorista");
  await user.type(screen.getByLabelText("Goal"), "Stock by depot");
  expect(screen.getByLabelText("Command")).not.toBeVisible();
  await user.click(screen.getByText("Command", { selector: "summary" }));
  expect(screen.getByLabelText("Command")).toBeVisible();
  expect(screen.getByLabelText("Command")).toHaveTextContent("herdr-organizations new --goal='Stock by depot' --json -- 'Panel mayorista'");
  await user.click(screen.getByRole("button", { name: "Create project" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts["/api/org/project/create"]).toEqual([{ name: "Panel mayorista", goal: "Stock by depot" }]);
  expect(router.state.location.pathname).toBe("/project/panel-mayorista");
});

it("starts a coordinator in the project on screen, straight away on a desk, and says it is starting until it runs", async () => {
  desktop();
  const { user, router } = setup();
  expect(await screen.findByRole("heading", { name: "Acme" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /^New coordinator/ }));
  await user.type(screen.getByLabelText("Title"), "Filters");
  await user.selectOptions(screen.getByLabelText("Parent"), "t-1");
  await user.type(screen.getByLabelText("Task"), "Add a depot filter.");
  await user.click(screen.getByRole("button", { name: "Create coordinator" }));
  expect(await screen.findByRole("status")).toHaveTextContent("Filters is starting.");
  expect(posts["/api/org/node/start"]).toEqual([{ project: "acme", role: "coordinator", title: "Filters", parent: "t-1", task: "Add a depot filter." }]);
  // Its page is one tap away while the chat is not up yet.
  await user.click(screen.getByRole("button", { name: "Open its page" }));
  expect(router.state.location.pathname).toBe("/project/acme/node/t-2");
});

it("makes the scratch workspace on the bridge's home for the first quick chat, then reuses it", async () => {
  localStorage.setItem("collie.spawn.dirs", JSON.stringify([`${HOME}/code/acme`]));
  const first = setup();
  await first.user.click(await screen.findByRole("button", { name: /^Quick question/ }));
  await first.user.type(await screen.findByLabelText("Message"), "what is 2+2");
  await first.user.click(screen.getByRole("button", { name: "Ask Claude Code" }));
  // No cwd: the bridge puts a new workspace on its home, and ~ never becomes the last folder picked.
  await waitFor(() => expect(posts["/api/workspace"]).toEqual([{ label: "scratch" }]));
  expect(JSON.parse(localStorage.getItem("collie.spawn.dirs")!)).toEqual([`${HOME}/code/acme`]);
  first.router.dispose();
  document.body.innerHTML = "";

  const scratch = { workspaceId: "w:5", number: 5, label: "scratch", focused: false, activeTabId: "t5", tabCount: 1, paneCount: 1 };
  const second = setup({ data: { ...base, workspaces: [...base.workspaces, scratch] } });
  await second.user.click(await screen.findByRole("button", { name: /^Quick question/ }));
  expect(await screen.findByText(/Opens in the/)).toHaveTextContent("Opens in the scratch workspace on ~.");
  await second.user.click(screen.getByRole("button", { name: "Ask Claude Code" }));
  await waitFor(() => expect(posts["/api/tab"]).toEqual([{ workspaceId: "w:5" }]));
});

it("opens on Tab on a desk when nothing on screen belongs to a project, and shows the project a thread would use", async () => {
  desktop();
  const { user } = setup({ entry: "/space/w%3A1?s=work" });
  expect(await screen.findByRole("heading", { name: "New tab" })).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /^Acme/ }));
  await user.click(await screen.findByRole("button", { name: /^New thread/ }));
  expect(await screen.findByRole("heading", { name: "New thread" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /^Acme/ })).toHaveAttribute("aria-current", "true");
});

it("marks a create in flight as busy, not as unavailable", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  server.use(
    http.post("/api/org/project/create", async () => { await held; return HttpResponse.json({ ok: true, project: { slug: "p", name: "P" } }); }),
    http.post("/api/workspace", async () => { await held; return HttpResponse.json({ ok: false, error: "held" }); }),
  );
  const project = setup();
  await project.user.click(await screen.findByRole("button", { name: /^New project/ }));
  await project.user.type(await screen.findByLabelText("Name"), "P");
  expect(screen.getByRole("button", { name: "Create project" })).not.toHaveAttribute("aria-busy");
  await project.user.click(screen.getByRole("button", { name: "Create project" }));
  expect(await screen.findByRole("button", { name: "Creating…" })).toHaveAttribute("aria-busy", "true");
  project.router.dispose();
  document.body.innerHTML = "";

  const chat = setup();
  await chat.user.click(await screen.findByRole("button", { name: /^Quick question/ }));
  await chat.user.click(await screen.findByRole("button", { name: "Ask Claude Code" }));
  expect(await screen.findByRole("button", { name: "Starting…" })).toHaveAttribute("aria-busy", "true");
  release();
});

it("creates nothing from a read-only device", async () => {
  const { user } = setup({ data: { ...base, device: { enforced: true, authorized: false } as HomeData["device"] } });
  await user.click(await screen.findByRole("button", { name: /^New project/ }));
  await user.type(await screen.findByLabelText("Name"), "x");
  expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
});

describe("+ → a project → a coordinator → its chat", () => {
  // The project's own coordinator runs; Lead runs in a pane and Checkout under it has none; a closed
  // coordinator and a thread are not coordinators to pick.
  const organizer: ProjectView = {
    slug: "acme", name: "Acme", status: "active", workspaceIds: ["w:2"], nodeActions: true,
    coordinator: { paneId: "w:2:p1", agent: "codex", liveStatus: "idle" },
    threads: [
      { id: "t-1", title: "Lead", parentId: "root", role: "coordinator", status: "open", paneId: "w:2:p2", agent: "claude", liveStatus: "working" },
      { id: "t-2", title: "Checkout", parentId: "t-1", role: "coordinator", status: "open", group: "waiting-on-you" },
      { id: "t-3", title: "Old push", parentId: "root", role: "coordinator", status: "resolved" },
      { id: "t-4", title: "Hotfix", parentId: "root", role: "worker", status: "open" },
    ],
  };
  const pane = (paneId: string) => ({ ...base.agents[0]!, paneId, focused: false });
  const data: HomeData = { ...base, agents: [pane("w:2:p1"), pane("w:2:p2")], projects: [organizer] };
  const step = () => within(screen.getByRole("region", { name: "Coordinators" }));

  it("lists the project's coordinators, its own first, each with its state, and opens the chat of the one picked", async () => {
    const { user, router, onClose } = setup({ data, entry: "/?s=work" });
    await user.click(await screen.findByRole("button", { name: /^Acme3 coordinators/ }));
    expect(screen.getByRole("dialog", { name: "Acme" })).toBeInTheDocument();
    expect(step().getAllByRole("button").map((row) => row.textContent)).toEqual([
      "Project coordinatorIdle · codex",
      "LeadWorking · claude",
      "CheckoutNeeds you · under Lead",
    ]);
    await user.click(step().getByRole("button", { name: /^Lead/ }));
    expect(router.state.location.pathname).toBe("/pane/w%3A2%3Ap2");
    expect(onClose).toHaveBeenCalled();
  });

  it("puts New coordinator above the coordinators, so a long list never hides it", async () => {
    const many: ProjectView = { ...organizer, threads: [...organizer.threads, ...Array.from({ length: 11 }, (_, index) =>
      ({ id: `t-${100 + index}`, title: `coord-${index}`, parentId: "root", role: "coordinator" as const, status: "open" as const }))] };
    const { user } = setup({ data: { ...data, projects: [many] }, entry: "/?s=work" });
    await user.click(await screen.findByRole("button", { name: /^Acme/ }));
    const [start, coordinators] = ["Start or open", "Coordinators"].map((name) => screen.getByRole("region", { name }));
    expect(start!.compareDocumentPosition(coordinators!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(start!).getByRole("button", { name: /^New coordinator/ })).toBeInTheDocument();
  });

  it("opens the project coordinator's chat, and a coordinator with no pane on its page", async () => {
    const first = setup({ data, entry: "/?s=work" });
    await first.user.click(await screen.findByRole("button", { name: /^Acme/ }));
    await first.user.click(step().getByRole("button", { name: /^Project coordinator/ }));
    expect(first.router.state.location.pathname).toBe("/pane/w%3A2%3Ap1");
    first.router.dispose();
    document.body.innerHTML = "";

    const second = setup({ data, entry: "/?s=work" });
    await second.user.click(await screen.findByRole("button", { name: /^Acme/ }));
    await second.user.click(step().getByRole("button", { name: /^Checkout/ }));
    expect(second.router.state.location.pathname).toBe("/project/acme/node/t-2");
  });

  it("creates a coordinator at the project's top level and opens its chat once it runs", async () => {
    let started = false;
    server.use(http.post("/api/org/node/start", async ({ request }) => {
      (posts["/api/org/node/start"] ??= []).push(await request.json());
      started = true;
      return HttpResponse.json({ ok: true, node: { id: "t-9" } });
    }));
    const fresh: ProjectView = { ...organizer, threads: [...organizer.threads,
      { id: "t-9", title: "Wholesale", parentId: "root", role: "coordinator", status: "open", paneId: "w:3:p1", agent: "claude", liveStatus: "idle" }] };
    const onClose = vi.fn();
    const router = createMemoryRouter([{
      id: ROOT_ROUTE_ID, path: "/", loader: () => started ? { ...data, agents: [...data.agents, pane("w:3:p1")], projects: [fresh] } : data,
      element: <><NewDialog onClose={onClose} /><Outlet /></>,
      children: [{ index: true, element: <p>Home</p> }, { path: "pane/:paneId", element: <p>Pane page</p> }],
    }], { initialEntries: ["/?s=work"] });
    render(<RouterProvider router={router} />);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: /^Acme/ }));
    await user.click(screen.getByRole("button", { name: /^New coordinator/ }));
    expect(screen.getByRole("dialog", { name: "New coordinator" })).toBeInTheDocument();
    // A new coordinator is the project's: the form starts on the top level and names no thread role.
    expect(screen.getByLabelText("Parent")).toHaveValue("root");
    expect(screen.queryByRole("radiogroup", { name: "Role" })).toBeNull();
    await user.type(screen.getByLabelText("Title"), "Wholesale");
    await user.type(screen.getByLabelText("Task"), "Run the wholesale launch.");
    await user.click(screen.getByRole("button", { name: "Create coordinator" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/pane/w%3A3%3Ap1"));
    expect(onClose).toHaveBeenCalled();
    expect(posts["/api/org/node/start"]).toEqual([{ project: "acme", role: "coordinator", title: "Wholesale", parent: "root", task: "Run the wholesale launch." }]);
  });

  it("with an Organizations that has no coordinators, offers a thread and the project's page, never a coordinator", async () => {
    const old: ProjectView = { slug: "acme", name: "Acme", status: "active", nodeActions: false, threads: [{ id: "t-4", title: "Hotfix", parentId: "root", role: "worker", status: "open" }] };
    const { user, router } = setup({ data: { ...base, projects: [old] }, entry: "/?s=work" });
    await user.click(await screen.findByRole("button", { name: /^Acme/ }));
    expect(step().queryAllByRole("button")).toEqual([]);
    expect(step().getByText("No coordinator runs here yet.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^New coordinator/ })).toBeNull();
    expect(screen.getByRole("button", { name: /^New thread/ })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Open project/ }));
    expect(router.state.location.pathname).toBe("/project/acme");
  });
});

describe("projectCommand", () => {
  it("quotes what a shell would split and leaves plain words bare", () => {
    expect(projectCommand("api", "", "/home/me/code/api")).toBe("herdr-organizations new --repo=/home/me/code/api --json -- api");
    expect(projectCommand("it's", "a b", "")).toBe(`herdr-organizations new --goal='a b' --json -- 'it'\\''s'`);
  });
});

describe("newContext", () => {
  it("takes the workspace and project of the pane, space or project on screen", () => {
    expect(newContext(base, { paneId: "w:2:p1" })).toEqual({ workspaceId: "w:2", project: "acme" });
    expect(newContext(base, { spaceId: "w:1" })).toEqual({ workspaceId: "w:1", project: undefined });
    expect(newContext(base, {})).toEqual({ workspaceId: "w:1", project: undefined });
    expect(newContext(base, { projectSlug: "acme" })).toEqual({ workspaceId: "w:2", project: "acme" });
  });
});

it("with more than one machine, a chat in a new folder starts on the machine picked, its folders read there", async () => {
  const dirSessions: string[] = [];
  const createSessions: string[] = [];
  const pane = { paneId: "w:9:p1", workspaceId: "w:9", workspaceLabel: "new", tabId: "t9", cwd: HOME };
  server.use(
    http.get("/api/dirs", ({ request }) => {
      dirSessions.push(new URL(request.url).searchParams.get("session") ?? "");
      return HttpResponse.json({ path: HOME, home: HOME, entries: ["code"], truncated: false });
    }),
    http.post("/api/workspace", ({ request }) => {
      createSessions.push(new URL(request.url).searchParams.get("session") ?? "");
      return HttpResponse.json({ ok: true, pane });
    }),
  );
  const machines: HomeData["machines"] = [
    { label: "studio", state: "connected" },
    { session: "@build-box", label: "build-box", state: "connected", herd: { bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [] } },
    { session: "@lab", label: "lab", state: "offline", detail: "ssh: connect to host lab port 22: Connection refused" },
  ];
  const { user, router } = setup({ data: { ...base, session: undefined, machines }, entry: "/" });
  await user.click(await screen.findByRole("button", { name: /^In a new folder/ }));
  const picker = within(screen.getByRole("radiogroup", { name: "Machine" }));
  expect(picker.getAllByRole("radio").map((radio) => radio.textContent)).toEqual(["studio", "build-box"]);
  await user.click(picker.getByRole("radio", { name: "build-box" }));
  await user.click(screen.getByRole("button", { name: /^Start/ }));
  await waitFor(() => expect(router.state.location.search).toBe("?s=%40build-box"));
  expect(createSessions).toEqual(["@build-box"]);
  expect(dirSessions).toContain("@build-box");
});

it("with one machine there is nothing to pick", async () => {
  const { user } = setup({ entry: "/" });
  await user.click(await screen.findByRole("button", { name: /^In a new folder/ }));
  expect(screen.queryByRole("radiogroup", { name: "Machine" })).toBeNull();
});
