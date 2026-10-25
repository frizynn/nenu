import { afterEach, expect, test } from "vitest";
import { act, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { http, HttpResponse } from "msw";
import { server } from "@/test/setup";
import { fakeLiveStream } from "@/test/live-stream";
import { resetLiveEvents } from "@/lib/live-events";
import fixture from "@/components/activity/activity.fixture.json";
import { fixtureAgents } from "@/test/handlers";
import type { AgentView } from "@/lib/types";
import type { ReviewEntry } from "@/lib/home-stats";
import { PullRequestList, useHomeActivity } from "./ready-to-review-list";

afterEach(() => resetLiveEvents());

// Home re-reads a pane's activity on every live event naming it; an answer equal to the one on screen
// must not hand Home a new map, or every re-read re-renders the whole page for nothing.
test("an unchanged re-read keeps Home's activity map; a changed one replaces it", async () => {
  let reads = 0;
  let body: typeof fixture.list = fixture.list;
  server.use(http.get("/api/pane/:id/activity", () => { reads++; return HttpResponse.json(body); }));
  const live = fakeLiveStream();
  live.open();
  const agents: AgentView[] = [{ ...fixtureAgents[0]!, paneId: "w1:p1", agent: "claude", hasSession: true }];
  const { result } = renderHook(() => useHomeActivity(agents));
  await waitFor(() => expect(result.current.get("w1:p1")).toEqual(fixture.list));
  const first = result.current;
  act(() => live.send({ topic: "activity", paneId: "w1:p1" }));
  await waitFor(() => expect(reads).toBe(2));
  await act(() => new Promise((r) => setTimeout(r, 10)));
  expect(result.current).toBe(first);
  body = { ...fixture.list, truncated: !fixture.list.truncated };
  act(() => live.send({ topic: "activity", paneId: "w1:p1" }));
  await waitFor(() => expect(result.current).not.toBe(first));
  live.stop();
});

// A diff is read from a live pane's folder (bridge/routes/diff.ts), so a size here is the PR's size
// and the row is one tap into it: its session in Nenu, else its page on GitHub.
test("a review row is one tap into its PR, its size read as text", () => {
  const entries: ReviewEntry[] = [
    { key: "a/b#7", title: "Fix", repo: "b", number: 7, draft: false, inUse: true, updatedAt: 0, diff: { additions: 5, deletions: 1 }, open: { paneId: "w1:p1" } },
    { key: "a/b#8", title: "Other", repo: "b", number: 8, draft: false, inUse: true, updatedAt: 0, diff: { additions: 9, deletions: 2 }, url: "https://github.com/a/b/pull/8" },
  ];
  render(<MemoryRouter><PullRequestList entries={entries} opening={null} /></MemoryRouter>);
  expect(screen.queryByRole("button", { name: /^View changes/ })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Fix, #7, +5 −1" })).toHaveAttribute("href", "/pane/w1%3Ap1");
  expect(screen.getByRole("link", { name: "Other, #8, +9 −2" })).toHaveAttribute("href", "https://github.com/a/b/pull/8");
});

// As in Recents, the rows "Show N more" adds ease in where they land; those already shown stay still.
test("eases in only the PRs Show N more adds", async () => {
  const entries: ReviewEntry[] = Array.from({ length: 7 }, (_, i) => (
    { key: `a/b#${i}`, title: `PR ${i}`, repo: "b", owner: "a", number: i, draft: false, inUse: true, updatedAt: 0, url: `https://github.com/a/b/pull/${i}` }));
  render(<MemoryRouter><PullRequestList entries={entries} opening={null} /></MemoryRouter>);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Show 4 more in b" }));
  expect(screen.getAllByRole("listitem").map((row) => row.classList.contains("row-enter"))).toEqual([false, false, false, true, true, true, true]);
  // And folds back from where it stands.
  await user.click(screen.getByRole("button", { name: "Show less of b" }));
  expect(screen.getAllByRole("listitem")).toHaveLength(3);
  expect(screen.getByRole("button", { name: "Show 4 more in b" })).toHaveTextContent("Show 4 more");
});

// A repo is a heading over its own PRs; a fold that would hide one row shows it instead.
test("lists each repo under its name, count and, unless it is the owner of most, its owner; the latest-moved repo first, its PRs in the order given", () => {
  const pr = (owner: string, repo: string, number: number, updatedAt: number): ReviewEntry => (
    { key: `${owner}/${repo}#${number}`, title: `${repo} ${number}`, repo, owner, number, draft: false, inUse: true, updatedAt, url: `https://github.com/${owner}/${repo}/pull/${number}` });
  render(<MemoryRouter><PullRequestList opening={null} entries={[
    pr("acme", "shop", 1, 10), pr("acme", "shop", 2, 50), pr("acme", "shop", 3, 30), pr("acme", "shop", 4, 20),
    pr("acme", "notes", 5, 40), pr("other", "shop", 6, 60),
  ]} /></MemoryRouter>);
  const runs = screen.getAllByRole("region");
  expect(runs.map((run) => run.querySelector("h3")?.textContent)).toEqual(["other/shop, 1 open", "shop, 4 open", "notes, 1 open"]);
  expect(runs.map((run) => [...run.querySelectorAll("li a")].map((link) => link.getAttribute("aria-label")))).toEqual([["shop 6, #6"], ["shop 1, #1", "shop 2, #2", "shop 3, #3", "shop 4, #4"], ["notes 5, #5"]]);
  expect(screen.queryByRole("button", { name: /^Show/ })).not.toBeInTheDocument();
});

// Two repos can share a name; the control names the one the heading names.
test("names another owner's repo as owner/name on its fold", () => {
  const entries: ReviewEntry[] = [
    ...Array.from({ length: 2 }, (_, i): ReviewEntry => ({ key: `me/shop#${i}`, title: `Mine ${i}`, repo: "shop", owner: "me", number: i, draft: false, inUse: true, updatedAt: 0 })),
    { key: "me/notes#9", title: "Notes", repo: "notes", owner: "me", number: 9, draft: false, inUse: true, updatedAt: 0 },
    ...Array.from({ length: 5 }, (_, i): ReviewEntry => ({ key: `acme/shop#${i}`, title: `Theirs ${i}`, repo: "shop", owner: "acme", number: i, draft: false, inUse: true, updatedAt: 0 })),
  ];
  render(<MemoryRouter><PullRequestList entries={entries} opening={null} /></MemoryRouter>);
  expect(screen.getByRole("button", { name: "Show 2 more in acme/shop" })).toBeInTheDocument();
});

// The PRs of repos no pane is in wait behind "Show all"; the filter is one menu and is kept on this device.
test("lists the PRs of the repos in use, says how many more there are, and filters them by state, repo or a search", async () => {
  const pr = (repo: string, number: number, extra: Partial<ReviewEntry> = {}): ReviewEntry => (
    { key: `acme/${repo}#${number}`, title: `${repo} ${number}`, repo, owner: "acme", number, draft: false, inUse: repo !== "notes", updatedAt: number, url: `https://github.com/acme/${repo}/pull/${number}`, ...extra });
  const entries = [pr("shop", 1, { draft: true }), pr("shop", 2, { checks: { passed: 0, failed: 1, pending: 0 } }), pr("api", 3), pr("notes", 4)];
  render(<MemoryRouter><PullRequestList entries={entries} opening={null} /></MemoryRouter>);
  const user = userEvent.setup();
  const headings = () => screen.queryAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
  expect(headings()).toEqual(["api, 1 open", "shop, 2 open"]);
  expect(screen.getByText("1 more in repos no pane is in")).toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Filter: In use" }));
  expect(screen.getAllByRole("menuitemradio").map((item) => [item.textContent, item.getAttribute("aria-checked")])).toEqual([["In use3", "true"], ["All repos4", "false"]]);
  expect(screen.getByRole("menuitemradio", { name: /^In use/ })).toHaveFocus();
  await user.click(screen.getByRole("menuitemcheckbox", { name: /^Needs attention/ }));
  // A tick keeps the menu open for the next one.
  await user.click(screen.getByRole("menuitemcheckbox", { name: /^Draft/ }));
  expect(screen.getByRole("button", { name: "Filter: In use, 2 more filters" })).toBeInTheDocument();
  expect(headings()).toEqual(["shop, 2 open"]);
  expect(screen.getByRole("status")).toHaveTextContent("2 of 3 PRs·Clear");
  expect(JSON.parse(localStorage.getItem("nenu:pr-filter:v1")!)).toEqual({ scope: "inUse", repos: [], states: ["attention", "draft"] });
  await user.click(screen.getByRole("menuitem", { name: "Clear filters" }));
  expect(screen.queryByRole("menu")).toBeNull();
  await user.click(screen.getByRole("button", { name: "Filter: In use" }));
  await user.click(screen.getByRole("menuitemcheckbox", { name: /^api/ }));
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(headings()).toEqual(["api, 1 open"]);

  await user.click(screen.getByRole("button", { name: "Clear" }));
  await user.type(screen.getByRole("searchbox", { name: /^Search pull requests/ }), "#2");
  expect(screen.getAllByRole("link").map((link) => link.getAttribute("aria-label"))).toEqual(["shop 2, #2, 1 check failing"]);
  await user.type(screen.getByRole("searchbox"), "9");
  expect(screen.getByText("No PR matches.")).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.getByRole("searchbox")).toHaveValue("");

  await user.click(screen.getByRole("button", { name: "Show all" }));
  expect(headings()).toEqual(["notes, 1 open", "api, 1 open", "shop, 2 open"]);
  expect(screen.queryByText(/more in repos no pane is in/)).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Filter: All repos" })).toBeInTheDocument();
});

test("with no PR in the repos in use, says so and offers all of them", async () => {
  const entries: ReviewEntry[] = [{ key: "a/b#1", title: "Elsewhere", repo: "b", owner: "a", number: 1, draft: false, inUse: false, updatedAt: 0, url: "https://github.com/a/b/pull/1" }];
  render(<MemoryRouter><PullRequestList entries={entries} opening={null} /></MemoryRouter>);
  expect(screen.getByText("No open PRs in the repos your panes are in.")).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "Show all 1" }));
  expect(screen.getByRole("link", { name: "Elsewhere, #1" })).toBeInTheDocument();
});

test("by keyboard, Clear filters closes the menu and hands the focus back to its button", async () => {
  const entries: ReviewEntry[] = [1, 2].map((number) => ({ key: `a/b#${number}`, title: `PR ${number}`, repo: "b", owner: "a", number, draft: number === 2, inUse: true, updatedAt: number, url: `https://github.com/a/b/pull/${number}` }));
  render(<MemoryRouter><PullRequestList entries={entries} opening={null} /></MemoryRouter>);
  const user = userEvent.setup();
  screen.getByRole("button", { name: "Filter: In use" }).focus();
  await user.keyboard("{ArrowDown}");
  expect(screen.getByRole("menuitemradio", { name: /^In use/ })).toHaveFocus();
  await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");
  expect(screen.getByRole("menuitemcheckbox", { name: /^Draft/ })).toHaveAttribute("aria-checked", "true");
  await user.keyboard("{ArrowDown}{Enter}");
  expect(screen.queryByRole("menu")).toBeNull();
  expect(screen.getByRole("button", { name: "Filter: In use" })).toHaveFocus();
});

test("a repo ticked under All is kept while In use leaves it out, and every repo ticked narrows nothing", async () => {
  const pr = (repo: string, number: number, inUse: boolean, extra: Partial<ReviewEntry> = {}): ReviewEntry => (
    { key: `a/${repo}#${number}`, title: `${repo} ${number}`, repo, owner: "a", number, draft: false, inUse, updatedAt: number, url: `https://github.com/a/${repo}/pull/${number}`, ...extra });
  localStorage.setItem("nenu:pr-filter:v1", JSON.stringify({ scope: "inUse", repos: ["a/notes"], states: [] }));
  render(<MemoryRouter><PullRequestList entries={[pr("shop", 1, true), pr("api", 2, true), pr("notes", 3, false), pr("notes", 4, false, { draft: true })]} opening={null} /></MemoryRouter>);
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: "Filter: In use" }));
  await user.click(screen.getByRole("menuitemcheckbox", { name: /^shop/ }));
  expect(JSON.parse(localStorage.getItem("nenu:pr-filter:v1")!).repos).toEqual(["a/notes", "a/shop"]);
  await user.click(screen.getByRole("menuitemcheckbox", { name: /^api/ }));
  // Both repos in use ticked: nothing is held back, and the button counts no filter.
  expect(screen.getByRole("button", { name: "Filter: In use" })).toBeInTheDocument();
  await user.click(screen.getByRole("menuitemcheckbox", { name: /^Draft/ }));
  await user.keyboard("{Escape}");
  // What All would add counts only what the filter lets through: one draft, and notes is still ticked.
  expect(screen.getByText("1 more in repos no pane is in")).toBeInTheDocument();
});
