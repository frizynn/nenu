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

// As in Recents, the rows "Show all" adds ease in where they land; those already shown stay still.
test("eases in only the PRs Show all adds", async () => {
  const entries: ReviewEntry[] = Array.from({ length: 7 }, (_, i) => (
    { key: `a/b#${i}`, title: `PR ${i}`, repo: "b", number: i, draft: false, updatedAt: 0, url: `https://github.com/a/b/pull/${i}` }));
  render(<MemoryRouter><PullRequestList entries={entries} opening={null} /></MemoryRouter>);
  await userEvent.setup().click(screen.getByRole("button", { name: "Show all 7" }));
  expect(screen.getAllByRole("listitem").map((row) => row.classList.contains("row-enter"))).toEqual([false, false, false, false, false, true, true]);
});
