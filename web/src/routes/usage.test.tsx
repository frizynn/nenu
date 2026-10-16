import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Profiler } from "react";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import { resetLiveEvents } from "@/lib/live-events";
import type { UsageResponse } from "@/lib/types";
import { fakeLiveStream } from "@/test/live-stream";
import { server } from "@/test/setup";
import { ACCOUNTS, LIMITS, NOW, usageOn, usageSplit } from "@/test/usage";
import { UsageRoute } from "./usage";

const root: HomeData = {
  bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], projects: [], device: undefined,
  sessions: [], session: "work", snoozedUntil: null, update: undefined, error: false, authError: false,
};

beforeEach(() => vi.spyOn(Date, "now").mockReturnValue(NOW));
afterEach(() => {
  vi.restoreAllMocks();
  resetLiveEvents();
});

/** GET /api/usage answers `answer` (by its query), and every request is kept. */
function serve(answer: UsageResponse | ((url: URL) => UsageResponse)) {
  const asked: string[] = [];
  server.use(http.get("/api/usage", ({ request }) => {
    const url = new URL(request.url);
    asked.push(url.search);
    return HttpResponse.json(typeof answer === "function" ? answer(url) : answer);
  }));
  return asked;
}

function open(onRender?: (phase: string) => void) {
  const page = onRender ? <Profiler id="usage" onRender={(_id, phase) => onRender(phase)}><UsageRoute /></Profiler> : <UsageRoute />;
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: () => root, element: <Outlet />, children: [
    { path: "settings", element: <p>SETTINGS</p> },
    { path: "settings/usage", element: page },
  ] }], { initialEntries: ["/settings/usage?s=work"] });
  render(<RouterProvider router={router} />);
  return router;
}

const main = () => within(screen.getByRole("main"));
const two = (n: number) => String(n).padStart(2, "0");
/** A reset time as the page writes it, in this machine's zone. */
const clock = (iso: string) => { const d = new Date(iso); return `${two(d.getHours())}:${two(d.getMinutes())}`; };

it("says usage is off and leads to the setting that turns it on", async () => {
  serve({ on: false, splitByAccount: false });
  const router = open();
  expect(await screen.findByRole("heading", { name: "Usage is off" })).toBeInTheDocument();
  await userEvent.click(screen.getByRole("link", { name: "Turn on in Settings" }));
  expect(router.state.location.pathname).toBe("/settings");
});

it("shows the first pass's progress, moves it on each usage event, and the totals once it ends", async () => {
  const stream = fakeLiveStream();
  stream.open();
  let answer: UsageResponse = usageOn({ scan: { state: "scanning", firstPass: true, files: 2, totalFiles: 4, bytes: 1.5e9, totalBytes: 3e9 }, days: [], periods: [] });
  const asked = serve(() => answer);
  open();
  expect(await screen.findByText("Reading logs for the first time")).toBeInTheDocument();
  expect(main().getByText("2 of 4 files")).toBeInTheDocument();
  expect(main().getByText("1.5 of 3 GB")).toBeInTheDocument();
  expect(main().getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");

  answer = usageOn({ scan: { state: "scanning", firstPass: true, files: 3, totalFiles: 4, bytes: 2.7e9, totalBytes: 3e9 }, days: [], periods: [] });
  await act(async () => stream.send({ topic: "usage" }));
  expect(await main().findByText("3 of 4 files")).toBeInTheDocument();

  answer = usageOn();
  await act(async () => stream.send({ topic: "usage" }));
  expect(await main().findByText("This week")).toBeInTheDocument();
  expect(asked).toEqual(["", "", ""]);
  stream.stop();
});

it("says when there is nothing to count yet", async () => {
  serve(usageOn({ days: [], periods: [], coverage: { trackedFrom: "2026-10-14" } }));
  open();
  expect(await screen.findByRole("heading", { name: "No usage yet" })).toBeInTheDocument();
  expect(main().getByText(/No Claude Code transcripts or Codex sessions on this machine/)).toBeInTheDocument();
});

it("shows today, the week and the month, the plan limits, the map, the weeks and the month's breakdown", async () => {
  serve(usageOn());
  open();
  const stats = await screen.findByRole("list", { name: "Totals" });
  expect(within(stats).getAllByRole("listitem").map((item) => item.textContent)).toEqual([
    "Today$79250M tokens", "This week$9,57428.3B tokens", "October$16.9k54.5B tokens",
  ]);
  const limits = within(main().getByRole("region", { name: "Plan limits" }));
  expect(limits.getByText("Claude Code")).toBeInTheDocument();
  expect(limits.getByRole("meter", { name: "5-hour" })).toHaveAttribute("aria-valuenow", "10");
  expect(limits.getByText(`Resets ${clock("2026-10-14T17:40:00Z")} · now`)).toBeInTheDocument();
  expect(limits.getByText("No reading yet")).toBeInTheDocument();
  expect(limits.getByText("Codex")).toBeInTheDocument();
  expect(limits.getByText("Plus")).toBeInTheDocument();
  expect(limits.getByText(`Resets Thu 22 Oct, ${clock("2026-10-22T14:22:00Z")} · seen 11h ago`)).toBeInTheDocument();
  expect(main().getByRole("listbox", { name: /Activity/ })).toBeInTheDocument();
  expect(main().getByRole("region", { name: "By week" })).toBeInTheDocument();

  const breakdown = within(main().getByRole("region", { name: "October by" }));
  expect(breakdown.getByRole("radio", { name: "Model" })).toBeChecked();
  expect(breakdown.getByText("Opus 5.5")).toBeInTheDocument();
  await userEvent.click(breakdown.getByRole("radio", { name: "Project" }));
  expect(breakdown.getByText("Checkout")).toBeInTheDocument();
  expect(breakdown.getByText("3 other folders")).toBeInTheDocument();
  expect(main().getByText(/Cost is what these tokens would cost on the API at list price/)).toBeInTheDocument();
  expect(main().queryByRole("button", { name: /accounts/ })).toBeNull();
});

it("warns near a limit and names the account with room", async () => {
  const near = LIMITS.map((l, i) => i === 0 ? { ...l, windows: [{ ...l.windows[0]!, usedPercent: 91 }] } : l);
  serve(usageSplit({ limits: near }));
  open();
  const limits = within(await screen.findByRole("region", { name: "Plan limits" }));
  expect(limits.getByText("Claude Code · Studio")).toBeInTheDocument();
  expect(limits.getAllByText("Active", { selector: "span" })).toHaveLength(2);
  expect(limits.getByRole("meter", { name: "5-hour" })).toHaveAttribute("aria-valuenow", "91");
  expect(limits.getByRole("alert")).toHaveTextContent("Close to the 5-hour limit. Work has room: 5-hour 0%, weekly 9%.");
});

it("splits by account: picks one from the list and reads only that account", async () => {
  const asked = serve((url) => url.searchParams.get("account") ? usageSplit({ account: url.searchParams.get("account")! }) : usageSplit());
  open();
  const limits = within(await screen.findByRole("region", { name: "Plan limits" }));
  expect(limits.getByRole("button", { name: /1 more Claude account/ })).toHaveTextContent("Work weekly 9%");
  await userEvent.click(main().getByRole("button", { name: "All accounts" }));
  const list = within(await screen.findByRole("listbox", { name: "Account" }));
  expect(list.getAllByRole("option").map((o) => o.textContent)).toEqual([
    "All accounts$520", "StudioClaude Code · 900M tokens$300", "WorkClaude Code · 400M tokens$150",
    "ChatGPTCodex · 100M tokens$50", "UnassignedClaude Code with no account on record$20",
  ]);
  await userEvent.click(list.getByRole("option", { name: /^Work/ }));
  expect(await main().findByRole("button", { name: "Work" })).toBeInTheDocument();
  expect(asked).toEqual(["", `?account=${encodeURIComponent(ACCOUNTS[1]!.id)}`]);
});

it("reads again only on the usage event or a refresh, and draws the data in one commit", async () => {
  const stream = fakeLiveStream();
  stream.open();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const asked: string[] = [];
  server.use(http.get("/api/usage", async ({ request }) => {
    asked.push(new URL(request.url).search);
    await gate;
    return HttpResponse.json(usageOn());
  }));
  const commits: string[] = [];
  open((phase) => commits.push(phase));
  await screen.findByRole("banner");
  await act(async () => {});
  const before = commits.length;
  await act(async () => release());
  await screen.findByText("This week");
  expect(commits.length - before).toBe(1);

  await act(async () => stream.send({ topic: "snapshot" }));
  await act(async () => stream.send({ topic: "org" }));
  expect(asked).toEqual([""]);
  await act(async () => stream.send({ topic: "usage" }));
  await userEvent.click(screen.getByRole("button", { name: "Recalculate" }));
  expect(asked).toEqual(["", "", "?fresh=1"]);
  stream.stop();
});

it("sets no timer and runs no poll: the page re-reads on the bridge's usage event alone", () => {
  for (const file of ["routes/usage.tsx", "components/usage-map.tsx", "components/usage-cards.tsx"]) {
    const text = readFileSync(resolve(import.meta.dirname, "..", file), "utf8");
    expect(text, file).not.toMatch(/\b(setTimeout|setInterval|requestAnimationFrame|useRevalidator|usePolling)\b/);
  }
});
