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
  const panel = screen.getByRole("region", { name: "Needs you" });
  const ask = within(panel).getByRole("button", { name: /^Payments webhook/ });
  expect(ask).toHaveTextContent("Asked you a question");
  expect(ask).toHaveTextContent("4m");
  await user.click(ask);
  expect(source.onOpenPane).toHaveBeenCalledWith("w9:p1");

  await user.click(within(await row()).getByRole("button", { name: "Working, 1" }));
  const work = screen.getByRole("region", { name: "Working" });
  expect(within(work).getByRole("button", { name: /^Shipping estimates/ })).toHaveTextContent("Reading the carrier API");
  await user.click(within(work).getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("region", { name: "Working" })).not.toBeInTheDocument();
});

it("keeps everything the PR bar offered behind PRs: Merge with its confirmation, the checks and the automation", async () => {
  let posted: unknown;
  server.use(http.post("/api/org/thread/set", async ({ request }) => {
    posted = await request.json();
    return HttpResponse.json({ ok: true, flags: { id: own.id, autoFixCi: true, autoMerge: true } });
  }));
  const { user, source } = renderChat();
  await user.click(within(await row()).getByRole("button", { name: "PRs, 2" }));
  const panel = screen.getByRole("region", { name: "Pull requests" });
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
  const panel = screen.getByRole("region", { name: "Pull requests" });
  expect(within(panel).getByRole("button", { name: "Fix CI Checkout flow" })).toHaveTextContent(/^Fix CI$/);
  expect(within(panel).getByRole("button", { name: "Merge Cart badge" })).toHaveTextContent(/^Merge$/);
  expect(within(panel).getByRole("button", { name: "Create PR Login hotfix" })).toHaveTextContent(/^Create PR$/);
});

it("closes the panel with Escape and hands focus back to its chip", async () => {
  const { user } = renderChat();
  const prs = within(await row()).getByRole("button", { name: "PRs, 2" });
  await user.click(prs);
  within(screen.getByRole("region", { name: "Pull requests" })).getByRole("button", { name: "Close" }).focus();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("region", { name: "Pull requests" })).not.toBeInTheDocument();
  expect(prs).toHaveFocus();
});

it("says under the box which branch and which machine the chat runs on", async () => {
  renderChat();
  const place = await screen.findByRole("group", { name: "Message tools" });
  expect(within(place).getByText("checkout-coupon")).toBeInTheDocument();
  expect(within(place).getByText(window.location.hostname)).toBeInTheDocument();
});

it("keeps every chip still: nothing in the row animates on its own", async () => {
  renderChat();
  const chips = await row();
  await act(async () => {});
  expect(chips.querySelectorAll('[class*="animate-"]')).toHaveLength(0);
});

// They took two lines for two things that fit in one: the chips, then Stop alone on the row under them.
it("puts the chips and Stop on one line above the box, Stop at its end", async () => {
  renderChat();
  const chips = await row();
  const stop = screen.getByRole("group", { name: "Agent working" });
  expect(within(stop).getByRole("button", { name: "Stop" })).toBeVisible();
  expect(stop.parentElement).toBe(chips.parentElement);
  expect(chips.compareDocumentPosition(stop) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
  // Two of three listen: the count is what is switched on.
  const chip = await within(await row()).findByRole("button", { name: "Routines, 2" });
  expect(reads).toEqual(["acme-shop"]);
  await user.click(chip);
  const panel = screen.getByRole("region", { name: "Routines" });
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
