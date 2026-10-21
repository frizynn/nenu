import type { ComponentProps } from "react";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { fixtureAgents } from "@/test/handlers";
import { server } from "@/test/setup";
import type { ProjectThreadView, ProjectView } from "@/lib/types";
import { AgentChat } from "./agent-chat";
import type { ProjectChipsSource } from "./composer-chips";

// The row above a project chat's composer: what needs you, what works and the open pull requests of
// the threads around it, each a chip whose panel opens over the row; and under the box, where the chat
// runs. It takes the place of the PR bar, so nothing that bar offered may go missing.

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const agent = { ...fixtureAgents[0]!, status: "working" as const, hasSession: true };
const own: ProjectThreadView = {
  id: "t-12", title: "Checkout flow", parentId: "t-10", role: "worker", status: "open", paneId: agent.paneId, liveStatus: "working",
  group: "working", branch: "checkout-coupon", autoFixCi: true, autoMerge: false, updated: minutesAgo(1),
  pr: { number: 42, url: "https://github.com/acme/shop/pull/42", state: "open", checks: { passed: 4, failed: 0, pending: 2 }, mergeBlocker: "checks pending" },
};
const threads: ProjectThreadView[] = [
  own,
  { id: "t-11", title: "Payments webhook", parentId: "t-10", role: "worker", status: "open", paneId: "w9:p1", liveStatus: "blocked", group: "waiting-on-you", updated: minutesAgo(4) },
  { id: "t-13", title: "Shipping estimates", parentId: "t-10", role: "worker", status: "open", paneId: "w9:p2", liveStatus: "working", group: "working", note: "Reading the carrier API", updated: minutesAgo(9) },
  { id: "t-14", title: "Cart badge", parentId: "t-10", role: "worker", status: "open", group: "ready-for-review", updated: minutesAgo(12),
    pr: { number: 41, state: "open", review: "approved", checks: { passed: 6, failed: 0, pending: 0 }, mergeBlocker: null } },
  { id: "t-01", title: "Search index", parentId: "t-10", role: "worker", status: "resolved", group: "resolved", updated: minutesAgo(3000) },
];
const project: ProjectView = { slug: "acme-shop", name: "Acme Shop", status: "active", threads, prActions: true };

beforeAll(() => { if (!Element.prototype.scrollTo) Element.prototype.scrollTo = () => {}; });
beforeEach(() => {
  server.use(
    http.get(/\/api\/pane\/[^/]+\/subagents$/, () => HttpResponse.json({ available: true, sessionKey: "k", agents: [], truncated: false })),
    http.get(/\/api\/pane\/[^/]+\/activity$/, () => HttpResponse.json({ available: true, sessionKey: "k", workflows: [], tasks: [], artifacts: [] })),
    http.get("/api/org/routines", () => HttpResponse.json({ ok: true, available: false, routines: [], broken: 0 })),
  );
});

function renderChat(chips: Partial<ProjectChipsSource> = {}, overrides: Partial<ComponentProps<typeof AgentChat>> = {}) {
  const source: ProjectChipsSource = { project, thread: own, threads, readOnly: false, onOpenPane: vi.fn(), onOpenNode: vi.fn(), onChanged: vi.fn(), ...chips };
  const props: ComponentProps<typeof AgentChat> = {
    paneId: agent.paneId, agent, agents: [agent], shellPanes: [], tabs: [], text: "", onBack: vi.fn(), onSelect: vi.fn(),
    project: { slug: project.slug, name: project.name, role: "worker" }, projectChips: source, ...overrides,
  };
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <AgentChat {...props} /> }])} />);
  return { user: userEvent.setup(), source };
}

const row = () => screen.findByRole("group", { name: "Status" });

it("counts who needs you, what works and the open PRs around the thread, never the thread itself", async () => {
  renderChat();
  const chips = within(await row()).getAllByRole("button");
  expect(chips.map((chip) => chip.getAttribute("aria-label"))).toEqual(["Needs you, 1", "Working, 1", "PRs, 2"]);
  // The PR bar it replaces is gone.
  expect(screen.queryByRole("button", { name: /^CI .*checks$/ })).not.toBeInTheDocument();
});

it("opens a chip's panel over the row, lists its threads and opens the one tapped", async () => {
  const { user, source } = renderChat();
  const needs = within(await row()).getByRole("button", { name: "Needs you, 1" });
  await user.click(needs);
  expect(needs).toHaveAttribute("aria-expanded", "true");
  const panel = screen.getByRole("dialog", { name: "Needs you" });
  const ask = within(panel).getByRole("button", { name: /^Payments webhook/ });
  expect(ask).toHaveTextContent("Asked you a question");
  expect(ask).toHaveTextContent("4m");
  await user.click(ask);
  expect(source.onOpenPane).toHaveBeenCalledWith("w9:p1");

  await user.click(within(await row()).getByRole("button", { name: "Working, 1" }));
  const work = screen.getByRole("dialog", { name: "Working" });
  expect(within(work).getByRole("button", { name: /^Shipping estimates/ })).toHaveTextContent("Reading the carrier API");
  await user.click(within(work).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog", { name: "Working" })).not.toBeInTheDocument();
});

it("keeps everything the PR bar offered behind PRs: Merge with its confirmation, the checks and the automation", async () => {
  let posted: unknown;
  server.use(http.post("/api/org/thread/set", async ({ request }) => {
    posted = await request.json();
    return HttpResponse.json({ ok: true, flags: { id: own.id, autoFixCi: true, autoMerge: true } });
  }));
  const { user, source } = renderChat();
  await user.click(within(await row()).getByRole("button", { name: "PRs, 2" }));
  const panel = screen.getByRole("dialog", { name: "Pull requests" });
  expect(within(panel).getByRole("link", { name: "#42" })).toHaveAttribute("href", own.pr!.url);
  expect(within(panel).getByText("checkout-coupon")).toBeInTheDocument();
  expect(within(panel).getByText("In progress").nextElementSibling).toHaveTextContent("2");
  expect(within(panel).getByText("Merge waits: checks pending")).toBeInTheDocument();
  expect(within(panel).getByRole("checkbox", { name: "Auto-fix CI & address comments" })).toBeChecked();
  await user.click(within(panel).getByRole("checkbox", { name: "Auto-merge when ready" }));
  await waitFor(() => expect(source.onChanged).toHaveBeenCalled());
  expect(posted).toEqual({ project: "acme-shop", id: own.id, autoMerge: true });
  // Merge stays a two-step action.
  await user.click(within(panel).getByRole("button", { name: "Merge Cart badge" }));
  expect(await screen.findByRole("dialog", { name: /Merge/ })).toBeVisible();
});

it("the PRs panel offers each PR's one button, and counts a pushed branch that waits for its PR", async () => {
  const pushed: ProjectThreadView = { id: "t-15", title: "Login hotfix", parentId: "t-10", role: "worker", status: "open", group: "idle", branch: "acme/login-hotfix", prAction: "create-pr", updated: minutesAgo(20) };
  const withActions = [...threads.map((thread) => thread.id === own.id ? { ...thread, prAction: "fix-ci" as const } : thread.id === "t-14" ? { ...thread, prAction: "merge" as const } : thread), pushed];
  const { user } = renderChat({ threads: withActions, project: { ...project, threads: withActions } });
  await user.click(within(await row()).getByRole("button", { name: "PRs, 3" }));
  const panel = screen.getByRole("dialog", { name: "Pull requests" });
  expect(within(panel).getByRole("button", { name: "Fix CI Checkout flow" })).toHaveTextContent(/^Fix CI$/);
  expect(within(panel).getByRole("button", { name: "Merge Cart badge" })).toHaveTextContent(/^Merge$/);
  expect(within(panel).getByRole("button", { name: "Create PR Login hotfix" })).toHaveTextContent(/^Create PR$/);
});

it("closes the panel with Escape and hands focus back to its chip", async () => {
  const { user } = renderChat();
  const prs = within(await row()).getByRole("button", { name: "PRs, 2" });
  await user.click(prs);
  within(screen.getByRole("dialog", { name: "Pull requests" })).getByRole("button", { name: "Close" }).focus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Pull requests" })).not.toBeInTheDocument();
  expect(prs).toHaveFocus();
});

/** A viewport whose queries match the ones named, as a phone (none) or a desk ("(min-width: 768px)", …). */
function setMedia(...matching: string[]) {
  window.matchMedia = ((query: string) => ({ matches: matching.includes(query), media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
}
const originalMatchMedia = window.matchMedia;
afterEach(() => { window.matchMedia = originalMatchMedia; });

const LONG_BRANCH = "fix/meli-contracargos-reintentos-webhook";

it("on a desk, says under the box which branch and which machine the chat runs on", async () => {
  setMedia("(min-width: 768px)");
  renderChat();
  const place = await screen.findByRole("group", { name: "Message tools" });
  expect(within(place).getByText("checkout-coupon")).toBeInTheDocument();
  expect(within(place).getByText(window.location.hostname)).toBeInTheDocument();
});

// At 390px the branch and the machine were cut mid-word ("fix/meli-contr…  r."): the row gives its
// width to the model and the context, and keeps where it runs one tap away, whole.
it("on a phone, keeps a long branch and the machine behind one tap, never cut in the row", async () => {
  setMedia("(pointer: coarse)");
  const thread = { ...own, branch: LONG_BRANCH };
  const { user } = renderChat({ thread, threads: threads.map((t) => (t.id === own.id ? thread : t)) });
  const place = await screen.findByRole("group", { name: "Message tools" });
  expect(within(place).queryByText(LONG_BRANCH)).not.toBeInTheDocument();
  const where = within(place).getByRole("button", { name: `Where this runs: ${LONG_BRANCH} on ${window.location.hostname}` });
  await user.click(where);
  const detail = screen.getByRole("dialog", { name: "Where this runs" });
  expect(within(detail).getByText(LONG_BRANCH)).toBeVisible();
  expect(within(detail).getByText(window.location.hostname)).toBeVisible();
});

it("floats the panel over the thread: the box and the conversation stay where they were", async () => {
  const { user } = renderChat();
  const chips = await row();
  const box = document.querySelector(".composer-box")!;
  const scroller = screen.getByRole("region", { name: "Live conversation" }).querySelector<HTMLElement>(".overflow-y-auto")!;
  scroller.scrollTop = 120;
  // The chips sit under the box, in the row the model is in; nothing of theirs is above the box.
  expect(screen.getByRole("group", { name: "Message tools" })).toContainElement(chips);
  const above = box.parentElement!.previousElementSibling;
  await user.click(within(chips).getByRole("button", { name: "Working, 1" }));
  const panel = screen.getByRole("dialog", { name: "Working" });
  // The panel is an overlay anchored to the box's dock, not a row of the composer.
  expect(panel.closest(".composer-dock")).toBe(box.closest(".composer-dock"));
  expect(box.parentElement!.previousElementSibling).toBe(above);
  expect(document.querySelector(".composer-box")).toBe(box);
  expect(scroller.scrollTop).toBe(120);
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Working" })).not.toBeInTheDocument();
  expect(document.querySelector(".composer-box")).toBe(box);
  expect(scroller.scrollTop).toBe(120);
});

it("closes the panel on a press outside it, and leaves focus where the press put it", async () => {
  const { user } = renderChat();
  await user.click(within(await row()).getByRole("button", { name: "Needs you, 1" }));
  expect(screen.getByRole("dialog", { name: "Needs you" })).toBeVisible();
  await user.click(screen.getByRole("textbox"));
  expect(screen.queryByRole("dialog", { name: "Needs you" })).not.toBeInTheDocument();
  expect(screen.getByRole("textbox")).toHaveFocus();
});

it("takes focus into the open panel, keeps Tab inside it, and Escape from its chip closes it too", async () => {
  const { user } = renderChat();
  const prs = within(await row()).getByRole("button", { name: "PRs, 2" });
  await user.click(prs);
  const panel = screen.getByRole("dialog", { name: "Pull requests" });
  expect(panel).toHaveFocus();
  const stops = within(panel).getAllByRole("button").concat(within(panel).queryAllByRole("link"), within(panel).queryAllByRole("checkbox"));
  for (let i = 0; i < stops.length + 2; i++) {
    await user.tab();
    expect(panel.contains(document.activeElement)).toBe(true);
  }
  await user.tab({ shift: true });
  expect(panel.contains(document.activeElement)).toBe(true);
  // Escape wherever focus sits, the chip included.
  prs.focus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog", { name: "Pull requests" })).not.toBeInTheDocument();
  expect(prs).toHaveFocus();
});

it("on a phone, Back closes the panel and stays on the chat; its own ✕ steps back over the entry it took", async () => {
  setMedia("(pointer: coarse)");
  const back = vi.spyOn(window.history, "back");
  const { user } = renderChat();
  const needs = within(await row()).getByRole("button", { name: "Needs you, 1" });
  const depth = window.history.length;
  await user.click(needs);
  expect(window.history.length).toBe(depth + 1);
  // The browser's Back: the entry under the panel's is the chat's own.
  const { nenuChipPanel: _, ...chat } = window.history.state as Record<string, unknown>;
  act(() => {
    window.history.replaceState(chat, "");
    window.dispatchEvent(new PopStateEvent("popstate", { state: chat }));
  });
  expect(screen.queryByRole("dialog", { name: "Needs you" })).not.toBeInTheDocument();
  expect(needs).toHaveFocus();
  expect(screen.getByRole("textbox")).toBeInTheDocument();
  expect(back).not.toHaveBeenCalled();
  // Opened again and closed with ✕: the panel takes its entry back with it.
  await user.click(needs);
  back.mockImplementation(() => {});
  await user.click(within(screen.getByRole("dialog", { name: "Needs you" })).getByRole("button", { name: "Close" }));
  expect(back).toHaveBeenCalledTimes(1);
  back.mockRestore();
});

it("folds the threads that ended under what still works, a step back from the live rows", async () => {
  const done: ProjectThreadView = { id: "t-02", title: "Old cart page", parentId: "t-10", role: "worker", status: "resolved", group: "resolved", updated: minutesAgo(300) };
  // Finished, its pull request waiting for the merge: nothing left to open, so it folds with them.
  const merging: ProjectThreadView = { id: "t-03", title: "Coupon banner", parentId: "t-10", role: "worker", status: "open", group: "awaiting-merge", updated: minutesAgo(200),
    pr: { number: 40, state: "open", checks: { passed: 2, failed: 0, pending: 0 }, mergeBlocker: "waiting for a review" } };
  const all = [...threads, done, merging];
  const { user, source } = renderChat({ threads: all, project: { ...project, threads: all } });
  await user.click(within(await row()).getByRole("button", { name: "Working, 1" }));
  const panel = screen.getByRole("dialog", { name: "Working" });
  // Live first; the resolved ones are not among them until their fold opens.
  expect(within(panel).getByRole("button", { name: /^Shipping estimates/ })).toBeVisible();
  expect(within(panel).queryByRole("button", { name: /^Old cart page/ })).not.toBeInTheDocument();
  expect(within(panel).queryByRole("button", { name: /^Coupon banner/ })).not.toBeInTheDocument();
  await user.click(within(panel).getByRole("button", { name: "Done (3)" }));
  expect(within(panel).getByRole("button", { name: /^Coupon banner/ })).toHaveClass("text-muted-foreground");
  const ended = within(panel).getByRole("button", { name: /^Old cart page/ });
  expect(ended).toHaveClass("text-muted-foreground");
  expect(within(panel).getByRole("button", { name: /^Search index/ })).toHaveClass("text-muted-foreground");
  // Newest first, and still one tap from its page.
  expect(ended.compareDocumentPosition(within(panel).getByRole("button", { name: /^Search index/ })) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await user.click(ended);
  expect(source.onOpenNode).toHaveBeenCalledWith("t-02");
});

it("raises no chip for threads that ended alone", async () => {
  const quietThreads = threads.filter((thread) => thread.id === own.id || thread.status === "resolved").map((thread) => ({ ...thread, pr: undefined }));
  renderChat({ threads: quietThreads, thread: { ...own, pr: undefined }, project: { ...project, threads: quietThreads } });
  await screen.findByRole("textbox");
  await act(async () => {});
  expect(screen.queryByRole("group", { name: "Status" })).not.toBeInTheDocument();
});

// Beside a project's resolved threads, the pages the session published still open unfolded: the menu
// row says Published, and that is what the panel opens on (ADR 0108).
it("opens Published from the ⋯ menu on its pages, beside the project's resolved threads", async () => {
  server.use(http.get(/\/api\/pane\/[^/]+\/activity$/, () => HttpResponse.json({ available: true, sessionKey: "k", workflows: [], tasks: [],
    artifacts: [{ id: "art_1", url: "https://claude.ai/code/artifact/00000000-test", title: "Cart redesign", icon: "canvas", version: "1-a", at: Date.now() }] })));
  const quietThreads = threads.filter((thread) => thread.id === own.id || thread.status === "resolved").map((thread) => ({ ...thread, pr: undefined }));
  const { user } = renderChat({ threads: quietThreads, thread: { ...own, pr: undefined }, project: { ...project, threads: quietThreads } });
  await user.click(screen.getByRole("button", { name: "Conversation actions" }));
  await user.click(await screen.findByRole("button", { name: "Published · 1" }));
  const panel = screen.getByRole("dialog", { name: "Published" });
  expect(within(panel).getByRole("button", { name: "Published (1)" })).toHaveAttribute("aria-expanded", "true");
  expect(within(panel).getByRole("link", { name: /Cart redesign/ })).toBeVisible();
});

it("keeps every chip still: nothing in the row animates on its own", async () => {
  renderChat();
  const chips = await row();
  await act(async () => {});
  expect(chips.querySelectorAll('[class*="animate-"]')).toHaveLength(0);
});

// Stop took a line of its own above the box (ADR 0108): it sits in the box, and the line holds chips only.
it("keeps Stop in the box beside Send, never on the chips' line", async () => {
  renderChat();
  const chips = await row();
  const stop = screen.getByRole("button", { name: "Stop" });
  expect(stop.closest(".composer-box")).not.toBeNull();
  expect(chips.contains(stop)).toBe(false);
});

it("draws no row for a chat with nothing around it", async () => {
  renderChat({ threads: [{ ...own, pr: undefined }], thread: { ...own, pr: undefined } });
  await screen.findByRole("textbox");
  await act(async () => {});
  expect(screen.queryByRole("group", { name: "Status" })).not.toBeInTheDocument();
});

it("lists the project's routines behind Routines, read when the chat opens and again on a tap, never on a timer", async () => {
  const reads: string[] = [];
  const hour = 3_600_000;
  server.use(http.get("/api/org/routines", ({ request }) => {
    reads.push(new URL(request.url).searchParams.get("project") ?? "");
    return HttpResponse.json({ ok: true, available: true, broken: 0, routines: [
      { name: "pr-followup", trigger: "pr", schedule: "", events: ["checks-failed", "review"], enabled: true, lastRun: "", nextRun: "" },
      { name: "nightly-deps", trigger: "schedule", schedule: "daily 03:00", events: [], enabled: true, lastRun: "", nextRun: new Date(Date.now() + 4 * hour + 90_000).toISOString() },
      { name: "weekly-report", trigger: "schedule", schedule: "every 7d", events: [], enabled: false, lastRun: "", nextRun: "" },
    ] });
  }));
  const { user } = renderChat();
  await waitFor(() => expect(reads).toEqual(["acme-shop"]));
  // They ask nothing of you here: off the line, one tap into the ⋯ menu (ADR 0108). Two of three
  // listen: the count is what is switched on.
  expect(within(await row()).queryByRole("button", { name: /^Routines/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "Conversation actions" }));
  await user.click(await screen.findByRole("button", { name: "Routines · 2" }));
  const panel = screen.getByRole("dialog", { name: "Routines" });
  const item = (name: string) => within(panel).getByText(name).closest("li")!;
  expect(item("pr-followup")).toHaveTextContent("on checks-failed, review");
  expect(item("pr-followup")).toHaveTextContent(/on$/);
  expect(item("nightly-deps")).toHaveTextContent("daily 03:00");
  expect(item("nightly-deps")).toHaveTextContent(/in 4h$/);
  expect(item("weekly-report")).toHaveTextContent(/off$/);
  await waitFor(() => expect(reads).toHaveLength(2));
});

it("draws no Routines chip while Organizations cannot list routines", async () => {
  renderChat();
  await row();
  await act(async () => {});
  expect(screen.queryByRole("button", { name: /^Routines/ })).not.toBeInTheDocument();
});
