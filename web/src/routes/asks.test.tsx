import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { AskRow, AsksList, ProjectThreadView, ProjectView, ThreadSummary } from "@/lib/types";
import { server } from "@/test/setup";
import { AsksRoute } from "./asks";
import { NodeRoute } from "./node";

// Your asks and a coordinator's card from what the bridge serves out of Organizations' documents
// (docs/json.md: Asks, Status file, Usage, Project.coordinator), and an Organizations without them.

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const ROOT = { id: "root", title: "" };
const CHECKOUT = { id: "t-0010", title: "Checkout" };
const ask = (coordinator: AskRow["coordinator"], group: AskRow["group"], state: AskRow["state"], text: string, extra: Partial<AskRow> = {}): AskRow =>
  ({ project: "shop", coordinator, line: 4, state, text, answer: "", links: [], confirmed: "", mismatch: "", group, ...extra });
const ASKS: AsksList = {
  asks: [
    ask(ROOT, "waiting", "needs-decision", "Pilot with batch 2", { answer: "yes or no" }),
    ask(ROOT, "unclosed", "done", "Ship the coupons", { answer: "approved", confirmed: "in-progress", mismatch: "a linked PR is still open" }),
    ask(CHECKOUT, "unclosed", "working", "Land the copy fix", { confirmed: "done", mismatch: "a linked thread is resolved" }),
    ask(CHECKOUT, "progress", "open", "Card tokens", { answer: "next after the copy fix" }),
    ask(ROOT, "done", "answered", "Does it cut cost?", { answer: "yes, measured twice" }),
  ],
  decisions: [{ project: "shop", coordinator: CHECKOUT, text: "Stock : list or cards" }],
};
const usage = (context: number, overCap: string[] = []) =>
  ({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, context, peakContext: 967_000, compactions: 3, updated: minutesAgo(2), overCap });

const threads: ProjectThreadView[] = [
  { id: "t-0010", title: "Checkout", parentId: "root", role: "coordinator", status: "open", group: "idle", statusUpdated: minutesAgo(12) },
  { id: "t-0011", title: "Stock panel", parentId: "t-0010", role: "worker", status: "open", group: "waiting-on-you", verdict: "needs-decision",
    pr: { url: "https://github.com/acme/shop/pull/1352", number: 1352, state: "open", checks: { passed: 8, pending: 0, failed: 0, failing: [] } } },
  { id: "t-0012", title: "QR payments", parentId: "t-0010", role: "worker", status: "open", group: "working" },
  { id: "t-0015", title: "Email login", parentId: "t-0010", role: "worker", status: "resolved", verdict: "done" },
];
const SUMMARY: { threads: ThreadSummary[]; status: unknown; usage: unknown; coordinator: unknown } = {
  threads: [
    { id: "t-0010", captures: [], deliverables: [], status: { text: "# Status\nObjective: the checkout in six parts", updated: minutesAgo(12), objective: "the checkout in six parts", needsDecision: ["Stock : list or cards"] }, usage: usage(188_000) },
    { id: "t-0012", captures: [], deliverables: [], usage: usage(690_000, ["compaction_warn"]) },
  ],
  status: { text: "# Status\nObjective: ship the checkout by Friday", updated: minutesAgo(4), objective: "ship the checkout by Friday" },
  usage: usage(412_000, ["context_warn"]),
  coordinator: { agent: "claude", model: "opus", state: "idle" },
};

function setup(path: string, { project = {}, asks = ASKS, summary = SUMMARY }: { project?: Partial<ProjectView>; asks?: AsksList; summary?: object } = {}) {
  const requests: string[] = [];
  server.use(
    http.get("/api/org/asks", ({ request }) => { requests.push(new URL(request.url).pathname); return HttpResponse.json({ ok: true, ...asks }); }),
    http.get("/api/org/summary", () => HttpResponse.json({ ok: true, ...summary })),
  );
  const data: HomeData = { bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], device: undefined, sessions: [], session: undefined,
    projects: [{ slug: "shop", name: "Shop", status: "active", nodeActions: true, source: "json", threads, waitingAsks: 3, statusUpdated: minutesAgo(4), ...project }],
    snoozedUntil: null, update: undefined, error: false, authError: false };
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID, path: "/", loader: () => data, element: <Outlet />,
    children: [{ path: "asks", element: <AsksRoute /> }, { path: "project/:projectSlug/node/:nodeId", element: <NodeRoute /> }],
  }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return { router, requests, user: userEvent.setup() };
}

it("lists every ask in the popup's groups, each with whose it is and where it stands, and opens its coordinator", async () => {
  const { router, user } = setup("/asks");
  const waiting = await screen.findByRole("region", { name: "Wait on you" });
  expect(screen.getByText("all coordinators · 2 wait on you · 2 do not close · 1 in progress · 1 done")).toBeInTheDocument();
  expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["Wait on you", "Does not close", "In progress", "Done"]);
  expect(within(waiting).getAllByRole("link").map((link) => link.textContent)).toEqual([
    "Pilot with batch 2Shop · Coordinator · yes or no",
    "Stock : list or cardsShop · Checkout · decision",
  ]);
  const unclosed = screen.getByRole("region", { name: "Does not close" });
  expect(unclosed).toHaveTextContent("Ship the couponsShop · Coordinator · done · a linked PR is still open");

  await user.click(within(unclosed).getByRole("link", { name: /Land the copy fix/ }));
  expect(router.state.location.pathname).toBe("/project/shop/node/t-0010");
  await router.navigate("/asks");
  await user.click(await screen.findByRole("link", { name: /Does it cut cost/ }));
  expect(router.state.location.pathname).toBe("/project/shop/node/root");
});

it("opens a coordinator's page on its card: objective, what waits on you, its asks, agents, pull requests and tokens", async () => {
  setup("/project/shop/node/t-0010");
  const card = await screen.findByRole("region", { name: "Coordinator card" });
  await waitFor(() => expect(card).toHaveTextContent("Waits on you1Stock : list or cards"));
  const main = within(screen.getByRole("main"));
  // The card heads the page; the STATUS.md it reads from folds under it.
  expect(main.getAllByRole("region").map((region) => region.getAttribute("aria-label")).slice(0, 2)).toEqual(["Coordinator card", "Status"]);
  expect(main.getByRole("button", { name: "Show STATUS.md" })).toBeInTheDocument();
  expect(card).toHaveTextContent("Objectiveupdated 12m agothe checkout in six parts");
  expect(card).toHaveTextContent("Asks2Land the copy fixworking · a linked thread is resolvedCard tokensnext after the copy fix");
  // Its open agents only, each with its state, verdict and a cap it passed.
  expect(card).toHaveTextContent("Agents2Stock panelNeeds you · Asks for your decisionQR paymentsWorking · over cap");
  expect(card).toHaveTextContent("Pull requests1Stock panelPR #1352 · checks passed");
  expect(card).not.toHaveTextContent("Email login");
  expect(within(card).getByRole("link", { name: /Stock panel/ })).toHaveAttribute("href", "https://github.com/acme/shop/pull/1352");
  expect(card).toHaveTextContent("Context 188k· peak 967k· 3 compactions");
  expect(card.querySelector("[data-over-cap]")).toBeNull();
});

it("gives the project's own coordinator a page of its own: its agent, its card, its tokens over a cap", async () => {
  setup("/project/shop/node/root");
  const card = await screen.findByRole("region", { name: "Coordinator card" });
  const main = within(screen.getByRole("main"));
  expect(main.getByRole("heading", { name: "Coordinator" })).toBeInTheDocument();
  await waitFor(() => expect(main.getByText("claude · opus")).toBeInTheDocument());
  // What the ticker saw of it, without a live pane.
  expect(main.getByText("claude · opus").parentElement).toHaveTextContent("Idle·claude · opus");
  await waitFor(() => expect(card).toHaveTextContent("Waits on you1Pilot with batch 2 : yes or no"));
  expect(card).toHaveTextContent("Asks2Ship the couponsdone · a linked PR is still openDoes it cut cost?yes, measured twice");
  expect(card).toHaveTextContent("Agents1CheckoutIdle");
  expect(card.querySelector("[data-over-cap]")).toHaveTextContent("Over cap: context");
});

it("with an Organizations that predates asks, the pages stay as they were and nothing asks for them", async () => {
  const old = { threads: [{ id: "t-0010", captures: [], deliverables: [], status: { text: "# Status\nObjective: the checkout in six parts", updated: minutesAgo(12) } }], status: null, usage: null, coordinator: null };
  const { requests } = setup("/project/shop/node/t-0010", { project: { waitingAsks: undefined }, summary: old });
  const status = await screen.findByRole("region", { name: "Status" });
  await waitFor(() => expect(status).toHaveTextContent("Objective: the checkout in six parts"));
  expect(screen.queryByRole("region", { name: "Coordinator card" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Show STATUS.md" })).not.toBeInTheDocument();
  expect(requests).toEqual([]);
});

it("says Your asks needs a newer Organizations, without asking the bridge", async () => {
  const { requests } = setup("/asks", { project: { waitingAsks: undefined } });
  expect(await screen.findByText("This Herdr Organizations can’t list asks yet; update it to see them here.")).toBeInTheDocument();
  expect(requests).toEqual([]);
});

it("a worker's page has no card, and does not read the asks", async () => {
  const { requests } = setup("/project/shop/node/t-0011");
  expect(await screen.findByRole("region", { name: "Node" })).toBeInTheDocument();
  expect(screen.queryByRole("region", { name: "Coordinator card" })).not.toBeInTheDocument();
  expect(requests).toEqual([]);
});
