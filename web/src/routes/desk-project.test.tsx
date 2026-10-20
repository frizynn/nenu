import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { AgentView, ProjectThreadView, ProjectView } from "@/lib/types";
import { server } from "@/test/setup";
import { __forgetSummaries } from "@/hooks/use-thread-summaries";
import { AsksRoute } from "./asks";
import { NodeRoute } from "./node";
import { ProjectRoute } from "./project";
import { RoutinesRoute } from "./routines";

// A desk's project and coordinator pages (ADR 0102): tabs in the address, a card per coordinator, what
// waits on you by coordinator, routines that turn on and off, and the old pages landing there.

vi.mock("@/hooks/use-media-query", () => ({ useMediaQuery: (query: string) => query === "(min-width: 1024px)" }));

const node = (id: string, title: string, parentId: string, extra: Partial<ProjectThreadView> = {}): ProjectThreadView =>
  ({ id, title, parentId, role: "worker", status: "open", ...extra });
const pane = (paneId: string): AgentView => ({ paneId, workspaceId: "w", workspaceLabel: "w", workspaceNumber: 1, tabId: "t", agent: "claude", status: "idle", cwd: "/", focused: false });

const threads: ProjectThreadView[] = [
  node("t-3", "Lead", "root", { role: "coordinator", paneId: "lead", liveStatus: "idle" }),
  node("t-4", "Docs", "t-3", { group: "working", pr: { state: "open", number: 58 } }),
  node("t-7", "Hotfix", "root", { group: "idle" }),
  node("t-8", "Shipped", "t-3", { status: "resolved" }),
];
const project: ProjectView = { slug: "hub", name: "Hub", goal: "Ship it", status: "active", source: "json", nodeActions: true, waitingAsks: 1, threads };
const data: HomeData = {
  bridge: "connected", agents: [pane("lead")], shellPanes: [], workspaces: [], tabs: [], projects: [project], device: undefined,
  sessions: [], session: undefined, snoozedUntil: null, update: undefined, error: false, authError: false,
};
const prRoutine = { name: "pr-followup", trigger: "pr", to: "", parent: "", prompt: "Fix the checks.", schedule: "", events: ["checks-failed"], enabled: true, lastRun: "", nextRun: "" };
const leadRoutine = { ...prRoutine, name: "lead-daily", trigger: "schedule", to: "node:Lead", schedule: "daily 09:00", events: [] };

let toggled: unknown[] = [];
let edited: unknown[] = [];
beforeEach(() => {
  toggled = [];
  edited = [];
  __forgetSummaries();
  server.use(
    http.get("/api/org/summary", () => HttpResponse.json({ ok: true, coordinator: null, usage: null, status: null, threads: [] })),
    http.get("/api/org/asks", () => HttpResponse.json({ ok: true, answers: true, decisions: [], asks: [
      { project: "hub", coordinator: { id: "t-3", title: "Lead" }, line: 4, text: "Which plan?", answer: "", links: [], group: "waiting", state: "needs-decision", answerable: true },
    ] })),
    http.get("/api/org/routines", () => HttpResponse.json({ ok: true, available: true, editable: true, broken: 0, routines: [prRoutine, leadRoutine] })),
    http.post("/api/org/routine/set", async ({ request }) => {
      const body = await request.json() as { name: string; prompt?: string; to?: string };
      edited.push(body);
      return HttpResponse.json({ ok: true, routines: { available: true, editable: true, broken: 0, routines: [{ ...prRoutine, prompt: body.prompt ?? prRoutine.prompt, to: body.to ?? "" }, leadRoutine] } });
    }),
    http.post("/api/org/routine/toggle", async ({ request }) => {
      const body = await request.json() as { name: string; on: boolean };
      toggled.push(body);
      return HttpResponse.json({ ok: true, routines: { available: true, broken: 0, routines: [{ ...prRoutine, enabled: body.on }, leadRoutine] } });
    }),
  );
});

function setup(path: string) {
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID, path: "/", loader: () => data, element: <Outlet />,
    children: [
      { path: "projects", element: <p>PROJECTS</p> },
      { path: "asks", element: <AsksRoute /> },
      { path: "routines", element: <RoutinesRoute /> },
      { path: "project/:projectSlug", element: <ProjectRoute /> },
      { path: "project/:projectSlug/node/:nodeId", element: <NodeRoute /> },
      { path: "pane/:paneId", element: <p>PANE</p> },
    ],
  }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return { router, user: userEvent.setup() };
}

describe("a desk's project page", () => {
  it("is the project's own page, never its coordinator's chat, with a card per coordinator and the project coordinator's last", async () => {
    const { router } = setup("/project/hub");
    expect(within(await screen.findByRole("main")).getByRole("heading", { level: 1, name: /Hub/ })).toBeInTheDocument();
    const cards = within(screen.getByRole("tabpanel")).getAllByRole("region").map((region) => region.getAttribute("aria-label"));
    expect(cards).toEqual(["Lead", "Project coordinator"]);
    const lead = within(screen.getByRole("region", { name: "Lead" }));
    expect(await lead.findByText("1 waiting on you")).toBeInTheDocument();
    expect(lead.getByRole("button", { name: /Docs/ })).toHaveTextContent("#58");
    expect(within(screen.getByRole("region", { name: "Project coordinator" })).getByRole("button", { name: /Hotfix/ })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe("/project/hub");
  });

  it("keeps finished work in History, one step away, by day and searched by who ran it", async () => {
    const { user, router } = setup("/project/hub");
    await user.click(await screen.findByRole("button", { name: /History\s*1/ }));
    expect(router.state.location.search).toBe("?work=finished");
    expect(await screen.findByRole("button", { name: /Shipped\s*Lead/ })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: "Lead" })).toBeNull();
    await user.type(screen.getByRole("searchbox", { name: "Search finished work" }), "nothing like it");
    expect(await screen.findByText("Nothing finished matches.")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open work" }));
    expect(router.state.location.search).toBe("");
  });

  it("lists what waits on you by coordinator, with Answer in place", async () => {
    const { user } = setup("/project/hub");
    await user.click(await screen.findByRole("tab", { name: /Waiting on you/ }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Waiting on you/ })).toHaveAttribute("aria-selected", "true"));
    const lead = within(await screen.findByRole("region", { name: "Lead" }));
    await lead.findByText("Which plan?");
    expect(lead.getByText("Which plan?")).toBeInTheDocument();
    expect(lead.getByRole("button", { name: "Answer Which plan?" })).toBeInTheDocument();
    expect(lead.getByRole("link", { name: /Open coordinator/ })).toHaveAttribute("href", "/project/hub/node/t-3");
  });

  it("opens the first routine beside the list, another on a tap, says whom it reaches, and turns it off through Organizations", async () => {
    const { user, router } = setup("/project/hub?tab=routines");
    expect(await screen.findByRole("complementary", { name: "Routine pr-followup" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /lead-daily/ }));
    expect(router.state.location.search).toBe("?tab=routines&routine=lead-daily");
    await user.click(within(await screen.findByRole("complementary", { name: "Routine lead-daily" })).getByRole("button", { name: "Close routine" }));
    expect(router.state.location.search).toBe("?tab=routines&routine=");
    expect(screen.queryByRole("complementary")).toBeNull();
    await user.click(screen.getByRole("button", { name: /pr-followup/ }));
    const detail = within(await screen.findByRole("complementary", { name: "Routine pr-followup" }));
    expect(detail.getByText("The thread that owns the pull request")).toBeInTheDocument();
    expect(detail.getByText("Fix the checks.")).toBeInTheDocument();
    await user.click(screen.getByRole("switch", { name: "pr-followup on" }));
    await waitFor(() => expect(screen.getByRole("switch", { name: "pr-followup on" })).toHaveAttribute("aria-checked", "false"));
    expect(toggled).toEqual([{ project: "hub", name: "pr-followup", on: false }]);
  });

  it("edits a routine where Organizations can, sending only what changed", async () => {
    const { user } = setup("/project/hub?tab=routines&routine=pr-followup");
    const detail = within(await screen.findByRole("complementary", { name: "Routine pr-followup" }));
    await user.click(detail.getByRole("button", { name: "Edit" }));
    const form = within(detail.getByRole("form", { name: "Edit pr-followup" }));
    expect(form.getByRole("button", { name: "Save" })).toBeDisabled();
    expect(form.getByRole("checkbox", { name: "Checks fail" })).toHaveAttribute("aria-checked", "true");
    await user.selectOptions(form.getByLabelText("Goes to"), "node:t-3");
    const prompt = form.getByLabelText("What it asks");
    await user.clear(prompt);
    await user.type(prompt, "Fix them now.");
    await user.click(form.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(edited).toEqual([{ project: "hub", name: "pr-followup", to: "node:t-3", prompt: "Fix them now." }]));
    expect(await detail.findByText("Fix them now.")).toBeInTheDocument();
    expect(detail.getByText("Lead")).toBeInTheDocument();
  });

  it("offers no Edit to a read-only device or where Organizations cannot edit", async () => {
    server.use(http.get("/api/org/routines", () => HttpResponse.json({ ok: true, available: true, editable: false, broken: 0, routines: [prRoutine] })));
    setup("/project/hub?tab=routines&routine=pr-followup");
    const detail = within(await screen.findByRole("complementary", { name: "Routine pr-followup" }));
    expect(detail.queryByRole("button", { name: "Edit" })).toBeNull();
  });
});

describe("a desk's coordinator page", () => {
  it("has its tabs, and Routines lists only what reaches it", async () => {
    const { user } = setup("/project/hub/node/t-3");
    expect(within(await screen.findByRole("main")).getByRole("heading", { level: 1, name: "Lead" })).toBeInTheDocument();
    const tabs = () => within(screen.getByRole("tablist", { name: "Lead" })).getAllByRole("tab").map((tab) => tab.textContent);
    await waitFor(() => expect(tabs()).toEqual(["Threads1", "Waiting on you1", "Routines1", "Status"]));
    expect(screen.getByRole("button", { name: /1 decision waits on you/ })).toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /Routines/ }));
    await waitFor(() => expect(screen.getByRole("tab", { name: /Routines/ })).toHaveAttribute("aria-selected", "true"));
    expect(await screen.findByRole("button", { name: /lead-daily/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pr-followup/ })).toBeNull();
  });
});

describe("the old pages on a desk", () => {
  it("send Your asks to the project's or coordinator's Waiting on you, and Routines to Projects", async () => {
    const asks = setup("/asks?project=hub&coordinator=t-3").router;
    await waitFor(() => expect(asks.state.location.pathname + asks.state.location.search).toBe("/project/hub/node/t-3?tab=waiting"));
    const routines = setup("/routines").router;
    await waitFor(() => expect(routines.state.location.pathname).toBe("/projects"));
  });
});
