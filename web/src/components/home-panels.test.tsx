import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { expect, it } from "vitest";

import type { RecentChat } from "@/lib/home-stats";
import type { AgentView } from "@/lib/types";
import { HomeSessions } from "./home-panels";

const chat = (paneId: string, at: number, unseen = false): RecentChat => ({
  agent: { paneId, status: "working", agent: "claude", workspaceId: "w1", workspaceLabel: "w1", workspaceNumber: 1, tabId: "t1", cwd: "/w", focused: false } as AgentView,
  title: paneId, place: "w1", tab: null, at, unseen, review: false, detail: null,
});

function setup(first: RecentChat[]) {
  let show: (recent: RecentChat[]) => void = () => undefined;
  function Live() {
    const [recent, setRecent] = useState(first);
    show = setRecent;
    return <HomeSessions recent={recent} workspaces={[]} reviews={[]} projectRows={null} pullRequests={() => null} projects={[]} now={1_000} opening={null} />;
  }
  render(<RouterProvider router={createMemoryRouter([{ path: "/", element: <Live /> }])} />);
  const rows = () => within(screen.getByRole("tabpanel", { name: "Recents" })).getAllByRole("link").map((link) => link.getAttribute("href"));
  return { rows, show: (recent: RecentChat[]) => act(() => show(recent)) };
}

it("keeps Recents in the order it came on screen with while agents work, and reorders when the page comes back", () => {
  const { rows, show } = setup([chat("a", 300), chat("b", 200), chat("c", 100)]);
  expect(rows()).toEqual(["/pane/a", "/pane/b", "/pane/c"]);
  // c moves last; a session that was not on screen arrives in its place.
  show([chat("c", 900), chat("new", 400), chat("a", 300), chat("b", 200)]);
  expect(rows()).toEqual(["/pane/new", "/pane/a", "/pane/b", "/pane/c"]);
  act(() => { document.dispatchEvent(new Event("visibilitychange")); });
  expect(rows()).toEqual(["/pane/c", "/pane/new", "/pane/a", "/pane/b"]);
});

// A finished agent raises no toast (ADR 0094); its row says New where it is, and "N updates" reorders.
it("leaves a session that turns New in its place, and reorders on N updates", async () => {
  const first = [chat("a", 300), chat("b", 200), chat("c", 100)];
  const { rows, show } = setup(first);
  expect(screen.queryByRole("button", { name: /update/ })).toBeNull();
  show([chat("c", 900, true), chat("a", 300), chat("b", 200)]);
  expect(rows()).toEqual(["/pane/a", "/pane/b", "/pane/c"]);
  expect(within(screen.getByRole("link", { name: /^c/ })).getByText("New")).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole("button", { name: "1 update" }));
  expect(rows()).toEqual(["/pane/c", "/pane/a", "/pane/b"]);
  expect(screen.queryByRole("button", { name: /update/ })).toBeNull();
});

// Sessions first seen in the same read share a time, and the snapshot hands them over in an order that moves with their state.
it("keeps sessions with the same time in the order they first came, however they are handed over", () => {
  const { rows, show } = setup([chat("a", 100), chat("b", 100), chat("c", 100)]);
  show([chat("c", 100), chat("b", 100), chat("a", 100)]);
  expect(rows()).toEqual(["/pane/a", "/pane/b", "/pane/c"]);
  expect(screen.queryByRole("button", { name: /update/ })).toBeNull();
});
