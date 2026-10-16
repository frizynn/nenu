import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, RouterProvider } from "react-router";

import { resetLiveEvents } from "@/lib/live-events";
import type { UsageResponse } from "@/lib/types";
import { fakeLiveStream } from "@/test/live-stream";
import { server } from "@/test/setup";
import { usageOn, usageSplit } from "@/test/usage";
import { UsageControl } from "./usage-control";

afterEach(() => resetLiveEvents());

/** The bridge's usage settings: answers GET with `state` and applies each POST to it. */
function serve(initial: UsageResponse) {
  let state = initial;
  const posts: unknown[] = [];
  let gets = 0;
  server.use(
    http.get("/api/usage", () => { gets++; return HttpResponse.json(state); }),
    http.post("/api/usage", async ({ request }) => {
      const patch = await request.json() as { on?: boolean; splitByAccount?: boolean };
      posts.push(patch);
      const on = patch.on ?? state.on;
      const split = patch.splitByAccount ?? state.splitByAccount;
      state = on ? (split ? usageSplit() : usageOn()) : { on: false, splitByAccount: split };
      return HttpResponse.json(state);
    }),
  );
  return { posts, gets: () => gets, set: (next: UsageResponse) => { state = next; } };
}

function open(readOnly = false) {
  const router = createMemoryRouter([
    { path: "/settings", element: <UsageControl readOnly={readOnly} session="work" /> },
    { path: "/settings/usage", element: <p>USAGE PAGE</p> },
  ], { initialEntries: ["/settings"] });
  render(<RouterProvider router={router} />);
  return router;
}

const group = () => within(screen.getByRole("region", { name: "Usage" }));

it("is off by default: tracking off, splitting unavailable, and no link to a page with nothing in it", async () => {
  serve({ on: false, splitByAccount: false });
  open();
  const track = await screen.findByRole("switch", { name: "Track usage" });
  expect(track).toHaveAttribute("aria-checked", "false");
  expect(group().getByRole("switch", { name: "Split by account" })).toBeDisabled();
  expect(group().getByText(/Totals tokens and API-equivalent cost from the Claude Code and Codex logs/)).toBeInTheDocument();
  expect(group().getByText(/^Off by default\./)).toBeInTheDocument();
  expect(group().queryByRole("link")).toBeNull();
});

it("turns tracking on, then links to the page with this week's cost and the 5-hour limit", async () => {
  const bridge = serve({ on: false, splitByAccount: false });
  const router = open();
  await userEvent.click(await screen.findByRole("switch", { name: "Track usage" }));
  expect(bridge.posts).toEqual([{ on: true }]);
  const link = await group().findByRole("link", { name: /^Usage/ });
  expect(link).toHaveTextContent("$9,574 this week · 5h 10%");
  expect(link).toHaveAttribute("href", "/settings/usage?s=work");
  expect(group().getByText("Cost is the API list price of these tokens, not what your plans charge.")).toBeInTheDocument();
  await userEvent.click(link);
  expect(router.state.location.pathname).toBe("/settings/usage");
});

it("splits by account and says which accounts it found", async () => {
  const bridge = serve(usageOn());
  open();
  await userEvent.click(await screen.findByRole("switch", { name: "Split by account" }));
  expect(bridge.posts).toEqual([{ splitByAccount: true }]);
  expect(await group().findByText("2 Claude Code accounts, 1 Codex account.")).toBeInTheDocument();
});

it("lets a read-only device look but not change either setting", async () => {
  serve(usageOn());
  open(true);
  expect(await screen.findByRole("switch", { name: "Track usage" })).toBeDisabled();
  expect(group().getByRole("switch", { name: "Split by account" })).toBeDisabled();
});

it("reads again when the bridge says usage changed, and only then", async () => {
  const stream = fakeLiveStream();
  stream.open();
  const bridge = serve(usageOn({ scan: { state: "scanning", firstPass: true } }));
  open();
  await screen.findByRole("switch", { name: "Track usage" });
  expect(bridge.gets()).toBe(1);
  expect(group().queryByRole("link", { name: /this week/ })).toBeNull();
  bridge.set(usageOn());
  await act(async () => stream.send({ topic: "usage" }));
  expect(await group().findByRole("link", { name: /\$9,574 this week/ })).toBeInTheDocument();
  expect(bridge.gets()).toBe(2);
  await act(async () => stream.send({ topic: "snapshot" }));
  expect(bridge.gets()).toBe(2);
  stream.stop();
});
