import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { beforeEach, expect, it, vi } from "vitest";

import type { PaneDiff, ProjectThreadView } from "@/lib/types";
import { server } from "@/test/setup";
import { ThreadOverview, type ThreadOverviewProps } from "./thread-overview";

const NOW = Date.parse("2026-10-10T14:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const thread = (id: string, title: string, extra: Partial<ProjectThreadView> = {}): ProjectThreadView =>
  ({ id, title, parentId: "t-10", role: "worker", status: "open", ...extra });

const flow = thread("t-12", "Checkout flow", { paneId: "w1:p1", agent: "claude", liveStatus: "working", updated: ago(17) });
const siblings = [
  thread("t-11", "Payments webhook", { paneId: "w1:p2", liveStatus: "blocked", updated: ago(4) }),
  flow,
  thread("t-13", "Cart badge", { group: "ready-for-review", updated: ago(12) }),
  thread("t-09", "Search index", { status: "resolved" }),
];

const files = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `app/file-${i}.ts`, status: "modified" as const, additions: i + 1, deletions: 1 }));
let diff: PaneDiff;
let reads: string[];
beforeEach(() => {
  reads = [];
  diff = { ok: true, base: "main", head: "feat", source: "worktree", files: files(7), totals: { files: 7, additions: 28, deletions: 7 } };
  server.use(http.get("/api/pane/:id/diff", ({ request }) => {
    reads.push(new URL(request.url).searchParams.get("scope")!);
    return HttpResponse.json(diff);
  }));
});

function setup(overrides: Partial<ThreadOverviewProps> = {}) {
  const parent = { title: "Checkout redesign", open: vi.fn() };
  const props: ThreadOverviewProps = {
    thread: flow, paneId: "w1:p1", reading: { model: "claude-opus-5-5", contextPercent: 22 }, parent, coordinating: false,
    threads: siblings, onShowChanges: vi.fn(), onOpenThread: vi.fn(), now: NOW, ...overrides,
  };
  render(<ThreadOverview {...props} />);
  return { ...props, parent, user: userEvent.setup() };
}

it("says what this thread is: its state, who it answers to, its PR, its agent and its context", async () => {
  const { user, parent } = setup({ pr: { number: 42, title: "Checkout flow", url: "https://github.com/acme/shop/pull/42" } });
  const card = screen.getByRole("region", { name: "This thread" });
  expect(within(card).getByText("Working")).toBeInTheDocument();
  expect(within(card).getByText("· 17m")).toBeInTheDocument();
  expect(within(card).getByRole("link", { name: "#42" })).toHaveAttribute("href", "https://github.com/acme/shop/pull/42");
  expect(within(card).getByText("Claude Code · Opus 5.5")).toBeInTheDocument();
  expect(within(card).getByRole("progressbar", { name: "Context used" })).toHaveAttribute("aria-valuenow", "22");
  await user.click(within(card).getByRole("button", { name: /Checkout redesign/ }));
  expect(parent.open).toHaveBeenCalledOnce();
});

it("says a PR is not opened yet, and leaves out what the agent has not reported", () => {
  setup({ reading: {} });
  const card = screen.getByRole("region", { name: "This thread" });
  expect(within(card).getByText("Not opened yet")).toBeInTheDocument();
  expect(within(card).getByText("Claude Code")).toBeInTheDocument();
  expect(within(card).queryByText("Context")).not.toBeInTheDocument();
});

it("sums up the branch with its first files, and sends every tap to the Changes tab", async () => {
  const { user, onShowChanges } = setup();
  const card = screen.getByRole("region", { name: "Changes" });
  expect(await within(card).findByText("2 more files")).toBeInTheDocument();
  expect(within(card).getAllByRole("listitem")).toHaveLength(5);
  expect(within(card).getByRole("button", { name: /^Changes/ })).toHaveTextContent("+28 −7");
  expect(reads).toEqual(["branch"]);
  await user.click(within(card).getByRole("button", { name: /^Changes/ }));
  await user.click(within(card).getByRole("button", { name: /app\/file-0\.ts/ }));
  await user.click(within(card).getByText("2 more files"));
  expect(onShowChanges).toHaveBeenCalledTimes(3);
});

it("reads the branch again when the thread moves, keeping the last read on screen meanwhile", async () => {
  const props: ThreadOverviewProps = { thread: flow, paneId: "w1:p1", reading: {}, coordinating: false, threads: [], onShowChanges: vi.fn(), onOpenThread: vi.fn(), now: NOW };
  const { rerender } = render(<ThreadOverview {...props} />);
  const card = () => screen.getByRole("region", { name: "Changes" });
  expect(await within(card()).findByText("2 more files")).toBeInTheDocument();
  diff = { ...diff, files: files(6), totals: { files: 6, additions: 21, deletions: 6 } } as PaneDiff;
  rerender(<ThreadOverview {...props} thread={{ ...flow, updated: ago(1) }} />);
  // The last read stays while the next is on its way, never "Reading the branch…".
  expect(within(card()).getByText("2 more files")).toBeInTheDocument();
  expect(await within(card()).findByText("1 more file")).toBeInTheDocument();
  expect(reads).toEqual(["branch", "branch"]);
});

it("says when the branch changed nothing, and why it could not be read", async () => {
  diff = { ok: true, base: "main", head: "feat", source: "worktree", files: [], totals: { files: 0, additions: 0, deletions: 0 } };
  setup();
  expect(await screen.findByText("Nothing changed on this branch.")).toBeInTheDocument();
  document.body.innerHTML = "";
  diff = { ok: false, reason: "no-repo", message: "This folder is not a git repository." };
  setup();
  expect(await screen.findByText("This folder is not a git repository.")).toBeInTheDocument();
});

it("lists the coordinator's open threads, this one marked, each opening its own", async () => {
  const { user, onOpenThread, parent } = setup();
  const card = screen.getByRole("region", { name: "Coordinator Checkout redesign" });
  const rows = within(card).getAllByRole("listitem");
  expect(rows.map((row) => row.textContent)).toEqual(["Payments webhook4m", "Checkout flowthis one", "Cart badge12m"]);
  expect(rows[1]).toHaveAttribute("aria-current", "true");
  await user.click(within(card).getByRole("button", { name: /Cart badge/ }));
  expect(onOpenThread).toHaveBeenCalledWith(siblings[2]);
  await user.click(within(card).getByRole("button", { name: /^Open/ }));
  expect(parent.open).toHaveBeenCalledOnce();
});

it("on a coordinator's own pane, lists its threads with no way to open itself", () => {
  setup({ thread: { ...flow, id: "t-10", role: "coordinator" }, coordinating: true, threads: siblings });
  expect(screen.getByRole("region", { name: "This coordinator" })).toBeInTheDocument();
  const card = screen.getByRole("region", { name: "Threads" });
  expect(within(card).queryByRole("button", { name: /^Open/ })).not.toBeInTheDocument();
  expect(within(card).getAllByRole("listitem")).toHaveLength(3);
});

it("on the project coordinator's pane, names no coordinator above it", () => {
  setup({ thread: undefined, parent: undefined, coordinating: true,
    pane: { paneId: "w1:p1", agent: "codex", status: "idle" } as ThreadOverviewProps["pane"], reading: { model: "gpt-5.5" } });
  const card = screen.getByRole("region", { name: "This coordinator" });
  expect(within(card).queryByText("Coordinator")).not.toBeInTheDocument();
  expect(within(card).getByText("Idle")).toBeInTheDocument();
  expect(within(card).getByText("Codex · gpt-5.5")).toBeInTheDocument();
  expect(within(card).queryByText("Pull request")).not.toBeInTheDocument();
});
