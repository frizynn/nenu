import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { vi } from "vitest";

import type { ProjectThreadView, ProjectView } from "@/lib/types";
import { server } from "@/test/setup";
import { ProjectTasks, coordinatedThreads, prSummary, threadDetail, threadTree } from "./project-tasks";

const project: ProjectView = {
  slug: "hub", name: "Hub", goal: "Ship it", status: "active",
  coordinator: { paneId: "c", agent: "claude", liveStatus: "working" },
  threads: [
    { id: "T1", title: "Build", parentId: "root", role: "worker", status: "open", paneId: "a", agent: "codex", liveStatus: "blocked" },
    { id: "T0", title: "Audit", parentId: "root", role: "worker", status: "resolved" },
  ],
};

function setup(overrides: Partial<Parameters<typeof ProjectTasks>[0]> = {}) {
  const props = { project, panes: [], session: "work", currentPaneId: "a", readOnly: false, onOpenPane: vi.fn(), onOpenNode: vi.fn(), onChanged: vi.fn(), ...overrides };
  render(<ProjectTasks {...props} />);
  return { ...props, user: userEvent.setup() };
}

it("lists the coordinator, then the open threads, with the resolved ones folded into History", async () => {
  const { user, onOpenPane } = setup();
  expect(screen.getByRole("heading", { name: "Hub" })).toBeInTheDocument();
  expect(screen.getByText("Ship it")).toBeInTheDocument();
  const build = screen.getByRole("button", { name: /^Build/ });
  expect(build).toHaveTextContent("Asked you a question");
  expect(build.closest("li")).toHaveAttribute("aria-current", "true");
  expect(screen.getByRole("button", { name: /^History/ })).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("Audit")).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /^Coordinator/ }));
  expect(onOpenPane).toHaveBeenCalledWith("c");
});

it("heads the project with its own glyph, and a coordinator's scope with its title alone", () => {
  setup();
  const glyph = () => document.querySelector(".project-tasks header svg[data-glyph]");
  expect(glyph()).toHaveAttribute("data-glyph", "orbit");
  expect(glyph()).toHaveAttribute("width", "20");
  document.body.innerHTML = "";
  setup({ project: { ...project, icon: "flag", tone: "red" } });
  expect(glyph()).toHaveAttribute("data-glyph", "flag");
  expect((glyph() as SVGElement).style.color).toBe("var(--glyph-red)");
  document.body.innerHTML = "";
  setup({ title: "Checkout redesign" });
  expect(glyph()).toBeNull();
});

it("marks the project coordinator's row You're here when its chat is the one on screen", () => {
  setup({ currentPaneId: "c" });
  const own = screen.getByRole("button", { name: /^Coordinator/ });
  expect(own).toHaveTextContent("You're here · claude");
  expect(own.closest("li")).toHaveAttribute("aria-current", "true");
});

it("sums up a pull request as far as Organizations reported it", () => {
  expect(prSummary({ number: 7, state: "open", review: "approved", checks: { passed: 6, failed: 0, pending: 0 } })).toBe("PR #7 · approved · checks passed");
  expect(prSummary({ number: 7, state: "open", checks: { passed: 4, failed: 0, pending: 2 } })).toBe("PR #7 · checks 4/6");
  expect(prSummary({ number: 7, state: "merged" })).toBe("PR #7 merged");
});

it("scopes a coordinator to the threads it runs", () => {
  const tree: ProjectView = { ...project, threads: [
    { id: "C", title: "Coord", parentId: "root", role: "coordinator", status: "open" },
    { id: "W1", title: "W1", parentId: "C", role: "worker", status: "open" },
    { id: "W2", title: "W2", parentId: "root", role: "worker", status: "open" },
    { id: "O", title: "Orphan", parentId: "gone", role: "worker", status: "open" },
  ] };
  expect(coordinatedThreads(tree, "C").map((t) => t.id)).toEqual(["W1"]);
  expect(coordinatedThreads(tree).map((t) => t.id)).toEqual(["C", "W2", "O"]);
  // Lists and counts at a coordinator cover what its own threads run too.
  expect(threadTree(tree).map((t) => t.id)).toEqual(["C", "W1", "W2", "O"]);
  expect(threadTree(tree, "C").map((t) => t.id)).toEqual(["W1"]);
});

it("closes a thread only after the in-app confirmation", async () => {
  let posted: unknown;
  server.use(http.post("/api/org/node/resolve", async ({ request }) => { posted = await request.json(); return HttpResponse.json({ ok: true }); }));
  const { user, onChanged } = setup();

  await user.click(screen.getByRole("button", { name: "Close Build" }));
  const dialog = screen.getByRole("dialog", { name: "Close this thread?" });
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(posted).toBeUndefined();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Close Build" }));
  await user.click(screen.getByRole("button", { name: "Close thread" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(posted).toEqual({ project: "hub", id: "T1" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("keeps the dialog open with the bridge's reason when closing fails", async () => {
  server.use(http.post("/api/org/node/resolve", () => HttpResponse.json({ ok: false, error: "Worktree is dirty." }, { status: 409 })));
  const { user, onChanged } = setup();
  await user.click(screen.getByRole("button", { name: "Close Build" }));
  await user.click(screen.getByRole("button", { name: "Close thread" }));
  expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("Worktree is dirty.");
  expect(onChanged).not.toHaveBeenCalled();
});

it("offers no close or new thread on a read-only device", () => {
  setup({ readOnly: true });
  expect(screen.queryByRole("button", { name: "Close Build" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Build actions" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "New thread" })).not.toBeInTheDocument();
});

it("hands the keyboard to the first row Show more brought, even when the button goes with it", async () => {
  const resolved = Array.from({ length: 25 }, (_, i): ProjectThreadView => ({ id: `R${i + 1}`, title: `Done ${i + 1}`, parentId: "root", role: "worker", status: "resolved" }));
  const { user } = setup({ project: { ...project, threads: resolved } });
  await user.click(screen.getByRole("button", { name: /^History/ }));
  const history = screen.getByRole("list", { name: "History" });
  expect(history.children).toHaveLength(20);
  screen.getByRole("button", { name: "Show 5 more" }).focus();
  await user.keyboard("{Enter}");
  expect(history.children).toHaveLength(25);
  expect(screen.queryByRole("button", { name: /^Show \d+ more/ })).not.toBeInTheDocument();
  expect(document.activeElement).toBe(history.children[20]!.querySelector(".task-main"));
});

describe("closing is never a check", () => {
  /** A device by its media features: a query matches when one of its comma-separated parts matches every feature it names. */
  const original = window.matchMedia;
  function device(features: Record<string, string>) {
    const matches = (query: string) => query.split(",").some((part) => [...part.matchAll(/\(([\w-]+):\s*([\w-]+)\)/g)].every(([, name, value]) => features[name!] === value));
    window.matchMedia = ((query: string) => ({ matches: matches(query), media: query, onchange: null, addEventListener: () => {},
      removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
  }
  /** A phone or tablet: the pointer is coarse, so there is no hover to reveal a row's actions. */
  const touchScreen = () => device({ hover: "none", pointer: "coarse" });
  afterEach(() => { window.matchMedia = original; });

  // A pen or a TV remote points finely and cannot hover: a word that waits for hover would never show.
  it("gives a screen that cannot hover the ⋯, whatever its pointer", () => {
    device({ hover: "none", pointer: "fine" });
    setup();
    expect(screen.getByRole("button", { name: "Build actions" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close Build" })).not.toBeInTheDocument();
  });

  it("names Close on an open row on a desk, and keeps the check for resolved work", async () => {
    const { user } = setup();
    const close = screen.getByRole("button", { name: "Close Build" });
    expect(close).toHaveTextContent("Close");
    expect(close.closest("li")!.querySelector('[data-node-state="resolved"]')).toBeNull();
    await user.click(screen.getByRole("button", { name: /^History/ }));
    expect(screen.getByRole("button", { name: /^Audit/ }).querySelector('[data-node-state="resolved"]')).not.toBeNull();
  });

  it("closes from the row's ⋯ on a touch screen, and still asks first", async () => {
    touchScreen();
    let posted: unknown;
    server.use(http.post("/api/org/node/resolve", async ({ request }) => { posted = await request.json(); return HttpResponse.json({ ok: true }); }));
    const { user, onOpenPane } = setup();
    expect(screen.queryByRole("button", { name: "Close Build" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Build actions" }));
    const sheet = screen.getByRole("dialog", { name: "Build" });
    await user.click(within(sheet).getByRole("button", { name: "Open chat" }));
    expect(onOpenPane).toHaveBeenCalledWith("a");
    expect(screen.queryByRole("dialog", { name: "Build" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Build actions" }));
    await user.click(within(screen.getByRole("dialog", { name: "Build" })).getByRole("button", { name: "Close thread…" }));
    expect(screen.queryByRole("dialog", { name: "Build" })).not.toBeInTheDocument();
    const confirm = screen.getByRole("dialog", { name: "Close this thread?" });
    expect(posted).toBeUndefined();
    await user.click(within(confirm).getByRole("button", { name: "Close thread" }));
    await waitFor(() => expect(posted).toEqual({ project: "hub", id: "T1" }));
  });

  it("offers no ⋯ on a read-only touch screen", () => {
    touchScreen();
    setup({ readOnly: true, project: { ...project, nodeActions: true } });
    expect(screen.queryByRole("button", { name: /actions$/ })).not.toBeInTheDocument();
  });

  it("replaces the project coordinator from its ⋯ on a touch screen", async () => {
    touchScreen();
    const { user } = setup({ project: { ...project, nodeActions: true } });
    await user.click(screen.getByRole("button", { name: "Coordinator actions" }));
    await user.click(within(screen.getByRole("dialog", { name: "Coordinator" })).getByRole("button", { name: "Replace coordinator…" }));
    expect(await screen.findByRole("dialog", { name: "Replace the coordinator?" })).toBeInTheDocument();
  });
});

describe("one organization, the way Herdr Organizations draws it", () => {
  const NOW = Date.parse("2026-10-10T14:00:00Z");
  const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
  const node = (id: string, title: string, parentId: string, extra: Partial<ProjectThreadView> = {}): ProjectThreadView =>
    ({ id, title, parentId, role: "worker", status: "open", ...extra });
  const org: ProjectView = {
    slug: "acme", name: "Acme", status: "active", nodeActions: true,
    coordinator: { paneId: "c", agent: "claude", liveStatus: "working" },
    threads: [
      node("t-1", "Hotfix", "root", { group: "idle", updated: ago(30) }),
      node("t-2", "Mobile", "root", { role: "coordinator", paneId: "mob", liveStatus: "idle" }),
      node("t-3", "Landing", "t-2", { paneId: "land", liveStatus: "working" }),
      node("t-4", "Mercadería", "t-2", { group: "ready-for-review" }),
      node("t-5", "Checkout", "t-2", { role: "coordinator", group: "working" }),
      node("t-6", "Pagos", "t-5", { group: "idle" }),
      node("t-7", "Depot", "root", { paneId: "depot", liveStatus: "blocked" }),
      node("t-8", "Stock", "root", { role: "coordinator", group: "waiting-on-you" }),
      node("t-10", "Old plan", "root", { role: "coordinator", status: "resolved", updated: ago(3000) }),
      node("t-11", "Old step", "t-10", { status: "resolved", updated: ago(3010) }),
      node("t-12", "Recent fix", "root", { status: "resolved", updated: ago(60) }),
      node("t-13", "Older fix", "root", { status: "resolved", updated: ago(5000) }),
      node("t-14", "Styles", "t-2", { status: "resolved", updated: ago(40) }),
      node("t-15", "Newer plan", "root", { role: "coordinator", status: "resolved", updated: ago(100) }),
    ],
  };
  /** The titles of a list's own items, not of the ones nested inside them. */
  const titles = (list: HTMLElement) => [...list.children].map((item) => item.querySelector(".task-main .font-medium")?.textContent);
  function show(overrides: Partial<Parameters<typeof ProjectTasks>[0]> = {}) {
    const props = { project: org, panes: [], session: "work", currentPaneId: "c", readOnly: false, onOpenPane: vi.fn(), onOpenNode: vi.fn(), onChanged: vi.fn(), now: NOW, ...overrides };
    const view = render(<ProjectTasks {...props} />);
    return { ...props, view, user: userEvent.setup() };
  }

  it("lists only what is open, as a tree: coordinators first, then needs you, review, working, idle", () => {
    show();
    const open = screen.getByRole("list", { name: "Open threads" });
    expect(titles(open)).toEqual(["Stock", "Mobile", "Depot", "Hotfix"]);
    expect(titles(within(open).getByRole("list", { name: "Mobile threads" }))).toEqual(["Checkout", "Mercadería", "Landing"]);
    expect(titles(within(open).getByRole("list", { name: "Checkout threads" }))).toEqual(["Pagos"]);
    for (const title of ["Old plan", "Recent fix", "Styles"]) expect(within(open).queryByText(title)).not.toBeInTheDocument();
  });

  it("keeps everything resolved in one grey History tree, closed, each coordinator folding the threads it ran", async () => {
    const { user, view } = show();
    const toggle = screen.getByRole("button", { name: /^History/ });
    expect(toggle).toHaveTextContent("History · 2 coordinators, 4 threads");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("Recent fix")).not.toBeInTheDocument();

    await user.click(toggle);
    const history = screen.getByRole("list", { name: "History" });
    // Coordinators first, the newest first within each kind.
    expect(titles(history)).toEqual(["Newer plan", "Old plan", "Styles", "Recent fix", "Older fix"]);
    expect(screen.queryByText("Old step")).not.toBeInTheDocument();
    await user.click(within(history).getByRole("button", { name: "Old plan threads" }));
    expect(titles(within(history).getByRole("list", { name: "Old plan threads" }))).toEqual(["Old step"]);
    // Resolved work is grey and has nothing to close; nothing in the tree is green.
    expect(within(history).queryByRole("button", { name: /^Close/ })).not.toBeInTheDocument();
    expect(view.container.querySelector(".bg-status-done, .text-status-done")).toBeNull();
  });

  it("pages a long History twenty rows at a time", async () => {
    const resolved = Array.from({ length: 45 }, (_, i) => node(`r-${i}`, `Fix ${i + 1}`, "root", { status: "resolved", updated: ago(i + 1) }));
    const { user } = show({ project: { ...org, threads: resolved } });
    await user.click(screen.getByRole("button", { name: /^History/ }));
    const rows = () => screen.getByRole("list", { name: "History" }).children;
    expect(rows()).toHaveLength(20);
    await user.click(screen.getByRole("button", { name: "Show 20 more" }));
    expect(rows()).toHaveLength(40);
    await user.click(screen.getByRole("button", { name: "Show 5 more" }));
    expect(rows()).toHaveLength(45);
    expect(screen.queryByRole("button", { name: /^Show \d+ more/ })).not.toBeInTheDocument();
  });

  it("opens History as far as the resolved thread whose chat is on screen", () => {
    const resolved = Array.from({ length: 45 }, (_, i) => node(`r-${i}`, `Fix ${i + 1}`, "root", { status: "resolved", updated: ago(i + 1), ...(i === 29 && { paneId: "old" }) }));
    show({ project: { ...org, threads: resolved }, currentPaneId: "old" });
    const history = within(screen.getByRole("list", { name: "History" }));
    expect(history.getByRole("button", { name: /^Fix 30/ }).closest("li")).toHaveAttribute("aria-current", "true");
  });

  it("opens a live node's chat and any other node's detail, never somewhere else", async () => {
    const { user, onOpenPane, onOpenNode } = show();
    await user.click(screen.getByRole("button", { name: /^Depot/ }));
    expect(onOpenPane).toHaveBeenCalledWith("depot");
    await user.click(screen.getByRole("button", { name: /^Hotfix/ }));
    expect(onOpenNode).toHaveBeenCalledWith("t-1");
    await user.click(screen.getByRole("button", { name: /^History/ }));
    await user.click(screen.getByRole("button", { name: /^Recent fix/ }));
    expect(onOpenNode).toHaveBeenLastCalledWith("t-12");
  });

  it("refuses to close a coordinator that still runs open work, and says why", async () => {
    let posted = false;
    server.use(http.post("/api/org/node/resolve", () => { posted = true; return HttpResponse.json({ ok: true }); }));
    const { user } = show();
    await user.click(screen.getByRole("button", { name: "Close Mobile" }));
    const dialog = screen.getByRole("dialog", { name: "Close its work first" });
    expect(dialog).toHaveTextContent("Mobile still has 3 open under it.");
    expect(within(dialog).queryByRole("button", { name: /^Close/ })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "OK" }));
    expect(posted).toBe(false);
    // A coordinator with nothing open under it closes like a thread.
    await user.click(screen.getByRole("button", { name: "Close Stock" }));
    expect(screen.getByRole("dialog", { name: "Close this coordinator?" })).toBeInTheDocument();
  });

  it("keeps the project coordinator listed in its own chat, where it can be replaced with another agent", async () => {
    let posted: unknown;
    server.use(
      http.post("/api/org/coordinator/replace", async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ ok: true, message: "stopped 1 coordinator agent(s) and started a new one on codex" });
      }),
    );
    const { user, onChanged } = show();
    const coordinator = screen.getByRole("button", { name: /^Coordinator/ });
    expect(coordinator.closest("li")).toHaveAttribute("aria-current", "true");
    expect(screen.queryByRole("button", { name: "Close Coordinator" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Replace coordinator" }));
    const dialog = await screen.findByRole("dialog", { name: "Replace the coordinator?" });
    // The running coordinator's harness is the one preselected.
    expect(await within(dialog).findByRole("radio", { name: "Claude Code" })).toBeChecked();
    await user.click(within(dialog).getByRole("radio", { name: "Codex" }));
    await user.click(within(dialog).getByRole("button", { name: "Replace" }));
    await waitFor(() => expect(posted).toEqual({ project: "acme", harness: "codex" }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

it("a thread waiting for your reply says so instead of its terminal's state, and opens its chat", async () => {
  const waiting: ProjectView = { ...project, threads: [
    { id: "T2", title: "Copy", parentId: "root", role: "worker", status: "open", paneId: "b", agent: "claude", liveStatus: "idle", group: "waiting-on-you", note: "idle", selfWaiting: true },
  ] };
  const { user, onOpenPane } = setup({ project: waiting, panes: [{ paneId: "b", terminalTitle: "Copy brief" } as never] });
  const row = screen.getByRole("button", { name: /^Copy/ });
  expect(row).toHaveTextContent("Waiting for your reply");
  expect(row).not.toHaveTextContent("Copy brief");
  await user.click(row);
  expect(onOpenPane).toHaveBeenCalledWith("b");
});

it("says a thread whose pull request merged closes on its own, with its number", () => {
  const thread: ProjectThreadView = { id: "t-9", title: "Copy", parentId: "root", role: "worker", status: "open", group: "ready-for-review", pr: { state: "merged", number: 9 } };
  expect(threadDetail(thread, [])).toBe("Merged, closes on its own · PR #9");
});
