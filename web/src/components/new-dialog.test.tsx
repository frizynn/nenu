import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { onTestFinished } from "vitest";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { ProjectView, TemplateView } from "@/lib/types";
import { server } from "@/test/setup";
import NewDialog, { newContext, projectCommand } from "./new-dialog";
import type { NewRequest } from "./new-agent-sheet";

const HOME = "/home/me";
const project: ProjectView = {
  slug: "awam",
  name: "AWAM",
  status: "active",
  workspaceIds: ["w:2"],
  threads: [{ id: "t-1", title: "Coordinator", parentId: "root", role: "coordinator", status: "open" }],
};
const template: TemplateView = {
  name: "worker", scope: "project", description: "", role: "worker", canSpawn: false,
  harness: "codex", model: "", reasoningEffort: "", rulesChars: 0, memoryChars: 0, updated: "",
};
const base: HomeData = {
  bridge: "connected", device: undefined, session: "work", sessions: [],
  error: false, authError: false, snoozedUntil: null, update: undefined, tabs: [], shellPanes: [],
  workspaces: [
    { workspaceId: "w:1", number: 1, label: "Nenu", focused: true, activeTabId: "t1", tabCount: 1, paneCount: 1 },
    { workspaceId: "w:2", number: 2, label: "rediseño mobile", focused: false, activeTabId: "t2", tabCount: 1, paneCount: 1 },
  ],
  agents: [
    { paneId: "w:2:p1", workspaceId: "w:2", workspaceLabel: "rediseño mobile", workspaceNumber: 2, tabId: "t2", agent: "codex", status: "idle", cwd: `${HOME}/code/awam`, focused: true },
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
    http.get("/api/org/templates", () => HttpResponse.json({ ok: true, templates: [template] })),
    record("/api/tab", { ok: true, pane }),
    record("/api/workspace", { ok: true, pane }),
    record("/api/pane/:paneId/start", { ok: true }),
    record("/api/org/project/create", { ok: true, project: { slug: "panel-mayorista", name: "Panel mayorista" } }),
    record("/api/org/node/start", { ok: true, node: { id: "t-2", parentId: "root", role: "worker", template: "worker" } }),
  );
});

function setup({ data = base, entry = "/pane/w%3A2%3Ap1?s=work", request = {} }: { data?: HomeData; entry?: string; request?: NewRequest } = {}) {
  const onClose = vi.fn();
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID,
    path: "/",
    loader: () => data,
    element: <><NewDialog request={request} onClose={onClose} /><Outlet /></>,
    children: [
      { path: "pane/:paneId", element: <p>Pane page</p> },
      { path: "project/:projectSlug", element: <p>Project page</p> },
    ],
  }], { initialEntries: [entry] });
  render(<RouterProvider router={router} />);
  return { router, onClose, user: userEvent.setup() };
}

function desktop() {
  const matchMedia = window.matchMedia;
  window.matchMedia = (query) => ({ matches: query === "(min-width: 1024px)", media: query }) as MediaQueryList;
  onTestFinished(() => { window.matchMedia = matchMedia; });
}

it("offers the five kinds on a phone, in the place on screen", async () => {
  setup();
  const create = within(await screen.findByRole("navigation", { name: "Create" }));
  expect(create.getAllByRole("button").map((b) => b.querySelector("span span")?.textContent)).toEqual(["Thread", "Tab", "Workspace", "Project", "Quick chat"]);
  expect(create.getByLabelText("In")).toHaveValue("w:2");
  expect(create.getByText("AWAM › rediseño mobile", { selector: "span" })).toBeInTheDocument();
});

it("opens a tab with the chosen agent in the workspace on screen, then opens its pane", async () => {
  const { user, router, onClose } = setup();
  await user.click(await screen.findByRole("button", { name: /^Tab/ }));
  expect(screen.getByLabelText("Workspace")).toHaveValue("w:2");
  await user.click(screen.getByRole("radio", { name: "Codex" }));
  await user.click(screen.getByRole("button", { name: "Start Codex" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts["/api/tab"]).toEqual([{ workspaceId: "w:2", cwd: `${HOME}/code/awam` }]);
  expect(router.state.location.pathname).toBe("/pane/w%3A9%3Ap1");
  await waitFor(() => expect(posts["/api/pane/:paneId/start"]).toEqual([{ agent: "codex", permission: "ask" }]));
});

it("creates a project with the exact command it previews and opens it", async () => {
  const { user, router, onClose } = setup({ request: { kind: "project" } });
  await user.type(await screen.findByLabelText("Name"), "Panel mayorista");
  await user.type(screen.getByLabelText("Goal"), "Stock by depot");
  expect(screen.getByLabelText("Command")).toHaveTextContent("herdr-organizations new --goal='Stock by depot' --json -- 'Panel mayorista'");
  await user.click(screen.getByRole("button", { name: "Create project" }));
  await waitFor(() => expect(onClose).toHaveBeenCalled());
  expect(posts["/api/org/project/create"]).toEqual([{ name: "Panel mayorista", goal: "Stock by depot" }]);
  expect(router.state.location.pathname).toBe("/project/panel-mayorista");
});

it("starts a thread in the project on screen, straight away on a desk", async () => {
  desktop();
  const { user, router } = setup();
  expect(await screen.findByRole("heading", { name: "New thread" })).toBeInTheDocument();
  expect(await screen.findByLabelText("Title")).toHaveValue("worker");
  await user.clear(screen.getByLabelText("Title"));
  await user.type(screen.getByLabelText("Title"), "Filters");
  await user.selectOptions(screen.getByLabelText("Parent"), "t-1");
  await user.type(screen.getByLabelText("Task"), "Add a depot filter.");
  await user.click(screen.getByRole("button", { name: "Start thread" }));
  await waitFor(() => expect(router.state.location.pathname).toBe("/project/awam"));
  expect(posts["/api/org/node/start"]).toEqual([{ project: "awam", template: "worker", title: "Filters", parent: "t-1", task: "Add a depot filter." }]);
});

it("makes the scratch workspace on ~ for the first quick chat, then reuses it", async () => {
  const first = setup({ request: { kind: "chat" } });
  await first.user.type(await screen.findByLabelText("Message"), "what is 2+2");
  await waitFor(() => expect(screen.getByRole("button", { name: "Start chat" })).toBeEnabled());
  await first.user.click(screen.getByRole("button", { name: "Start chat" }));
  await waitFor(() => expect(posts["/api/workspace"]).toEqual([{ label: "scratch", cwd: HOME }]));
  first.router.dispose();
  document.body.innerHTML = "";

  const scratch = { workspaceId: "w:5", number: 5, label: "scratch", focused: false, activeTabId: "t5", tabCount: 1, paneCount: 1 };
  const second = setup({ data: { ...base, workspaces: [...base.workspaces, scratch] }, request: { kind: "chat" } });
  expect(await screen.findByText(/Opens in the/)).toHaveTextContent("Opens in the scratch workspace on ~.");
  await second.user.click(screen.getByRole("button", { name: "Start chat" }));
  await waitFor(() => expect(posts["/api/tab"]).toEqual([{ workspaceId: "w:5", cwd: HOME }]));
});

it("points a thread at a new project when there is none", async () => {
  const { user } = setup({ data: { ...base, projects: [] }, request: { kind: "thread" } });
  await user.click(await screen.findByRole("button", { name: "New project" }));
  expect(screen.getByRole("heading", { name: "New project" })).toBeInTheDocument();
});

it("creates nothing from a read-only device", async () => {
  setup({ data: { ...base, device: { enforced: true, authorized: false } as HomeData["device"] }, request: { kind: "project" } });
  await userEvent.setup().type(await screen.findByLabelText("Name"), "x");
  expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
});

describe("projectCommand", () => {
  it("quotes what a shell would split and leaves plain words bare", () => {
    expect(projectCommand("api", "", "/home/me/code/api")).toBe("herdr-organizations new --repo=/home/me/code/api --json -- api");
    expect(projectCommand("it's", "a b", "")).toBe(`herdr-organizations new --goal='a b' --json -- 'it'\\''s'`);
  });
});

describe("newContext", () => {
  it("takes the workspace and project of the pane, space or project on screen", () => {
    expect(newContext(base, { paneId: "w:2:p1" })).toEqual({ workspaceId: "w:2", project: "awam" });
    expect(newContext(base, { spaceId: "w:1" })).toEqual({ workspaceId: "w:1", project: "awam" });
    expect(newContext(base, { projectSlug: "awam" })).toEqual({ workspaceId: "w:2", project: "awam" });
  });
});
