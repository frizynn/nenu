import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider, useRouteLoaderData } from "react-router";
import { HomeRoute } from "./home";
import { ConnectionBanner } from "@/components/connection-banner";
import { WorkbenchShell } from "@/components/workbench-shell";
import type { ActivityResponse } from "@/lib/activity";
import { __resetConnectionHealth, CONNECTION_LOST_MS } from "@/lib/connection-health";
import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { Interaction, ProjectView, PullRequestView } from "@/lib/types";
import { server } from "@/test/setup";

vi.mock("@/components/update-banner", () => ({ UpdateBanner: () => null }));
const openNewAgent = vi.fn();
vi.mock("@/lib/spawn", async (original) => ({ ...(await original<typeof import("@/lib/spawn")>()), openNewAgent: (target: unknown) => openNewAgent(target) }));
const openNewDialog = vi.fn();
vi.mock("@/components/new-agent-sheet", async (original) => ({ ...(await original<typeof import("@/components/new-agent-sheet")>()), openNewDialog: () => openNewDialog() }));

beforeEach(() => localStorage.clear());

/** A desk's media: 1024px and wider. */
function desk() {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === "(min-width: 1024px)", media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
}

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
  kind: "permission", family: "permission", question: "Do you want to proceed?", context: "Bash command\nbun run test", subject: { tool: "Bash", command: "bun run test" },
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

function Shell() {
  const value = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  return <WorkbenchShell data={value}><Outlet /></WorkbenchShell>;
}

async function setup(value = data, { paneLoader }: { paneLoader?: () => Promise<unknown> } = {}) {
  let current: HomeData | Promise<HomeData> = value;
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, loader: () => current, element: <Shell />, children: [
    { path: "/", element: <HomeRoute /> },
    { path: "/space/:spaceId", element: <p>Workspace opened</p> },
    { path: "/pane/:paneId", element: <p>Pane opened</p>, ...(paneLoader ? { loader: paneLoader } : {}) },
    { path: "/project/:projectSlug", element: <p>Project page</p> },
    { path: "/project/:projectSlug/node/:nodeId", element: <p>Node opened</p> },
  ] }], { initialEntries: ["/?s=work"] });
  render(<RouterProvider router={router} />);
  await screen.findAllByRole("heading");
  /** The next poll returns `next`. */
  const update = async (next: HomeData) => {
    current = next;
    await act(() => router.revalidate());
  };
  /** The next poll hangs, as a read to a host that drops packets does until its timeout. */
  const stall = () => {
    current = new Promise<HomeData>(() => {});
    void router.revalidate();
  };
  return { router, update, stall, user: userEvent.setup(), main: within(document.querySelector("main")!) };
}

/** The connection has not been live for longer than the sustained-outage threshold. */
const sustained = () => {
  const since = Date.now() - CONNECTION_LOST_MS - 5_000;
  __resetConnectionHealth(since);
  return since;
};

/** Home under the app's connection banner, as RootLayout draws it. */
async function underBanner(value: HomeData) {
  function Layout() {
    const d = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
    return <><ConnectionBanner bridge={d.bridge} error={d.error} authError={d.authError} lastSeenAt={d.lastSeenAt} /><WorkbenchShell data={d}><Outlet /></WorkbenchShell></>;
  }
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, loader: () => value, element: <Layout />, children: [{ path: "/", element: <HomeRoute /> }] }], { initialEntries: ["/"] });
  render(<RouterProvider router={router} />);
  await screen.findByRole("heading", { level: 1 });
  return within(document.querySelector("main")!);
}

const headline = () => screen.getByRole("heading", { level: 1 }).textContent;
/** The line under the headline: the facts the headline leaves out. */
const subline = () => screen.getByRole("heading", { level: 1 }).nextElementSibling?.textContent;

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
  // One row: who asks, where, and what it would run, so the lists under it stay in the first screen.
  expect(await needs.findByRole("link", { name: "Review changes, Nenu, Run bun run test?" })).toHaveAttribute("href", "/pane/w1%3Ap2?s=work");
  expect(headline()).toBe("1 needs you");
  expect(subline()).toBe("1 idle");
  await user.click(needs.getByRole("button", { name: "Yes" }));
  expect(answers).toEqual([{ pane: "w1:p2", body: { signature: "sig-1", optionIndex: 0 } }]);
  expect(await needs.findByText("Approved · bun run test")).toBeInTheDocument();
  // The snapshot still reads the pane blocked until its next read: the receipt is its one row meanwhile.
  expect(needs.queryByRole("link", { name: /waiting in the terminal/ })).not.toBeInTheDocument();
  expect(headline()).not.toBe("1 needs you");
});

it("offers a blocked pane with no readable dialog as a row into its thread", async () => {
  const { user, router, main } = await setup();
  const needs = within(main.getByRole("region", { name: /^Needs you/ }));
  await user.click(needs.getByRole("link", { name: /Review changes.*waiting in the terminal/ }));
  expect(router.state.location.pathname).toBe("/pane/w1%3Ap2");
});

it("has no box to write to a coordinator or start a task: New and the coordinator's own chat do that", async () => {
  const { main } = await setup(projectData);
  expect(main.queryByRole("textbox")).not.toBeInTheDocument();
  expect(main.queryByRole("combobox", { name: "Send to" })).not.toBeInTheDocument();
  expect(main.queryByText(/coordinator…/)).not.toBeInTheDocument();
  expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "New" })).toBeEnabled();
});

it("orients an empty herd: two ways to start an agent, and where else agents come from", async () => {
  const { user, main } = await setup({ ...data, agents: [], workspaces: [] });
  const starters = within(main.getByRole("region", { name: "Get started" }));
  await user.click(starters.getByRole("button", { name: /^Start an agent in a folder/ }));
  expect(openNewAgent).toHaveBeenLastCalledWith({ kind: "workspace" });
  await user.click(starters.getByRole("button", { name: /^Start a project or a quick chat/ }));
  expect(openNewDialog).toHaveBeenCalledTimes(1);
  expect(main.getByText("Agents you start in Herdr show up here too.")).toBeVisible();
});

it("offers no starters once the herd has agents", async () => {
  const { main } = await setup();
  expect(main.queryByRole("region", { name: "Get started" })).not.toBeInTheDocument();
});

it("says a session is ready to review on its own row, with its pull request and size, instead of in a second list", async () => {
  const { user, router, main } = await setup(projectData);
  expect(headline()).toBe("1 needs you");
  // The session under review is counted there, not again as idle.
  expect(subline()).toBe("1 to review · 1 working · 2 idle");
  const row = within(main.getByRole("tabpanel", { name: "Recents" })).getByRole("link", { name: /^Mobile panel,/ });
  expect(row).toHaveAccessibleName(/,\s*Ready to review,\s*Hub,\s*PR #1342,\s*\+212 −148$/);
  expect(main.queryByRole("region", { name: /^Pull requests/ })).not.toBeInTheDocument();
  await user.click(row);
  expect(router.state.location.pathname).toBe("/pane/w2%3Ap2");
});

describe("Recents and Workspaces", () => {
  const now = Date.now();
  const shell = { ...data.agents[0]!, paneId: "w1:s1", agent: "shell", kind: "shell" as const, paneLabel: "Dev server", lastActiveAt: now - 10 * 60_000 };
  const recentData: HomeData = {
    ...projectData,
    shellPanes: [shell],
    agents: projectData.agents.map((agent) => ({
      "w1:p1": { ...agent, tabLabel: "docs", lastActiveAt: now - 3 * 3_600_000 },
      "w1:p2": { ...agent, lastActiveAt: now - 60_000 },
      c1: { ...agent, lastActiveAt: now - 2 * 3_600_000 },
      "w2:p2": { ...agent, lastActiveAt: now - 5 * 60_000, lastSeenAt: now - 3_600_000 },
      "w2:p3": { ...agent, lastActiveAt: now - 20 * 60_000 },
    } as Record<string, typeof agent>)[agent.paneId] ?? agent),
  };

  it("lists every session that moved last, shells included, each with its state and place, and opens one in a tap", async () => {
    const { user, router, main } = await setup(recentData);
    const recent = within(main.getByRole("tabpanel", { name: "Recents" }));
    expect(main.getByRole("tab", { name: "Recents" })).toHaveAttribute("aria-selected", "true");
    // "Review changes" is waiting on you, so Needs you shows it and Recents does not.
    expect(recent.getAllByRole("link").map((link) => link.getAttribute("href")))
      .toEqual(["/pane/w2%3Ap2?s=work", "/pane/w1%3As1?s=work", "/pane/w2%3Ap3?s=work", "/pane/c1?s=work", "/pane/w1%3Ap1?s=work"]);
    // Each row reads as one sentence: title, "New", state, place, pull request or tab, size, how long ago.
    for (const parts of [["Mobile panel", "New", "Ready to review", "Hub", "PR #1342", "\\+212 −148", "5m ago"], ["Dev server", "Shell", "Nenu", "10m ago"],
      ["Landing", "Working", "Hub", "20m ago"], ["Hub coordinator", "Idle", "hub", "2h ago"], ["Earlier thread", "Idle", "Nenu", "docs", "3h ago"]]) {
      expect(recent.getByRole("link", { name: new RegExp(`^${parts.join(",\\s*")}$`) })).toBeInTheDocument();
    }
    // How many are working is the headline's to say ("1 working" under it), not Recent's again.
    expect(subline()).toMatch(/1 working/);
    expect(recent.queryByText(/working now/)).not.toBeInTheDocument();
    await user.click(recent.getByRole("link", { name: /^Landing/ }));
    expect(router.state.location.pathname).toBe("/pane/w2%3Ap3");
  });

  it("lists each Herdr workspace once, with its state and how many sessions it holds, and opens one of two tabs on its sessions", async () => {
    const tabbed: HomeData = {
      ...recentData,
      tabs: [
        { tabId: "t1", workspaceId: "w1", number: 1, label: "docs", focused: true, paneCount: 1 },
        { tabId: "t1b", workspaceId: "w1", number: 2, label: "review", focused: false, paneCount: 2 },
        { tabId: "t2", workspaceId: "w2", number: 1, label: "lead", focused: false, paneCount: 1 },
        { tabId: "t3", workspaceId: "w2", number: 2, label: "panels", focused: false, paneCount: 2 },
      ],
      shellPanes: recentData.shellPanes.map((pane) => ({ ...pane, tabId: "t1b" })),
      agents: recentData.agents.map((agent) => agent.paneId === "w1:p2" ? { ...agent, tabId: "t1b" }
        : agent.workspaceId === "w2" ? { ...agent, tabId: agent.paneId === "c1" ? "t2" : "t3" } : agent),
    };
    const { user, router, main } = await setup(tabbed);
    await user.click(main.getByRole("tab", { name: "Workspaces" }));
    const panel = within(main.getByRole("tabpanel", { name: "Workspaces" }));
    // One row per workspace, the one that moved last first, saying how it is and how much it holds;
    // no session and no tab is a row of its own until its workspace opens.
    const rows = panel.getAllByRole("button");
    expect(rows.map((row) => row.getAttribute("aria-expanded"))).toEqual(["false", "false"]);
    expect(rows[0]).toHaveAccessibleName(/^Nenu,\s*Needs you,\s*3 sessions/);
    expect(rows[1]).toHaveAccessibleName(/^hub,\s*Working,\s*3 sessions/);
    expect(panel.queryAllByRole("link")).toHaveLength(0);
    expect(panel.queryByText("docs")).not.toBeInTheDocument();
    expect(panel.queryByText("lead")).not.toBeInTheDocument();

    await user.click(rows[0]!);
    expect(rows[0]).toHaveAttribute("aria-expanded", "true");
    expect(panel.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/pane/w1%3Ap1?s=work", "/pane/w1%3Ap2?s=work", "/pane/w1%3As1?s=work"]);
    // Under its workspace a session leaves the workspace's name out.
    expect(panel.getByRole("link", { name: /^Earlier thread,/ })).toHaveAccessibleName(/^Earlier thread,\s*Idle,\s*docs,\s*3h ago$/);
    await user.click(panel.getByRole("link", { name: /^Earlier thread,/ }));
    expect(router.state.location.pathname).toBe("/pane/w1%3Ap1");
  });

  it("opens a workspace of one tab on its pane in one tap, split or not, with nothing to unfold", async () => {
    const oneTab: HomeData = {
      ...recentData,
      tabs: [
        { tabId: "t1", workspaceId: "w1", number: 1, label: "docs", focused: true, paneCount: 3 },
        { tabId: "t2", workspaceId: "w2", number: 1, label: "lead", focused: false, paneCount: 3 },
      ],
      agents: recentData.agents.map((agent) => agent.workspaceId === "w2" ? { ...agent, tabId: "t2" } : agent),
    };
    const { user, router, main } = await setup(oneTab);
    await user.click(main.getByRole("tab", { name: "Workspaces" }));
    const panel = within(main.getByRole("tabpanel", { name: "Workspaces" }));
    expect(panel.queryByRole("button")).toBeNull();
    // Each row opens the pane its workspace opens on everywhere: the agent asking for you, else the one seen last.
    const rows = panel.getAllByRole("link");
    expect(rows.map((row) => row.getAttribute("href"))).toEqual(["/pane/w1%3Ap2?s=work", "/pane/w2%3Ap2?s=work"]);
    expect(rows[0]).toHaveAccessibleName(/^Nenu,\s*Needs you,\s*3 sessions/);
    expect(rows[1]).toHaveAccessibleName(/^hub,\s*Working,\s*3 sessions/);
    await user.click(rows[0]!);
    expect(router.state.location.pathname).toBe("/pane/w1%3Ap2");
  });

  it("asks for your reply in Needs you, with Reply, and counts it in the headline", async () => {
    const waiting: ProjectView = { ...hub, threads: hub.threads.map((thread) => thread.id === "t3" ? { ...thread, liveStatus: "idle", group: "waiting-on-you", selfWaiting: true } : thread) };
    const { user, router, main } = await setup({ ...recentData, projects: [waiting], agents: recentData.agents.map((agent) => agent.paneId === "w2:p3" ? { ...agent, status: "idle" } : agent) });
    const needs = within(main.getByRole("region", { name: /^Needs you/ }));
    expect(needs.getByRole("link", { name: /^Landing, Hub, Waiting for your reply$/ })).toBeInTheDocument();
    expect(headline()).toBe("2 need you");
    // Home's icon counts the same two, in the phone's tab bar and the desk's sidebar.
    expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: "Home, 2 need you" })).toBeInTheDocument();
    expect(within(screen.getByRole("complementary", { name: "Workspace sidebar" })).getByRole("link", { name: "Home, 2 need you" })).toBeInTheDocument();
    expect(within(main.getByRole("tabpanel", { name: "Recents" })).queryByRole("link", { name: /^Landing,/ })).not.toBeInTheDocument();
    await user.click(needs.getByRole("link", { name: "Reply" }));
    expect(router.state.location.pathname).toBe("/pane/w2%3Ap3");
  });

  it("draws the sessions' control on a desk as text tabs, the open one on a soft grey, and the project filter with no box", async () => {
    desk();
    try {
      const { main } = await setup(recentData);
      const recents = main.getByRole("tab", { name: "Recents" });
      expect(recents).toHaveClass("panel-tab");
      expect(recents).not.toHaveClass("project-segment");
      expect(main.getByRole("tablist", { name: "Sessions" })).not.toHaveClass("project-segmented");
      const filter = main.getByRole("combobox", { name: "Project" }).closest("label");
      expect(filter).toHaveClass("quiet-action");
      expect(filter).not.toHaveClass("border");
      expect(main.getByRole("heading", { level: 1 })).toHaveClass("text-large-title", "lg:text-title");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps a phone's sessions control the segmented one, on its track", async () => {
    const { main } = await setup(recentData);
    expect(main.getByRole("tab", { name: "Recents" })).toHaveClass("project-segment");
    expect(main.getByRole("tablist", { name: "Sessions" })).toHaveClass("project-segmented");
  });

  it("narrows the list to one project on a desk, from the snapshot it already has", async () => {
    let reads = 0;
    server.use(http.get("/api/snapshot", () => { reads++; return HttpResponse.json({}); }));
    const { user, main } = await setup(recentData);
    const filter = main.getByRole("combobox", { name: "Project" });
    // A phone's Home shows every project: the filter is the desk's.
    expect(filter.closest("label")).toHaveClass("max-sm:hidden");
    expect(within(filter).getAllByRole("option").map((option) => option.textContent)).toEqual(["All projects", "Hub"]);
    await user.selectOptions(filter, "hub");
    expect(within(main.getByRole("tabpanel", { name: "Recents" })).getAllByRole("link").map((link) => link.getAttribute("href")))
      .toEqual(["/pane/w2%3Ap2?s=work", "/pane/w2%3Ap3?s=work", "/pane/c1?s=work"]);
    await user.click(main.getByRole("tab", { name: "Workspaces" }));
    const workspaceRows = () => within(main.getByRole("tabpanel", { name: "Workspaces" })).getAllByRole("listitem").map((row) => row.firstElementChild?.getAttribute("aria-label")?.split(",")[0]);
    expect(workspaceRows()).toEqual(["hub"]);
    await user.selectOptions(filter, "");
    expect(workspaceRows()).toEqual(["Nenu", "hub"]);
    expect(reads).toBe(0);
  });

  it("unfolds a one-tab workspace under a project filter that leaves out the pane it opens on", async () => {
    const scratch = { ...data.agents[0]!, paneId: "w2:scratch", workspaceId: "w2", workspaceLabel: "hub", paneLabel: "Scratch", lastSeenAt: now };
    const { user, main } = await setup({ ...recentData, agents: [...recentData.agents, scratch] });
    await user.click(main.getByRole("tab", { name: "Workspaces" }));
    const panel = within(main.getByRole("tabpanel", { name: "Workspaces" }));
    expect(panel.getByRole("link", { name: /^hub,/ })).toHaveAttribute("href", "/pane/w2%3Ascratch?s=work");
    await user.selectOptions(main.getByRole("combobox", { name: "Project" }), "hub");
    await user.click(panel.getByRole("button", { name: /^hub,/ }));
    expect(panel.getAllByRole("link").map((link) => link.getAttribute("href"))).toEqual(["/pane/c1?s=work", "/pane/w2%3Ap2?s=work", "/pane/w2%3Ap3?s=work"]);
  });

  it("offers no project filter where there are no projects", async () => {
    const { main } = await setup(data);
    expect(main.queryByRole("combobox", { name: "Project" })).not.toBeInTheDocument();
  });

  it("remembers on this device which list it shows", async () => {
    const first = await setup(recentData);
    await first.user.click(first.main.getByRole("tab", { name: "Workspaces" }));
    cleanup();
    const { main } = await setup(recentData);
    expect(main.getByRole("tab", { name: "Workspaces" })).toHaveAttribute("aria-selected", "true");
    expect(main.getByRole("tabpanel", { name: "Workspaces" })).toBeInTheDocument();
  });

  it("still switches lists where the browser refuses storage", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("denied"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("denied"); });
    try {
      const { user, main } = await setup(recentData);
      await user.click(main.getByRole("tab", { name: "Workspaces" }));
      expect(main.getByRole("tabpanel", { name: "Workspaces" })).toBeInTheDocument();
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("switches lists from the snapshot it already has, without a request", async () => {
    const { user, main } = await setup(recentData);
    const requests: string[] = [];
    const record = ({ request }: { request: Request }) => void requests.push(request.url);
    server.events.on("request:start", record);
    try {
      await user.click(main.getByRole("tab", { name: "Workspaces" }));
      await user.click(main.getByRole("tab", { name: "Recents" }));
    } finally {
      server.events.removeListener("request:start", record);
    }
    // Home's own periodic reads may tick meanwhile on a loaded run; switching adds none of its own.
    expect(requests.filter((url) => !/\/api\/(snapshot|interactions|pane\/[^/]+\/activity)\b/.test(url))).toEqual([]);
  });

  it("shows the first chats and the rest on request", async () => {
    const agents = Array.from({ length: 8 }, (_, i) => ({ ...data.agents[0]!, paneId: `w1:x${i}`, paneLabel: `Chat ${i}`, lastActiveAt: now - i * 60_000 }));
    const { user, main } = await setup({ ...data, agents });
    const recent = within(main.getByRole("tabpanel", { name: "Recents" }));
    expect(recent.getAllByRole("listitem")).toHaveLength(6);
    await user.click(recent.getByRole("button", { name: "Show all 8" }));
    expect(recent.getAllByRole("listitem")).toHaveLength(8);
  });
});

it("marks the tapped row as opening while a slow pane read holds the navigation", async () => {
  let release!: () => void;
  const read = new Promise<null>((resolve) => { release = () => resolve(null); });
  const { user, main } = await setup(data, { paneLoader: () => read });
  const row = within(main.getByRole("tabpanel", { name: "Recents" })).getByRole("link", { name: /^Earlier thread/ });
  const tapped = performance.now();
  await user.click(row);
  // A fast read never flashes a spinner; a slow one shows on the row that was tapped.
  expect(row).not.toHaveAttribute("aria-busy");
  await waitFor(() => expect(row).toHaveAttribute("aria-busy", "true"));
  expect(performance.now() - tapped).toBeGreaterThanOrEqual(120);
  expect(within(main.getByRole("region", { name: /^Needs you/ })).getByRole("link")).not.toHaveAttribute("aria-busy");
  release();
  expect(await screen.findByText("Pane opened")).toBeInTheDocument();
});

it("waits its own 120ms again when the same row is tapped a second time", async () => {
  const { user, router, main } = await setup(data, { paneLoader: () => new Promise(() => {}) });
  const row = () => within(main.getByRole("tabpanel", { name: "Recents" })).getByRole("link", { name: /^Earlier thread/ });
  await user.click(row());
  await waitFor(() => expect(row()).toHaveAttribute("aria-busy", "true"));
  // Back on Home before the read came back (the tab bar's Home, or a redirect), then the same row again.
  await act(() => router.navigate("/?s=work"));
  const tapped = performance.now();
  await user.click(row());
  expect(row()).not.toHaveAttribute("aria-busy");
  await waitFor(() => expect(row()).toHaveAttribute("aria-busy", "true"));
  expect(performance.now() - tapped).toBeGreaterThanOrEqual(120);
});

it("marks a Needs you row as opening too", async () => {
  const { user, main } = await setup(data, { paneLoader: () => new Promise(() => {}) });
  const row = within(main.getByRole("region", { name: /^Needs you/ })).getByRole("link", { name: /^Review changes/ });
  await user.click(row);
  await waitFor(() => expect(row).toHaveAttribute("aria-busy", "true"));
});

it("leaves projects and search to the sidebar instead of repeating them", async () => {
  const { main } = await setup(projectData);
  expect(main.queryByRole("region", { name: /^Projects/ })).not.toBeInTheDocument();
  expect(main.queryByRole("searchbox")).not.toBeInTheDocument();
  const sidebar = within(screen.getByRole("complementary", { name: "Workspace sidebar" }));
  expect(sidebar.getByText("Hub")).toBeInTheDocument();
});

it("says in its headline that nothing needs you, never the pull requests, only while the herd is live", async () => {
  const quiet = { ...data, agents: data.agents.map((agent) => ({ ...agent, status: "idle" as const })),
    pullRequests: [{ repo: "a/b", number: 7, title: "PR 7", url: "https://github.com/a/b/pull/7", branch: "x", draft: false, paneIds: [] }] };
  const { main } = await setup(quiet);
  await waitFor(() => expect(headline()).toBe("Nothing needs you"));
  expect(subline()).toBe("1 to review · 2 idle");
  expect(main.queryByText("Nothing needs you right now")).not.toBeInTheDocument();
  expect(main.queryByRole("region", { name: /^Needs you/ })).not.toBeInTheDocument();
  expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("link", { name: "Home" })).toBeInTheDocument();
});

it("does not vouch for a quiet herd until its dialogs were read", async () => {
  let reads = 0;
  server.use(http.get("/api/interactions", () => { reads++; return HttpResponse.json({ error: "down" }, { status: 503 }); }));
  const quiet = { ...data, agents: data.agents.map((agent) => ({ ...agent, status: "idle" as const })) };
  await setup(quiet);
  await waitFor(() => expect(reads).toBeGreaterThan(0));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(headline()).toBe("All quiet");
});

it("does not vouch for a quiet herd from a stale snapshot", async () => {
  const quiet = { ...data, error: true, agents: data.agents.map((agent) => ({ ...agent, status: "idle" as const })) };
  await setup(quiet);
  expect(headline()).not.toBe("Nothing needs you");
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
  expect(main.queryByRole("region", { name: /^Pull requests/ })).not.toBeInTheDocument();
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

// Pull requests are a tab of the sessions' switcher, never a section of their own.
it("lists every pull request under the PRs tab, ready to merge first, and opens each in its session, its thread or on GitHub", async () => {
  const pr = (number: number, extra: Partial<PullRequestView>): PullRequestView => ({
    repo: "acme/shop", number, title: `PR ${number}`, url: `https://github.com/acme/shop/pull/${number}`,
    branch: `feat/${number}`, draft: false, updatedAt: number, paneIds: [], ...extra,
  });
  const { user, router, main } = await setup({ ...data, projects: [{ ...hub, workspaceIds: [], threads: [
    { id: "t9", title: "Orders panel", parentId: "root", role: "worker", status: "open", liveStatus: "done", group: "ready-for-review",
      pr: { state: "open", number: 1700, review: "approved", checks: { passed: 2, failed: 0, pending: 0 }, mergeBlocker: null } },
  ] }], pullRequests: [
    pr(1699, { title: "Email campaigns", draft: true, checks: { passed: 1, failed: 0, pending: 2 } }),
    pr(1698, { title: "Abandoned carts", paneIds: ["w1:p1"], checks: { passed: 2, failed: 1, pending: 0 }, diff: { additions: 3752, deletions: 154 } }),
    pr(1697, { title: "Gift cards", review: "changes_requested", checks: { passed: 2, failed: 1, pending: 0 }, diff: { additions: 30, deletions: 9 } }),
    pr(1696, { title: "Publish products", review: "approved", checks: { passed: 4, failed: 0, pending: 0 }, diff: { additions: 40, deletions: 2 } }),
  ] });
  expect(headline()).toBe("1 needs you");
  expect(subline()).toBe("5 to review");
  expect(main.queryByRole("region", { name: /^Pull requests/ })).not.toBeInTheDocument();
  expect(main.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Recents", "Workspaces", "PRs"]);
  // A session's row still carries its pull request.
  expect(within(main.getByRole("tabpanel", { name: "Recents" })).getByRole("link", { name: /^Earlier thread,/ })).toHaveAccessibleName(/,\s*PR #1698,\s*\+3752 −154$/);
  await user.click(main.getByRole("tab", { name: "PRs" }));
  const prs = within(main.getByRole("tabpanel", { name: "PRs" }));
  // The five the headline counts, ready to merge first.
  expect(prs.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent)).toEqual(["Ready to merge", "In review"]);
  expect(prs.getAllByRole("link").map((link) => link.getAttribute("aria-label"))).toEqual([
    "Publish products, #1696, +40 −2, checks passed, approved",
    "Orders panel, #1700, checks passed, approved",
    "Abandoned carts, #1698, +3752 −154, 1 check failing",
    "Gift cards, #1697, +30 −9, 1 check failing, changes requested",
    "Email campaigns, #1699, checks running, draft",
  ]);
  expect(prs.getByRole("link", { name: /^Publish products,/ })).toHaveAttribute("href", "https://github.com/acme/shop/pull/1696");
  expect(prs.getByRole("link", { name: /^Publish products,/ })).toHaveAttribute("target", "_blank");
  expect(prs.getByRole("link", { name: /^Abandoned carts,/ })).toHaveAttribute("href", "/pane/w1%3Ap1?s=work");
  await user.click(prs.getByRole("link", { name: /^Orders panel,/ }));
  expect(router.state.location.pathname).toBe("/project/hub/node/t9");
});

it("shows the first pull requests and the rest on request, and remembers the tab", async () => {
  const pullRequests = Array.from({ length: 9 }, (_, i): PullRequestView => ({
    repo: "a/b", number: i + 1, title: `PR ${i + 1}`, url: `https://github.com/a/b/pull/${i + 1}`, branch: "x", draft: false, paneIds: [],
  }));
  const { user, main } = await setup({ ...data, pullRequests });
  await user.click(main.getByRole("tab", { name: "PRs" }));
  const review = within(main.getByRole("tabpanel", { name: "PRs" }));
  expect(review.getAllByRole("link")).toHaveLength(5);
  await user.click(review.getByRole("button", { name: "Show all 9" }));
  expect(review.getAllByRole("link")).toHaveLength(9);
  expect(localStorage.getItem("nenu:home-list:v1")).toBe("prs");
});

it("has no PRs tab when there is no pull request, and falls back to Recents from a remembered one", async () => {
  localStorage.setItem("nenu:home-list:v1", "prs");
  const { main } = await setup();
  expect(main.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Recents", "Workspaces"]);
  expect(main.getByRole("tab", { name: "Recents" })).toHaveAttribute("aria-selected", "true");
  expect(main.getByRole("tabpanel", { name: "Recents" })).toBeInTheDocument();
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
  expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "New" })).toBeDisabled();
  expect(main.queryByRole("region", { name: "Get started" })).not.toBeInTheDocument();
});

describe("an outage", () => {
  it("stays quiet through a brief failure: the same headline and lists", async () => {
    const { update, main } = await setup();
    await update({ ...data, error: true });
    expect(headline()).toBe("1 needs you");
    expect(main.queryByText(/Can't reach|Last synced|Showing the last herd/)).not.toBeInTheDocument();
    expect(within(main.getByRole("tabpanel", { name: "Recents" })).getByRole("link", { name: /^Earlier thread/ })).toBeInTheDocument();
  });

  // The connection banner (root.tsx) is the one place that names the problem and dates the herd;
  // Home keeps saying what the work is, greyed, and its composer says what it is waiting for.
  it("keeps its work headline through a sustained Herdr outage, and leaves naming it to the banner", async () => {
    server.use(http.get("/api/interactions", () => HttpResponse.json({ interactions: [permission] })));
    const { update, main } = await setup();
    const needs = within(main.getByRole("region", { name: /^Needs you/ }));
    await needs.findByRole("button", { name: "Yes" });
    sustained();
    await update({ ...data, bridge: "disconnected" });
    expect(headline()).toBe("1 needs you");
    expect(main.queryByText(/Can.t reach|Last synced|Showing the last herd|Nenu keeps trying/)).not.toBeInTheDocument();
    // The herd stays to look at and open; what it cannot vouch for is paused.
    expect(await needs.findByText("Answers are paused.")).toBeVisible();
    expect(needs.queryByText(/Herdr/)).not.toBeInTheDocument();
    expect(needs.getByRole("button", { name: "Yes" })).toBeDisabled();
    expect(within(main.getByRole("tabpanel", { name: "Recents" })).getByRole("link", { name: /^Earlier thread/ })).toBeInTheDocument();
  });

  it("keeps its work headline when Nenu stops answering, without dating the herd a second time", async () => {
    sustained();
    const { main } = await setup({ ...data, error: true, lastSeenAt: Date.now() - 3 * 60_000 });
    expect(headline()).toBe("1 needs you");
    expect(screen.queryByText(/Can.t reach|Last synced/)).not.toBeInTheDocument();
    expect(main.getByRole("heading", { level: 1 })).toHaveClass("text-muted-foreground");
  });

  it("keeps its work headline when access is refused, and its composer asks to sign in", async () => {
    await setup({ ...data, error: true, authError: true });
    expect(headline()).toBe("1 needs you");
    expect(screen.queryByText(/Access refused/)).not.toBeInTheDocument();
  });

  // A refused read leaves the last herd on screen, which can be a cold boot's hours-old copy: the
  // banner dates it, once, as it does an outage.
  it("dates the herd it keeps under a refusal, once, in the banner", async () => {
    await underBanner({ ...data, error: true, authError: true, lastSeenAt: Date.now() - 3 * 60_000 });
    expect(headline()).toBe("1 needs you");
    expect(screen.getAllByText(/Last synced/)).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent(/Last synced \d/);
  });

  it("tells each Needs you card the real reason answers are paused", async () => {
    server.use(http.get("/api/interactions", () => HttpResponse.json({ interactions: [permission] })));
    const { update, main } = await setup();
    await main.findByText("bun run test");
    await update({ ...data, bridge: "disconnected" });
    expect(await main.findByText("Herdr isn't responding. Answers are paused.")).toBeVisible();
    await update({ ...data, error: true });
    expect(await main.findByText("Answers are paused until Nenu reconnects.")).toBeVisible();
    await update({ ...data, error: true, authError: true });
    expect(await main.findByText("Sign in again to answer.")).toBeVisible();
  });
});

describe("a first load that never reached Nenu", () => {
  const never: HomeData = { ...data, error: true, bridge: undefined, agents: [], workspaces: [], projects: [] };

  it("says it is connecting while it retries quietly, with nothing to start", async () => {
    const { main } = await setup(never);
    expect(main.getByRole("heading", { name: "Connecting to Nenu…" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 1, name: "Home" })).toBeInTheDocument();
    expect(main.queryByRole("textbox")).not.toBeInTheDocument();
    expect(main.queryByText(/snapshot/)).not.toBeInTheDocument();
  });

  it("leaves the problem and its one Retry to the banner once the outage is sustained", async () => {
    sustained();
    const main = await underBanner(never);
    expect(screen.getAllByRole("button", { name: "Retry" })).toHaveLength(1);
    expect(screen.getAllByText(/Can.t reach Nenu/)).toHaveLength(1);
    expect(main.queryByRole("button")).not.toBeInTheDocument();
    expect(main.getByRole("heading", { name: "Nothing to show yet" })).toBeInTheDocument();
    // The banner names the problem; the body adds what the operator can do about it.
    expect(main.getByText("Your threads, questions and reviews show up here once Nenu answers. Check this device's network or VPN.")).toBeVisible();
  });

  it("leaves a refusal and its one Sign in to the banner", async () => {
    const main = await underBanner({ ...never, authError: true });
    expect(screen.getAllByRole("link", { name: "Sign in" })).toHaveLength(1);
    expect(screen.getAllByText(/Access refused/)).toHaveLength(1);
    expect(main.queryByRole("link")).not.toBeInTheDocument();
    expect(main.getByText("Your threads, questions and reviews show up here once you sign in again.")).toBeVisible();
  });
});

it("keeps existing threads navigable while answering and creating are read-only", async () => {
  server.use(http.get("/api/interactions", () => HttpResponse.json({ interactions: [permission] })));
  const { main } = await setup({ ...data, device: { enforced: true, device: "phone", authorized: false } });
  expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: "New" })).toBeDisabled();
  const needs = within(main.getByRole("region", { name: /^Needs you/ }));
  // The row says why, with nothing to press; the thread stays one tap away.
  expect(await needs.findByText("Read-only on this device. Answer from an authorised one.")).toBeVisible();
  expect(needs.queryByRole("button", { name: "Yes" })).not.toBeInTheDocument();
  expect(needs.getByRole("link", { name: "Answer" })).toHaveAttribute("href", "/pane/w1%3Ap2?s=work");
  const recent = within(main.getByRole("tabpanel", { name: "Recents" }));
  expect(recent.getByRole("link", { name: /^Earlier thread/ })).toHaveAttribute("href", "/pane/w1%3Ap1?s=work");
});
