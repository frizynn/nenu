import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { HomeRoute } from "./home";
import { WorkbenchShell } from "@/components/workbench-shell";
import type { ActivityResponse } from "@/lib/activity";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { Interaction, ProjectView, PullRequestView } from "@/lib/types";
import { server } from "@/test/setup";

vi.mock("@/components/update-banner", () => ({ UpdateBanner: () => null }));
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

it("lists pull requests ready to review with their diff and checks", async () => {
  const { user, router, main } = await setup(projectData);
  expect(headline()).toBe("1 thread needs you, 1 is ready to review");
  const review = within(main.getByRole("region", { name: /^Ready to review/ }));
  expect(review.getByText("Mobile panel")).toBeInTheDocument();
  expect(review.getByText("#1342")).toBeInTheDocument();
  // The diff sits in its own column on a desk and under the title on a phone.
  expect(review.getAllByText("+212")).toHaveLength(2);
  expect(review.getByText("checks")).toBeInTheDocument();
  await user.click(review.getByRole("link", { name: "Review Mobile panel" }));
  expect(router.state.location.pathname).toBe("/pane/w2%3Ap2");
});

describe("Recent", () => {
  const now = Date.now();
  const recentData: HomeData = {
    ...projectData,
    agents: projectData.agents.map((agent) => ({
      "w1:p1": { ...agent, tabLabel: "docs", lastActiveAt: now - 3 * 3_600_000 },
      "w1:p2": { ...agent, lastActiveAt: now - 60_000 },
      c1: { ...agent, lastActiveAt: now - 2 * 3_600_000 },
      "w2:p2": { ...agent, lastActiveAt: now - 5 * 60_000, lastSeenAt: now - 3_600_000 },
      "w2:p3": { ...agent, lastActiveAt: now - 20 * 60_000 },
    } as Record<string, typeof agent>)[agent.paneId] ?? agent),
  };

  it("lists the chats that moved last, each with its state and place, and opens one in a tap", async () => {
    const { user, router, main } = await setup(recentData);
    const recent = within(main.getByRole("region", { name: /^Recent/ }));
    // "Review changes" is waiting on you, so Needs you shows it and Recent does not.
    expect(recent.getAllByRole("link").map((link) => link.getAttribute("href")))
      .toEqual(["/pane/w2%3Ap2?s=work", "/pane/w2%3Ap3?s=work", "/pane/c1?s=work", "/pane/w1%3Ap1?s=work"]);
    // Each row reads as one sentence: title, "New", state, place, tab, how long ago.
    for (const parts of [["Mobile panel", "New", "Done", "Hub", "5m ago"], ["Landing", "Working", "Hub", "20m ago"], ["Coordinator", "Idle", "Hub", "2h ago"], ["Earlier thread", "Idle", "Nenu", "docs", "3h ago"]]) {
      expect(recent.getByRole("link", { name: new RegExp(`^${parts.join(",\\s*")}$`) })).toBeInTheDocument();
    }
    expect(recent.getByText("1 working now")).toBeInTheDocument();
    await user.click(recent.getByRole("link", { name: /^Landing/ }));
    expect(router.state.location.pathname).toBe("/pane/w2%3Ap3");
  });

  it("shows the first chats and the rest on request", async () => {
    const agents = Array.from({ length: 8 }, (_, i) => ({ ...data.agents[0]!, paneId: `w1:x${i}`, paneLabel: `Chat ${i}`, lastActiveAt: now - i * 60_000 }));
    const { user, main } = await setup({ ...data, agents });
    const recent = within(main.getByRole("region", { name: /^Recent/ }));
    expect(recent.getAllByRole("listitem")).toHaveLength(6);
    await user.click(recent.getByRole("button", { name: "Show all 8" }));
    expect(recent.getAllByRole("listitem")).toHaveLength(8);
  });
});

it("leaves projects and workspaces to the sidebar instead of repeating them", async () => {
  const { main } = await setup(projectData);
  expect(main.queryByRole("region", { name: /^Projects/ })).not.toBeInTheDocument();
  expect(main.queryByRole("region", { name: /^Workspaces/ })).not.toBeInTheDocument();
  expect(main.queryByRole("searchbox")).not.toBeInTheDocument();
  const sidebar = within(screen.getByRole("complementary", { name: "Workspace sidebar" }));
  expect(sidebar.getByText("Hub")).toBeInTheDocument();
});

it("says in one line that nothing needs you, only while the herd is live", async () => {
  const quiet = { ...data, agents: data.agents.map((agent) => ({ ...agent, status: "idle" as const })) };
  const { main } = await setup(quiet);
  expect(await main.findByText("Nothing needs you right now")).toBeInTheDocument();
  expect(main.queryByRole("region", { name: /^Needs you/ })).not.toBeInTheDocument();
});

it("does not vouch for a quiet herd until its dialogs were read", async () => {
  let reads = 0;
  server.use(http.get("/api/interactions", () => { reads++; return HttpResponse.json({ error: "down" }, { status: 503 }); }));
  const quiet = { ...data, agents: data.agents.map((agent) => ({ ...agent, status: "idle" as const })) };
  const { main } = await setup(quiet);
  await waitFor(() => expect(reads).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(main.queryByText("Nothing needs you right now")).not.toBeInTheDocument();
});

it("does not vouch for a quiet herd from a stale snapshot", async () => {
  const quiet = { ...data, error: true, agents: data.agents.map((agent) => ({ ...agent, status: "idle" as const })) };
  const { main } = await setup(quiet);
  expect(main.queryByText("Nothing needs you right now")).not.toBeInTheDocument();
});

it("keeps failed commands and finished workflows out of Ready to review", async () => {
  const now = Date.now();
  const activity: ActivityResponse = {
    available: true, sessionKey: "s", truncated: false, artifacts: [],
    tasks: [{ id: "k", kind: "bash", title: "bun run test", status: "failed", exitCode: 1, at: now - 60_000, hasOutput: true }],
    workflows: [{ runId: "r1", name: "org-tui-design", status: "completed", updatedAt: now - 60_000, durationMs: 1_418_000, phases: [], agentCount: 4, doneCount: 4 }],
  };
  server.use(http.get("/api/pane/:pane/activity", ({ params }) => HttpResponse.json(params.pane === "w1:p2" ? activity : { available: false, reason: "no-session" })));
  const agents = data.agents.map((a) => a.paneId === "w1:p2" ? { ...a, status: "idle" as const, hasSession: true, lastSeenAt: now - 3_600_000 } : a);
  const { main } = await setup({ ...data, agents });
  await screen.findByRole("heading", { level: 1 });
  expect(main.queryByRole("region", { name: /^Ready to review/ })).not.toBeInTheDocument();
  expect(main.queryByText(/Command failed/)).not.toBeInTheDocument();
  expect(main.queryByText(/Workflow finished/)).not.toBeInTheDocument();
  expect(screen.getByRole("heading", { level: 1 }).textContent).not.toMatch(/review/);
});

it("keeps workflows still running in the one column, each opening its chat", async () => {
  const now = Date.now();
  const activity: ActivityResponse = {
    available: true, sessionKey: "s", truncated: false, artifacts: [], tasks: [],
    workflows: [{ runId: "r2", name: "nenu-wave", status: "running", updatedAt: now, phases: [], agentCount: 9, doneCount: 6 }],
  };
  server.use(http.get("/api/pane/:pane/activity", ({ params }) => HttpResponse.json(params.pane === "w1:p1" ? activity : { available: false, reason: "no-session" })));
  const agents = data.agents.map((a) => a.paneId === "w1:p1" ? { ...a, agent: "claude", hasSession: true } : a);
  const { user, router, main } = await setup({ ...data, agents });
  const running = within(await main.findByRole("region", { name: /^Running in background/ }));
  expect(running.getByText("6 of 9 agents done")).toBeInTheDocument();
  await user.click(running.getByRole("link", { name: /nenu-wave/ }));
  expect(router.state.location.pathname).toBe("/pane/w1%3Ap1");
});

it("lists the pull requests agents opened outside Organizations and reviews them in the agent or on GitHub", async () => {
  const pr = (number: number, extra: Partial<PullRequestView>): PullRequestView => ({
    repo: "frizynn/comercio-saas", number, title: `PR ${number}`, url: `https://github.com/frizynn/comercio-saas/pull/${number}`,
    branch: `feat/${number}`, draft: false, updatedAt: number, paneIds: [], ...extra,
  });
  const { user, router, main } = await setup({ ...data, pullRequests: [
    pr(1699, { title: "Email campaigns", draft: true }),
    pr(1698, { title: "Abandoned carts", paneIds: ["w1:p1"], checks: { passed: 2, failed: 1, pending: 0 }, diff: { additions: 3752, deletions: 154 } }),
    pr(1696, { title: "Publish products", review: "approved", checks: { passed: 4, failed: 0, pending: 0 } }),
  ] });
  expect(headline()).toBe("1 thread needs you, 3 are ready to review");
  const review = within(main.getByRole("region", { name: /^Ready to review/ }));
  expect(review.getAllByRole("link").map((link) => link.getAttribute("aria-label"))).toEqual(["Review Publish products", "Review Abandoned carts", "Review Email campaigns"]);
  expect(review.getByText("#1698")).toBeInTheDocument();
  expect(review.getByText("1 failing")).toBeInTheDocument();
  expect(review.getByText("Draft")).toBeInTheDocument();
  expect(review.getByRole("link", { name: "Review Publish products" })).toHaveAttribute("href", "https://github.com/frizynn/comercio-saas/pull/1696");
  expect(review.getByRole("link", { name: "Review Publish products" })).toHaveAttribute("target", "_blank");
  await user.click(review.getByRole("link", { name: "Review Abandoned carts" }));
  expect(router.state.location.pathname).toBe("/pane/w1%3Ap1");
});

it("shows the first rows and the rest on request", async () => {
  const pullRequests = Array.from({ length: 9 }, (_, i): PullRequestView => ({
    repo: "a/b", number: i + 1, title: `PR ${i + 1}`, url: `https://github.com/a/b/pull/${i + 1}`, branch: "x", draft: false, paneIds: [],
  }));
  const { user, main } = await setup({ ...data, pullRequests });
  const review = within(main.getByRole("region", { name: /^Ready to review/ }));
  expect(review.getAllByRole("listitem")).toHaveLength(5);
  await user.click(review.getByRole("button", { name: "Show all 9" }));
  expect(review.getAllByRole("listitem")).toHaveLength(9);
});

it("jumps with ⌘K, a few letters and Enter from the sidebar's search, the one place to jump from", async () => {
  const { user, router } = await setup();
  await user.keyboard("{Meta>}k{/Meta}");
  const search = screen.getByRole("searchbox", { name: "Search projects and chats" });
  expect(search).toHaveFocus();
  await user.type(search, "review{Enter}");
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
  const recent = within(main.getByRole("region", { name: /^Recent/ }));
  expect(recent.getByRole("link", { name: /^Earlier thread/ })).toHaveAttribute("href", "/pane/w1%3Ap1?s=work");
});
