import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { HomeRoute } from "./home";
import { WorkbenchShell } from "@/components/workbench-shell";
import type { Interaction } from "@/lib/types";
import type { ActivityResponse } from "@/lib/activity";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { ProjectView } from "@/lib/types";
import { server } from "@/test/setup";

vi.mock("@/components/update-banner", () => ({ UpdateBanner: () => null }));
const newSpace = vi.fn();
vi.mock("@/hooks/use-spaces", () => ({ useSpaceActions: () => ({ newSpace }) }));
const openNewAgent = vi.fn();
vi.mock("@/lib/spawn", async (original) => ({ ...(await original<typeof import("@/lib/spawn")>()), openNewAgent: (target: unknown) => openNewAgent(target) }));

beforeEach(() => localStorage.clear());

const data: HomeData = {
  bridge: "connected", device: undefined, session: "work", sessions: [], error: false, authError: false,
  snoozedUntil: null, update: undefined, tabs: [], shellPanes: [],
  workspaces: [{ workspaceId: "w1", number: 1, label: "Nenu", focused: true, activeTabId: "t1", tabCount: 1, paneCount: 2 }],
  agents: [
    { paneId: "w1:p1", workspaceId: "w1", workspaceLabel: "Nenu", workspaceNumber: 1, tabId: "t1", agent: "codex", status: "idle", cwd: "/dev/collie", focused: false, paneLabel: "Earlier thread" },
    { paneId: "w1:p2", workspaceId: "w1", workspaceLabel: "Nenu", workspaceNumber: 1, tabId: "t1", agent: "claude", status: "blocked", cwd: "/dev/collie", focused: true, paneLabel: "Review changes" },
  ],
};

const permission: Interaction = {
  paneId: "w1:p2", agent: "claude", signature: "sig-1", revision: 1, detectedAt: 1,
  kind: "permission", family: "permission", question: "Do you want to proceed?", context: "Bash command\nbun run test",
  options: [{ index: 0, label: "Yes", role: "primary" }, { index: 1, label: "No", role: "deny" }],
  detailComplete: true,
};

const hub: ProjectView = {
  slug: "hub", name: "Hub", status: "active", source: "json", workspaceIds: ["w2"],
  coordinator: { paneId: "c1", agent: "codex", liveStatus: "idle" },
  threads: [
    { id: "t1", title: "Coordinator", parentId: "root", role: "coordinator", status: "open", paneId: "c1", liveStatus: "idle", group: "idle" },
    { id: "t2", title: "Mobile panel", parentId: "t1", role: "worker", status: "open", paneId: "w2:p2", liveStatus: "done", group: "ready-for-review",
      pr: { state: "open", number: 1342, review: "approved", diff: { additions: 212, deletions: 148 }, checks: { passed: 4, failed: 0, pending: 0 }, mergeBlocker: null } },
    { id: "t3", title: "Landing", parentId: "t1", role: "worker", status: "open", paneId: "w2:p3", liveStatus: "working", group: "working" },
  ],
};
const projectData: HomeData = {
  ...data,
  workspaces: [...data.workspaces, { workspaceId: "w2", number: 2, label: "hub", focused: false, activeTabId: "t2", tabCount: 3, paneCount: 3 }],
  agents: [
    ...data.agents,
    { ...data.agents[0]!, paneId: "c1", workspaceId: "w2", workspaceLabel: "hub", paneLabel: "Coordinator" },
    { ...data.agents[0]!, paneId: "w2:p2", workspaceId: "w2", workspaceLabel: "hub", status: "done", paneLabel: "Mobile panel" },
    { ...data.agents[0]!, paneId: "w2:p3", workspaceId: "w2", workspaceLabel: "hub", status: "working", paneLabel: "Landing" },
  ],
  projects: [hub],
};

async function setup(value = data) {
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, loader: () => value, element: <WorkbenchShell data={value}><Outlet /></WorkbenchShell>, children: [
    { path: "/", element: <HomeRoute /> },
    { path: "/space/:spaceId", element: <p>Workspace opened</p> },
    { path: "/pane/:paneId", element: <p>Pane opened</p> },
    { path: "/project/:projectSlug", element: <p>Project page</p> },
  ] }], { initialEntries: ["/?s=work"] });
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { level: 1 });
  return { router, user: userEvent.setup(), main: within(document.querySelector("main")!) };
}

const headline = () => screen.getByRole("heading", { level: 1 }).querySelector(".max-sm\\:hidden")?.textContent;

it("answers a dialog in place from Needs you", async () => {
  const answers: unknown[] = [];
  let pending = [permission];
  server.use(
    http.get("/api/interactions", () => HttpResponse.json({ interactions: pending })),
    http.post("/api/interactions/:pane/answer", async ({ request, params }) => {
      answers.push({ pane: params.pane, body: await request.json() });
      pending = [];
      return HttpResponse.json({ ok: true });
    }),
  );
  const { user, main } = await setup();
  const needs = within(await main.findByRole("region", { name: /^Needs you/ }));
  expect(await needs.findByText("Do you want to proceed?")).toBeInTheDocument();
  expect(needs.getByText(/Review changes · Nenu/)).toBeInTheDocument();
  expect(headline()).toBe("1 thread needs you");
  await user.click(needs.getByRole("button", { name: "Yes" }));
  expect(answers).toEqual([{ pane: "w1:p2", body: { signature: "sig-1", optionIndex: 0 } }]);
  expect(await needs.findByText("Answered: Yes")).toBeInTheDocument();
});

it("offers a blocked pane with no readable dialog as a row into its thread", async () => {
  const { user, router, main } = await setup();
  const needs = within(main.getByRole("region", { name: /^Needs you/ }));
  await user.click(needs.getByRole("link", { name: /Review changes.*waiting in the terminal/ }));
  expect(router.state.location.pathname).toBe("/pane/w1%3Ap2");
});

it("opens the shared new-agent flow from the composer, carrying what was typed", async () => {
  const { user, main } = await setup({ ...data, agents: [], workspaces: [] });
  expect(screen.getByRole("heading", { level: 1, name: "What should we work on?" })).toBeInTheDocument();
  expect(screen.getByText(/Describe a task to start your first agent/)).toBeInTheDocument();
  await user.click(main.getByRole("button", { name: "New chat" }));
  expect(openNewAgent).toHaveBeenLastCalledWith({ kind: "workspace" });
  await user.type(main.getByRole("textbox", { name: "First message for a new chat" }), "Audit the auth flow{Enter}");
  expect(openNewAgent).toHaveBeenLastCalledWith({ kind: "workspace", message: "Audit the auth flow" });
  expect(main.getByRole("textbox", { name: "First message for a new chat" })).toHaveValue("");
});

it("starts a thread in a chosen workspace", async () => {
  const { user, main } = await setup();
  await user.selectOptions(main.getByRole("combobox", { name: "Send to" }), "workspace:w1");
  await user.type(main.getByRole("textbox", { name: "First message for a new chat" }), "Fix the flaky test{Enter}");
  expect(openNewAgent).toHaveBeenLastCalledWith({ kind: "tab", workspaceId: "w1", message: "Fix the flaky test" });
});

describe("a project's coordinator", () => {
  function queue(rows: (body: Record<string, unknown>) => unknown[] = () => []) {
    const posts: Array<Record<string, unknown>> = [];
    server.use(
      http.get("/api/pane/:pane/queue", () => HttpResponse.json({ available: true, scope: "s1", messages: [] })),
      http.post("/api/pane/:pane/queue", async ({ request, params }) => {
        const body = await request.json() as Record<string, unknown>;
        posts.push({ pane: params.pane, ...body });
        return HttpResponse.json({ available: true, scope: "s1", messages: rows(body) });
      }),
    );
    return posts;
  }

  it("is the default target, and a free one gets the message at once", async () => {
    const posts = queue();
    const { user, main } = await setup(projectData);
    await user.type(main.getByRole("textbox", { name: "Message for Hub's coordinator" }), "Start phase two{Enter}");
    expect(await main.findByText("Sent to Hub's coordinator.")).toBeInTheDocument();
    expect(posts).toEqual([expect.objectContaining({ pane: "c1", scope: "s1", action: "add", text: "Start phase two", deliveryMode: "asap" })]);
  });

  it("asks whether to steer or queue while it works", async () => {
    const posts = queue((body) => [{ id: body.id, text: body.text, state: "queued", createdAt: 1, revision: 1, deliveryMode: body.deliveryMode }]);
    const working = { ...projectData, agents: projectData.agents.map((a) => a.paneId === "c1" ? { ...a, status: "working" as const } : a) };
    const { user, main } = await setup(working);
    await user.type(main.getByRole("textbox", { name: "Message for Hub's coordinator" }), "Also the landing{Enter}");
    expect(posts).toEqual([]);
    await user.click(main.getByRole("button", { name: "Queue for later" }));
    expect(await main.findByText("Queued for Hub's coordinator.")).toBeInTheDocument();
    expect(posts).toEqual([expect.objectContaining({ pane: "c1", deliveryMode: "afterTurn" })]);
  });
});

it("lists pull requests ready to review with their diff and checks, and the project's state", async () => {
  const { user, router, main } = await setup(projectData);
  expect(headline()).toBe("1 thread needs you, 1 is ready to review");
  const review = within(main.getByRole("region", { name: /^Ready to review/ }));
  expect(review.getByText("Mobile panel")).toBeInTheDocument();
  expect(review.getByText("#1342")).toBeInTheDocument();
  expect(review.getByText("+212")).toBeInTheDocument();
  expect(review.getByText("checks")).toBeInTheDocument();
  const projects = within(main.getByRole("region", { name: /^Projects/ }));
  const card = projects.getByRole("link", { name: /Hub/ });
  expect(card).toHaveTextContent("1 coordinator · 3 threads · 1 to review");
  expect(within(card).getByRole("img")).toHaveAccessibleName("1 working, 1 to review, 1 idle");
  // The project's own workspace is not repeated under Workspaces.
  const workspaces = within(main.getByRole("region", { name: /^Workspaces/ }));
  expect(workspaces.queryByText("hub")).not.toBeInTheDocument();
  expect(workspaces.getByRole("link", { name: /^Earlier thread, idle/ })).toHaveAttribute("href", "/pane/w1%3Ap1?s=work");
  await user.click(review.getByRole("link", { name: "Review Mobile panel" }));
  expect(router.state.location.pathname).toBe("/pane/w2%3Ap2");
});

it("announces a workflow that finished since its thread was opened", async () => {
  const now = Date.now();
  const activity: ActivityResponse = {
    available: true, sessionKey: "s", truncated: false, artifacts: [], tasks: [],
    workflows: [{ runId: "r1", name: "org-tui-design", status: "completed", updatedAt: now - 60_000, durationMs: 1_418_000, phases: [], agentCount: 4, doneCount: 4 }],
  };
  server.use(http.get("/api/pane/:pane/activity", ({ params }) => HttpResponse.json(params.pane === "w1:p2" ? activity : { available: false, reason: "no-session" })));
  const agents = data.agents.map((a) => a.paneId === "w1:p2" ? { ...a, status: "idle" as const, hasSession: true, lastSeenAt: now - 3_600_000 } : a);
  const { main } = await setup({ ...data, agents });
  const review = within(await main.findByRole("region", { name: /^Ready to review/ }));
  expect(review.getByText("Workflow finished: org-tui-design")).toBeInTheDocument();
  expect(review.getByText("Nenu · 4 agents · 23m 38s")).toBeInTheDocument();
  expect(review.getByRole("link", { name: "View result of org-tui-design" })).toHaveAttribute("href", "/pane/w1%3Ap2?s=work");
});

it("jumps with ⌘K and Enter to the first matching chat", async () => {
  const { user, router, main } = await setup();
  const jump = main.getByRole("searchbox", { name: "Jump to a project or chat" });
  expect(jump).toHaveAttribute("aria-keyshortcuts", "Meta+K");
  await user.keyboard("{Meta>}k{/Meta}");
  expect(jump).toHaveFocus();
  await user.type(jump, "review{Enter}");
  expect(router.state.location.pathname).toBe("/pane/w1%3Ap2");
});

it("does not claim an empty live herd or allow creation from stale disconnected data", async () => {
  const { main } = await setup({ ...data, error: true, agents: [], workspaces: [] });
  expect(screen.getByText(/Showing your last workspace snapshot/)).toBeInTheDocument();
  expect(main.getByRole("button", { name: "New chat" })).toBeDisabled();
  expect(main.getByRole("textbox", { name: "First message for a new chat" })).toBeDisabled();
  expect(screen.queryByText(/Describe a task to start your first agent/)).not.toBeInTheDocument();
});

it("keeps existing threads navigable while answering and creating are read-only", async () => {
  server.use(http.get("/api/interactions", () => HttpResponse.json({ interactions: [permission] })));
  const { main } = await setup({ ...data, device: { enforced: true, device: "phone", authorized: false } });
  expect(main.getByRole("button", { name: "New chat" })).toBeDisabled();
  const needs = within(main.getByRole("region", { name: /^Needs you/ }));
  expect(await needs.findByRole("button", { name: "Yes" })).toBeDisabled();
  expect(needs.getByRole("button", { name: "Open" })).toBeEnabled();
  const workspaces = within(main.getByRole("region", { name: /^Workspaces/ }));
  expect(workspaces.getByRole("link", { name: /^Review changes, needs you/ })).toHaveAttribute("href", "/pane/w1%3Ap2?s=work");
});
