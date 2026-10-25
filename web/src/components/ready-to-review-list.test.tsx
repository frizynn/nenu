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
    { key: "a/b#7", title: "Fix", repo: "b", number: 7, draft: false, updatedAt: 0, diff: { additions: 5, deletions: 1 }, open: { paneId: "w1:p1" } },
    { key: "a/b#8", title: "Other", repo: "b", number: 8, draft: false, updatedAt: 0, diff: { additions: 9, deletions: 2 }, url: "https://github.com/a/b/pull/8" },
  ];
  render(<MemoryRouter><PullRequestList entries={entries} opening={null} /></MemoryRouter>);
  expect(screen.queryByRole("button", { name: /^View changes/ })).not.toBeInTheDocument();
  expect(screen.getByRole("link", { name: "Fix, #7, +5 −1" })).toHaveAttribute("href", "/pane/w1%3Ap1");
  expect(screen.getByRole("link", { name: "Other, #8, +9 −2" })).toHaveAttribute("href", "https://github.com/a/b/pull/8");
});

// As in Recents, the rows "Show N more" adds ease in where they land; those already shown stay still.
test("eases in only the PRs Show N more adds", async () => {
  const entries: ReviewEntry[] = Array.from({ length: 7 }, (_, i) => (
    { key: `a/b#${i}`, title: `PR ${i}`, repo: "b", owner: "a", number: i, draft: false, updatedAt: 0, url: `https://github.com/a/b/pull/${i}` }));
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
    { key: `${owner}/${repo}#${number}`, title: `${repo} ${number}`, repo, owner, number, draft: false, updatedAt, url: `https://github.com/${owner}/${repo}/pull/${number}` });
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
    ...Array.from({ length: 2 }, (_, i): ReviewEntry => ({ key: `me/shop#${i}`, title: `Mine ${i}`, repo: "shop", owner: "me", number: i, draft: false, updatedAt: 0 })),
    { key: "me/notes#9", title: "Notes", repo: "notes", owner: "me", number: 9, draft: false, updatedAt: 0 },
    ...Array.from({ length: 5 }, (_, i): ReviewEntry => ({ key: `acme/shop#${i}`, title: `Theirs ${i}`, repo: "shop", owner: "acme", number: i, draft: false, updatedAt: 0 })),
  ];
  render(<MemoryRouter><PullRequestList entries={entries} opening={null} /></MemoryRouter>);
  expect(screen.getByRole("button", { name: "Show 2 more in acme/shop" })).toBeInTheDocument();
});
