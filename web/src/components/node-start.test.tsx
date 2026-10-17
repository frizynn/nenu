import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { onTestFinished, vi } from "vitest";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { ProjectView, TemplateView } from "@/lib/types";
import { server } from "@/test/setup";
import { NewAgentHost, openNewDialog } from "./new-agent-sheet";
import { NewNodeActions } from "./node-start";

const project: ProjectView = {
  slug: "nenu",
  name: "Nenu",
  status: "active",
  nodeActions: true,
  threads: [
    { id: "t-1000", title: "Release", parentId: "root", role: "coordinator", status: "open" },
    { id: "t-2000", title: "Worker", parentId: "root", role: "worker", status: "open" },
    { id: "t-3000", title: "Old plan", parentId: "root", role: "coordinator", status: "resolved" },
  ],
};

const template: TemplateView = {
  name: "review-worker",
  scope: "project",
  description: "Review a change",
  role: "worker",
  canSpawn: true,
  harness: "claude",
  model: "sonnet",
  reasoningEffort: "high",
  rulesChars: 40,
  memoryChars: 15,
  updated: "2026-09-30T10:00:00Z",
};

/** The actions on a project page, with the New flow mounted at the root as the app mounts it. */
function renderActions(on: ProjectView, { session, onStarted = vi.fn(), others = [] }: { session?: string; onStarted?: () => void; others?: ProjectView[] } = {}) {
  onTestFinished(() => openNewDialog(false));
  const data = {
    bridge: "connected", device: undefined, session, sessions: [], error: false, authError: false, snoozedUntil: null, update: undefined,
    tabs: [], shellPanes: [], workspaces: [], agents: [], projects: [on, ...others],
  } as unknown as HomeData;
  let loads = 0;
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID,
    path: "/",
    loader: () => (loads += 1, data),
    element: <><NewAgentHost /><Outlet /></>,
    children: [{ path: "project/:projectSlug", element: <NewNodeActions project={on} session={session} onStarted={onStarted} /> }],
  }], { initialEntries: [`/project/${on.slug}`] });
  render(<RouterProvider router={router} />);
  return { router, onStarted, loads: () => loads, user: userEvent.setup() };
}

function serveOptions(options: { templates?: TemplateView[]; profiles?: string[] } = {}) {
  let requests = 0;
  server.use(http.get("/api/org/start-options", () => {
    requests += 1;
    return HttpResponse.json({ ok: true, templates: options.templates ?? [], profiles: options.profiles ?? ["claude", "codex"] });
  }));
  return () => requests;
}

function recordStart() {
  const posted: unknown[] = [];
  let url = "";
  server.use(http.post("/api/org/node/start", async ({ request }) => {
    posted.push(await request.json());
    url = request.url;
    return HttpResponse.json({ ok: true, node: { id: "t-4000" } });
  }));
  return { posted, url: () => url };
}

it("creates a coordinator under an open coordinator with the profile picked, reading options only once the form opens", async () => {
  const requests = serveOptions();
  const start = recordStart();
  const { user, onStarted, router } = renderActions(project, { session: "work" });

  const open = await screen.findByRole("button", { name: "New coordinator" });
  expect(requests()).toBe(0);
  await user.click(open);
  const dialog = within(await screen.findByRole("dialog", { name: "New coordinator" }));
  await user.type(dialog.getByLabelText("Title"), "Billing");
  // Only open coordinators can take children; the resolved one and the worker are not offered.
  const parent = dialog.getByLabelText("Parent");
  expect(within(parent).getAllByRole("option").map((option) => option.textContent)).toEqual(["Project root", "Release"]);
  await user.selectOptions(parent, "t-1000");
  await user.selectOptions(await dialog.findByLabelText("Profile"), "codex");
  await user.type(dialog.getByLabelText("Task"), "Coordinate invoices and receipts.");
  await user.click(dialog.getByRole("button", { name: "Create coordinator" }));

  await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
  expect(start.posted).toEqual([{ project: "nenu", role: "coordinator", title: "Billing", parent: "t-1000", task: "Coordinate invoices and receipts.", profile: "codex" }]);
  expect(new URL(start.url()).searchParams.get("session")).toBe("work");
  expect(requests()).toBe(1);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  // The page that asked refreshes itself; starting from it never navigates away.
  expect(router.state.location.pathname).toBe("/project/nenu");
});

it("opens the one New flow on the project's thread, a Back away from everything else it can start", async () => {
  serveOptions();
  const { user } = renderActions(project);
  await user.click(await screen.findByRole("button", { name: "New thread" }));
  expect(await screen.findByRole("dialog", { name: "New thread" })).toBeInTheDocument();
  expect(screen.getByLabelText("Project")).toHaveValue("nenu");
  await user.click(screen.getByRole("button", { name: "Back" }));
  expect(screen.getByRole("dialog", { name: "New" })).toBeInTheDocument();
  expect(within(screen.getByRole("navigation", { name: "Create" })).getByRole("button", { name: /^Nenu/ })).toBeInTheDocument();
});

it("starts a thread from a template, which carries its own profile", async () => {
  serveOptions({ templates: [template, { ...template, name: "planner", role: "coordinator" }] });
  const start = recordStart();
  const { user } = renderActions(project);

  await user.click(await screen.findByRole("button", { name: "New thread" }));
  const dialog = within(await screen.findByRole("dialog", { name: "New thread" }));
  // Only templates of this role are offered.
  const select = await dialog.findByLabelText("Template");
  expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(["None", "review-worker · project"]);
  await user.selectOptions(select, "review-worker");
  expect(dialog.queryByLabelText("Profile")).not.toBeInTheDocument();
  await user.type(dialog.getByLabelText("Title"), "Review accessibility");
  await user.type(dialog.getByLabelText("Task"), "Review keyboard navigation.");
  await user.click(dialog.getByRole("button", { name: "Create thread" }));

  await waitFor(() => expect(start.posted).toEqual([{ project: "nenu", role: "worker", title: "Review accessibility", parent: "root", task: "Review keyboard navigation.", template: "review-worker" }]));
});

it("offers only a top-level thread when upstream herdr-projects runs the project", async () => {
  serveOptions({ profiles: [] });
  const { user } = renderActions({ ...project, nodeActions: false });

  await user.click(await screen.findByRole("button", { name: "New thread" }));
  expect(screen.queryByRole("button", { name: "New coordinator" })).not.toBeInTheDocument();
  const dialog = within(await screen.findByRole("dialog", { name: "New thread" }));
  expect(dialog.queryByLabelText("Parent")).not.toBeInTheDocument();
  await waitFor(() => expect(dialog.getByLabelText("Profile")).toBeEnabled());
  expect(within(dialog.getByLabelText("Profile")).getAllByRole("option").map((option) => option.textContent)).toEqual(["Project default"]);
});

it("offers nothing to start in a paused project, which Organizations would refuse", () => {
  const { container } = render(<NewNodeActions project={{ ...project, status: "paused" }} onStarted={() => {}} />);
  expect(container).toBeEmptyDOMElement();
});

it("opens the project a thread went to when the person picked another one", async () => {
  serveOptions();
  const start = recordStart();
  const api: ProjectView = { slug: "api", name: "API", status: "active", nodeActions: true, threads: [] };
  const { user, onStarted, router } = renderActions(project, { others: [api] });

  await user.click(await screen.findByRole("button", { name: "New thread" }));
  const dialog = within(await screen.findByRole("dialog", { name: "New thread" }));
  await user.selectOptions(dialog.getByLabelText("Project"), "api");
  await user.type(dialog.getByLabelText("Title"), "Docs");
  await user.type(dialog.getByLabelText("Task"), "Write the docs.");
  await user.click(dialog.getByRole("button", { name: "Create thread" }));

  await waitFor(() => expect(router.state.location.pathname).toBe("/project/api"));
  expect(start.posted).toEqual([{ project: "api", role: "worker", title: "Docs", parent: "root", task: "Write the docs." }]);
  expect(onStarted).not.toHaveBeenCalled();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("titles the flow by what the chosen project can start", async () => {
  serveOptions();
  const api: ProjectView = { slug: "api", name: "API", status: "active", nodeActions: false, threads: [] };
  const { user } = renderActions(project, { others: [api] });

  await user.click(await screen.findByRole("button", { name: "New coordinator" }));
  await user.selectOptions(within(await screen.findByRole("dialog", { name: "New coordinator" })).getByLabelText("Project"), "api");
  const dialog = within(screen.getByRole("dialog", { name: "New thread" }));
  expect(dialog.getByRole("button", { name: "Create thread" })).toBeInTheDocument();
});

it("lets a start the person dismissed land without closing or moving what they opened next", async () => {
  serveOptions();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  server.use(http.post("/api/org/node/start", async () => { await held; return HttpResponse.json({ ok: true, node: { id: "t-4000" } }); }));
  const onStarted = vi.fn();
  const { user, loads, router } = renderActions(project, { onStarted });

  await user.click(await screen.findByRole("button", { name: "New thread" }));
  const dialog = within(await screen.findByRole("dialog", { name: "New thread" }));
  await user.type(dialog.getByLabelText("Title"), "Billing");
  await user.type(dialog.getByLabelText("Task"), "Coordinate billing.");
  await user.click(dialog.getByRole("button", { name: "Create thread" }));
  await dialog.findByRole("button", { name: "Starting…" });
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  act(() => openNewDialog());
  expect(await screen.findByRole("dialog", { name: "New" })).toBeInTheDocument();

  // The late answer still lands: something refreshes the page.
  const before = loads() + onStarted.mock.calls.length;
  release();
  await waitFor(() => expect(loads() + onStarted.mock.calls.length).toBeGreaterThan(before));
  expect(screen.getByRole("dialog", { name: "New" })).toBeInTheDocument();
  expect(router.state.location.pathname).toBe("/project/nenu");
});

it("keeps the dialog open with Organizations' refusal", async () => {
  serveOptions();
  server.use(http.post("/api/org/node/start", () => HttpResponse.json({ ok: false, error: "there is no profile `codex` allowed for coordinators" }, { status: 502 })));
  const { user } = renderActions(project);

  await user.click(await screen.findByRole("button", { name: "New coordinator" }));
  const dialog = within(await screen.findByRole("dialog", { name: "New coordinator" }));
  await user.type(dialog.getByLabelText("Title"), "Billing");
  await user.type(dialog.getByLabelText("Task"), "Coordinate billing.");
  await user.click(dialog.getByRole("button", { name: "Create coordinator" }));

  expect(await dialog.findByRole("alert")).toHaveTextContent("there is no profile `codex` allowed for coordinators");
  expect(dialog.getByLabelText("Title")).toHaveValue("Billing");
});
