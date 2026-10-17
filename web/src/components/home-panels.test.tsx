import { act, render, screen, within } from "@testing-library/react";
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
    return <HomeSessions recent={recent} workspaces={[]} reviews={[]} pullRequests={() => null} projects={[]} now={1_000} opening={null} />;
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

// A finished agent raises no toast (ADR 0094), so its New must not wait below the fold for a return.
it("moves a session up as it turns New, from below the fold too", () => {
  const first = Array.from({ length: 8 }, (_, i) => chat(`p${i}`, 800 - i * 100));
  const { rows, show } = setup(first);
  expect(rows()).not.toContain("/pane/p7");
  show([chat("p7", 900, true), ...first.slice(0, 7)]);
  expect(rows()[0]).toBe("/pane/p7");
  // Still New on the next read, it stays where it rose to.
  show([chat("p7", 900, true), chat("p0", 1_000), ...first.slice(1, 7)]);
  expect(rows().slice(0, 2)).toEqual(["/pane/p7", "/pane/p0"]);
});
