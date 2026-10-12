import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
import { declarations } from "@/test/css-rules";
import { server } from "@/test/setup";

vi.mock("@/components/update-banner", () => ({ UpdateBanner: () => null }));
const openNewAgent = vi.fn();
vi.mock("@/lib/spawn", async (original) => ({ ...(await original<typeof import("@/lib/spawn")>()), openNewAgent: (target: unknown) => openNewAgent(target) }));
const openNewDialog = vi.fn();
vi.mock("@/components/new-agent-sheet", async (original) => ({ ...(await original<typeof import("@/components/new-agent-sheet")>()), openNewDialog: () => openNewDialog() }));

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

/** The app's frame; `banner` also draws the connection banner above it, as RootLayout does. */
function Shell({ banner = false }: { banner?: boolean }) {
  const value = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  return <>
    {banner && <ConnectionBanner bridge={value.bridge} error={value.error} authError={value.authError} lastSeenAt={value.lastSeenAt} />}
    <WorkbenchShell data={value}><Outlet /></WorkbenchShell>
  </>;
}

async function setup(value = data, { paneLoader, banner = false }: { paneLoader?: () => Promise<unknown>; banner?: boolean } = {}) {
  let current: HomeData | Promise<HomeData> = value;
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, loader: () => current, element: <Shell banner={banner} />, children: [
    { path: "/", element: <HomeRoute /> },
    { path: "/space/:spaceId", element: <p>Workspace opened</p> },
    { path: "/pane/:paneId", element: <p>Pane opened</p>, ...(paneLoader ? { loader: paneLoader } : {}) },
    { path: "/project/:projectSlug", element: <p>Project page</p> },
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
  expect(await needs.findByText("Do you want to proceed?")).toBeInTheDocument();
  expect(needs.getByText(/Review changes · Nenu/)).toBeInTheDocument();
  expect(headline()).toBe("1 thread needs you");
  await user.click(needs.getByRole("button", { name: "Yes" }));
  expect(answers).toEqual([{ pane: "w1:p2", body: { signature: "sig-1", optionIndex: 0 } }]);
  expect(await needs.findByText("Approved · bun run test")).toBeInTheDocument();
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
  await user.click(main.getByRole("button", { name: "Start" }));
  expect(openNewAgent).toHaveBeenLastCalledWith({ kind: "workspace" });
  await user.type(main.getByRole("textbox", { name: "Task for a new agent" }), "Audit the auth flow{Enter}");
  expect(openNewAgent).toHaveBeenLastCalledWith({ kind: "workspace", message: "Audit the auth flow" });
  expect(main.getByRole("textbox", { name: "Task for a new agent" })).toHaveValue("");
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

it("calls the one action by one verb: describe a task, in a place, then Start", async () => {
  const { user, main } = await setup();
  const box = main.getByRole("textbox", { name: "Task for a new agent" });
  expect(box).toHaveAttribute("placeholder", "Describe a task…");
  // What the chip shows, leaving out the native select's option list.
  const chip = () => [...main.getByRole("combobox", { name: "Send to" }).closest("label")!.children]
    .filter((el) => el.tagName !== "SELECT").map((el) => el.textContent).join(" ").replace(/\s+/g, " ").trim();
  expect(chip()).toBe("In: New workspace");
  expect(main.getByRole("button", { name: "Start" })).toBeEnabled();
  await user.selectOptions(main.getByRole("combobox", { name: "Send to" }), "workspace:w1");
  expect(chip()).toBe("In: Nenu");
});

it("sends with the thread composer's own button: one 32px circle with a 44px reach", async () => {
  const { user, main } = await setup();
  // The thread's Send (composer.tsx) wears these three; the shape and the reach live in their rules.
  expect(main.getByRole("button", { name: "Start" })).toHaveClass("composer-action", "composer-send", "hit-area");
  await user.selectOptions(main.getByRole("combobox", { name: "Send to" }), "workspace:w1");
  expect(main.getByRole("button", { name: "Start" })).toHaveClass("composer-action", "composer-send", "hit-area");
  const css = readFileSync(resolve(import.meta.dirname, "../styles/composer.css"), "utf8");
  expect(declarations(css, ".composer-action")).toMatchObject({ width: "32px", height: "32px", "border-radius": "9999px" });
});

// Safari before 26.2 has no `field-sizing: content`: the box stayed one line over a four-line task.
it("grows the box with a multi-line task where the browser has no field-sizing", async () => {
  vi.stubGlobal("CSS", { supports: () => false });
  // jsdom lays nothing out: a row is 24px of scrollHeight here, plus 20px of padding.
  Object.defineProperty(HTMLTextAreaElement.prototype, "scrollHeight", { configurable: true, get(this: HTMLTextAreaElement) { return this.value.split("\n").length * 24 + 20; } });
  try {
    const { main } = await setup();
    const box = main.getByRole("textbox", { name: "Task for a new agent" });
    fireEvent.change(box, { target: { value: "Audit the auth flow\nthen the session store\nthen the cookies\nand report back" } });
    expect(box.style.height).toBe(`${4 * 24 + 20}px`);
    fireEvent.change(box, { target: { value: "" } });
    expect(box.style.height).toBe("");
  } finally {
    delete (HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
    vi.unstubAllGlobals();
  }
});

it("starts a thread in a chosen workspace", async () => {
  const { user, main } = await setup();
  await user.selectOptions(main.getByRole("combobox", { name: "Send to" }), "workspace:w1");
  await user.type(main.getByRole("textbox", { name: "Task for a new agent" }), "Fix the flaky test{Enter}");
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

  const working = { ...projectData, agents: projectData.agents.map((a) => a.paneId === "c1" ? { ...a, status: "working" as const } : a) };
  const queued = (body: Record<string, unknown>) => [{ id: body.id, text: body.text, state: "queued", createdAt: 1, revision: 1, deliveryMode: body.deliveryMode }];

  it("asks in an action sheet whether it reads the message now or after this turn, each time", async () => {
    const posts = queue(queued);
    const { user, main } = await setup(working);
    const box = main.getByRole("textbox", { name: "Message for Hub's coordinator" });
    await user.type(box, "Also the landing{Enter}");
    expect(posts).toEqual([]);
    const sheet = within(await screen.findByRole("dialog", { name: "Hub's coordinator is working" }));
    expect(sheet.getByText("When should it read this?")).toBeVisible();
    // The rows say what the coordinator's CLI does with each choice (ADR 0056).
    expect(sheet.getByRole("button", { name: /^Send now/ })).toHaveTextContent(/Steers this turn/);
    expect(sheet.getByRole("button", { name: /^Send after this turn/ })).toHaveTextContent(/runs as the next turn/);
    await user.click(sheet.getByRole("button", { name: /^Send after this turn/ }));
    expect(await main.findByText("Queued for Hub's coordinator.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(posts).toEqual([expect.objectContaining({ pane: "c1", deliveryMode: "afterTurn" })]);
    // The choice is made at every send, never remembered.
    await user.type(box, "And the footer{Enter}");
    await user.click(within(await screen.findByRole("dialog", { name: "Hub's coordinator is working" })).getByRole("button", { name: /^Send now/ }));
    await waitFor(() => expect(posts).toHaveLength(2));
    // Codex reads "now" as a steer into the running turn.
    expect(posts[1]).toEqual(expect.objectContaining({ pane: "c1", text: "And the footer", deliveryMode: "steer" }));
  });

  it("asks nothing of a busy coordinator whose CLI has no measured choice, and queues it after the turn", async () => {
    const posts = queue(queued);
    const pi = { ...working, agents: working.agents.map((a) => a.paneId === "c1" ? { ...a, agent: "pi" } : a) };
    const { user, main } = await setup(pi);
    await user.type(main.getByRole("textbox", { name: "Message for Hub's coordinator" }), "Also the landing{Enter}");
    expect(await main.findByText("Queued for Hub's coordinator.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(posts).toEqual([expect.objectContaining({ pane: "c1", deliveryMode: "afterTurn" })]);
  });

  it("keeps the draft when the busy choice is cancelled", async () => {
    const posts = queue(queued);
    const { user, main } = await setup(working);
    await user.type(main.getByRole("textbox", { name: "Message for Hub's coordinator" }), "Not yet{Enter}");
    await user.click(within(await screen.findByRole("dialog", { name: "Hub's coordinator is working" })).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(main.getByRole("textbox", { name: "Message for Hub's coordinator" })).toHaveValue("Not yet");
    expect(posts).toEqual([]);
  });

  it("goes straight to the coordinator when its queue can't take a message from Home, without asking when first", async () => {
    server.use(http.get("/api/pane/:pane/queue", () => HttpResponse.json({ available: false, messages: [] })));
    const { user, router, main } = await setup(working);
    const box = main.getByRole("textbox", { name: "Message for Hub's coordinator" });
    await user.type(box, "Also the landing{Enter}");
    const notice = within(await main.findByRole("alert"));
    expect(notice.getByText("Hub's coordinator can't take messages from Home")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(box).toHaveValue("Also the landing");
    await user.click(notice.getByRole("link", { name: "Open coordinator" }));
    expect(router.state.location.pathname).toBe("/pane/c1");
  });

  it("says in a card why a send failed, keeps the draft and offers the coordinator in one tap", async () => {
    server.use(http.get("/api/pane/:pane/queue", () => HttpResponse.json({ available: false, messages: [] })));
    const { user, router, main } = await setup(projectData);
    const box = main.getByRole("textbox", { name: "Message for Hub's coordinator" });
    await user.type(box, "Start phase two{Enter}");
    const notice = within(await main.findByRole("alert"));
    expect(notice.getByText("Hub's coordinator can't take messages from Home")).toBeVisible();
    expect(notice.getByText(/Your message is still in the box/)).toBeVisible();
    expect(box).toHaveValue("Start phase two");
    await user.click(notice.getByRole("link", { name: "Open coordinator" }));
    expect(router.state.location.pathname).toBe("/pane/c1");
  });

  it("says a send whose answer was lost may already be queued, and resends it as the same row", async () => {
    const posts: Array<Record<string, unknown>> = [];
    let lose = true;
    server.use(
      http.get("/api/pane/:pane/queue", () => HttpResponse.json({ available: true, scope: "s1", messages: [] })),
      http.post("/api/pane/:pane/queue", async ({ request }) => {
        posts.push(await request.json() as Record<string, unknown>);
        return lose ? HttpResponse.error() : HttpResponse.json({ available: true, scope: "s1", messages: [] });
      }),
    );
    const { user, main } = await setup(projectData);
    const box = main.getByRole("textbox", { name: "Message for Hub's coordinator" });
    await user.type(box, "Start phase two{Enter}");
    const notice = within(await main.findByRole("alert"));
    expect(notice.getByText("Not sure it reached Hub's coordinator")).toBeVisible();
    expect(notice.getByText(/it may already be in the coordinator's queue/)).toBeVisible();
    expect(notice.queryByText(/still in the box/)).not.toBeInTheDocument();
    expect(box).toHaveValue("Start phase two");
    // The same text again is the same row to the bridge, which keeps one copy.
    lose = false;
    await user.type(box, "{Enter}");
    expect(await main.findByText("Sent to Hub's coordinator.")).toBeInTheDocument();
    expect(posts).toHaveLength(2);
    expect(posts[1]!.id).toBe(posts[0]!.id);
  });

  it("sends at once while only background work runs, as the terminal does", async () => {
    const posts = queue();
    const waiting = { ...projectData, agents: projectData.agents.map((a) => a.paneId === "c1"
      ? { ...a, status: "working" as const, turn: { running: false, background: true, source: "claude-session" as const } }
      : a) };
    const { user, main } = await setup(waiting);
    await user.type(main.getByRole("textbox", { name: "Message for Hub's coordinator" }), "Status?{Enter}");
    expect(await main.findByText("Sent to Hub's coordinator.")).toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(posts).toEqual([expect.objectContaining({ pane: "c1", deliveryMode: "asap" })]);
  });
});

it("lists pull requests ready to review with their diff and checks", async () => {
  const { user, router, main } = await setup(projectData);
  expect(headline()).toBe("1 thread needs you");
  expect(subline()).toBe("1 to review · 1 working");
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
    for (const parts of [["Mobile panel", "New", "Done", "Hub", "5m ago"], ["Landing", "Working", "Hub", "20m ago"], ["Hub coordinator", "Idle", "hub", "2h ago"], ["Earlier thread", "Idle", "Nenu", "docs", "3h ago"]]) {
      expect(recent.getByRole("link", { name: new RegExp(`^${parts.join(",\\s*")}$`) })).toBeInTheDocument();
    }
    // How many are working is the headline's to say ("1 working" under it), not Recent's again.
    expect(subline()).toMatch(/1 working/);
    expect(recent.queryByText(/working now/)).not.toBeInTheDocument();
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

it("marks the tapped row as opening while a slow pane read holds the navigation", async () => {
  let release!: () => void;
  const read = new Promise<null>((resolve) => { release = () => resolve(null); });
  const { user, main } = await setup(data, { paneLoader: () => read });
  const row = within(main.getByRole("region", { name: /^Recent/ })).getByRole("link", { name: /^Earlier thread/ });
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
  const row = () => within(main.getByRole("region", { name: /^Recent/ })).getByRole("link", { name: /^Earlier thread/ });
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
  expect(headline()).toBe("1 thread needs you");
  expect(subline()).toBe("3 to review");
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
  expect(main.getByRole("button", { name: "Start" })).toBeDisabled();
  expect(main.getByRole("textbox", { name: "Task for a new agent" })).toBeDisabled();
  expect(main.queryByRole("region", { name: "Get started" })).not.toBeInTheDocument();
});

describe("an outage", () => {
  it("stays quiet through a brief failure: the same headline and lists", async () => {
    const { update, main } = await setup();
    await update({ ...data, error: true });
    expect(headline()).toBe("1 thread needs you");
    expect(main.queryByText(/Can't reach|Last synced|Showing the last herd/)).not.toBeInTheDocument();
    expect(within(main.getByRole("region", { name: /^Recent/ })).getByRole("link", { name: /^Earlier thread/ })).toBeInTheDocument();
  });

  // Known gap, pinned so it turns red the day it is fixed: a failed snapshot read makes canCreate
  // (lib/types.ts, read by workbench-shell.tsx) false at once, so the composer greys out with no reason
  // given, although only a sustained outage should block it. Both files are outside Home.
  it.fails("known gap: keeps the composer usable through a brief failure", async () => {
    const { update, main } = await setup();
    await update({ ...data, error: true });
    expect(main.getByRole("textbox", { name: "Task for a new agent" })).toBeEnabled();
  });

  // Until that gap closes, the box at least stays quiet: a brief failure is the quiet retry, so it
  // keeps its own words and only a sustained outage tells the operator to reconnect.
  it("keeps the composer's own words through a brief failure", async () => {
    const { update, main } = await setup();
    await update({ ...data, error: true });
    expect(main.getByRole("textbox", { name: "Task for a new agent" })).toHaveAttribute("placeholder", "Describe a task…");
  });

  // The connection banner (root.tsx) is the one place that names the problem and dates the herd;
  // Home keeps saying what the work is, greyed, and its composer says what it is waiting for.
  it("keeps its work headline through a sustained Herdr outage, and leaves naming it to the banner", async () => {
    server.use(http.get("/api/interactions", () => HttpResponse.json({ interactions: [permission] })));
    const { update, main } = await setup(data, { banner: true });
    const needs = within(main.getByRole("region", { name: /^Needs you/ }));
    await needs.findByRole("button", { name: "Yes" });
    sustained();
    await update({ ...data, bridge: "disconnected" });
    expect(await screen.findByText("Herdr isn’t responding.")).toBeVisible();
    expect(headline()).toBe("1 thread needs you");
    expect(main.queryByText(/Can.t reach|Last synced|Showing the last herd|Nenu keeps trying/)).not.toBeInTheDocument();
    // The herd stays to look at and open; what it cannot vouch for is paused.
    expect(await needs.findByText("Answers are paused.")).toBeVisible();
    expect(needs.queryByText(/Herdr/)).not.toBeInTheDocument();
    expect(needs.getByRole("button", { name: "Yes" })).toBeDisabled();
    expect(within(main.getByRole("region", { name: /^Recent/ })).getByRole("link", { name: /^Earlier thread/ })).toBeInTheDocument();
    expect(main.getByRole("textbox", { name: "Task for a new agent" })).toHaveAttribute("placeholder", "Reconnect to start an agent");
  });

  it("keeps its work headline when Nenu stops answering, without dating the herd a second time", async () => {
    sustained();
    const { main } = await setup({ ...data, error: true, lastSeenAt: Date.now() - 3 * 60_000 });
    expect(headline()).toBe("1 thread needs you");
    expect(screen.queryByText(/Can.t reach|Last synced/)).not.toBeInTheDocument();
    expect(main.getByRole("textbox", { name: "Task for a new agent" })).toHaveAttribute("placeholder", "Reconnect to start an agent");
  });

  it("keeps its work headline when access is refused, and its composer asks to sign in", async () => {
    await setup({ ...data, error: true, authError: true });
    expect(headline()).toBe("1 thread needs you");
    expect(screen.queryByText(/Access refused/)).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Task for a new agent" })).toHaveAttribute("placeholder", "Sign in again to start an agent");
  });

  // A refused read leaves the last herd on screen, which can be a cold boot's hours-old copy: the
  // banner dates it, once, as it does an outage.
  it("dates the herd it keeps under a refusal, once, in the banner", async () => {
    await underBanner({ ...data, error: true, authError: true, lastSeenAt: Date.now() - 3 * 60_000 });
    expect(headline()).toBe("1 thread needs you");
    expect(screen.getAllByText(/Last synced/)).toHaveLength(1);
    expect(screen.getByRole("alert")).toHaveTextContent(/Last synced \d/);
  });

  it("says why the composer is locked the moment Herdr goes down, before the outage is sustained", async () => {
    const { update, main } = await setup();
    await update({ ...data, bridge: "disconnected" });
    const box = main.getByRole("textbox", { name: "Task for a new agent" });
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute("placeholder", "Reconnect to start an agent");
  });

  it("says why the composer is locked on a read-only device", async () => {
    const { main } = await setup({ ...data, device: { enforced: true, device: "phone", authorized: false } });
    const box = main.getByRole("textbox", { name: "Task for a new agent" });
    expect(box).toBeDisabled();
    expect(box).toHaveAttribute("placeholder", "Read-only — device not authorised");
  });

  // Safari sizes the box by its value, not its placeholder, so a placeholder that wraps at 375 px is
  // cut in half. The Send to chip already names the project, so the box only says what to do.
  it("keeps the coordinator's placeholder short, whatever the project is called, locked or not", async () => {
    const long = { ...projectData, projects: projectData.projects!.map((p) => ({ ...p, name: "AWAM Comercio SaaS: plataforma mayorista multi-sucursal" })) };
    const { update, main } = await setup(long);
    const box = main.getByRole("textbox", { name: /^Message for AWAM/ });
    expect(box).toHaveAttribute("placeholder", "Ask the coordinator…");
    await update({ ...long, bridge: "disconnected" });
    expect(box).toHaveAttribute("placeholder", "Reconnect to ask the coordinator");
  });

  it("tells each Needs you card the real reason answers are paused", async () => {
    server.use(http.get("/api/interactions", () => HttpResponse.json({ interactions: [permission] })));
    const { update, main } = await setup();
    await main.findByText("Do you want to proceed?");
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
  expect(main.getByRole("button", { name: "Start" })).toBeDisabled();
  const needs = within(main.getByRole("region", { name: /^Needs you/ }));
  // The card says why, and lists what the agent offers with nothing to press.
  expect(await needs.findByText("Read-only on this device. Answer from an authorised one.")).toBeVisible();
  expect(needs.queryByRole("button", { name: "Yes" })).not.toBeInTheDocument();
  expect(within(needs.getByRole("list", { name: "Options" })).getByText("Yes")).toBeVisible();
  expect(needs.getByRole("button", { name: /open thread/i })).toBeEnabled();
  const recent = within(main.getByRole("region", { name: /^Recent/ }));
  expect(recent.getByRole("link", { name: /^Earlier thread/ })).toHaveAttribute("href", "/pane/w1%3Ap1?s=work");
});
