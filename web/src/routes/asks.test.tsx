import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { delay, http, HttpResponse } from "msw";

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

function setup(path: string, { project = {}, asks = ASKS, summary = SUMMARY, wait = { asks: 0, summary: 0 } }: {
  project?: Partial<ProjectView>; asks?: AsksList; summary?: object; wait?: { asks: number; summary: number };
} = {}) {
  const requests: string[] = [];
  const summaries: string[] = [];
  server.use(
    http.get("/api/org/asks", async ({ request }) => {
      requests.push(new URL(request.url).pathname);
      await delay(wait.asks);
      return HttpResponse.json({ ok: true, ...asks });
    }),
    http.get("/api/org/summary", async ({ request }) => {
      summaries.push(new URL(request.url).pathname);
      await delay(wait.summary);
      return HttpResponse.json({ ok: true, ...summary });
    }),
  );
  let data: HomeData = { bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], device: undefined, sessions: [], session: undefined,
    projects: [{ slug: "shop", name: "Shop", status: "active", nodeActions: true, source: "json", threads, waitingAsks: 3, statusUpdated: minutesAgo(4), ...project }],
    snoozedUntil: null, update: undefined, error: false, authError: false };
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID, path: "/", loader: () => data, element: <Outlet />,
    children: [{ path: "asks", element: <AsksRoute /> }, { path: "project/:projectSlug/node/:nodeId", element: <NodeRoute /> }],
  }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  /** The next snapshot, as a poll would bring it. */
  const next = (project: Partial<ProjectView>) => {
    data = { ...data, projects: data.projects!.map((candidate) => ({ ...candidate, ...project })) };
    return router.revalidate();
  };
  return { router, requests, summaries, next, user: userEvent.setup() };
}

it("lists every ask in the popup's groups, each with whose it is and where it stands, and opens its coordinator", async () => {
  const { router, user } = setup("/asks");
  const waiting = await screen.findByRole("region", { name: "Wait on you" });
  expect(screen.getByText("all coordinators · 2 wait on you · 2 do not close · 1 in progress · 1 done")).toBeInTheDocument();
  expect(screen.getAllByRole("region").map((region) => region.getAttribute("aria-label"))).toEqual(["Wait on you", "Does not close", "In progress", "Done"]);
  expect(within(waiting).getAllByRole("listitem").map((row) => row.textContent)).toEqual([
    "Pilot with batch 2Shop · Coordinator · yes or no",
    "Stock : list or cardsShop · Checkout · decision",
  ]);
  // The words open the coordinator; an Organizations that cannot answer offers no Answer.
  expect(within(waiting).getAllByRole("link").map((link) => link.textContent)).toEqual(["Pilot with batch 2", "Stock : list or cards"]);
  expect(within(waiting).queryByRole("button", { name: /^Answer/ })).not.toBeInTheDocument();
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
  await waitFor(() => expect(card).toHaveTextContent("Wait on you1Stock : list or cardsdecision"));
  const main = within(screen.getByRole("main"));
  // The card heads the page, its asks drawn as Your asks draws them; the STATUS.md it reads from folds under it.
  const regions = main.getAllByRole("region").map((region) => region.getAttribute("aria-label"));
  expect(regions.slice(0, regions.indexOf("Status") + 1)).toEqual(["Coordinator card", "Wait on you", "Does not close", "In progress", "Status"]);
  expect(main.getByRole("button", { name: "Show STATUS.md" })).toBeInTheDocument();
  expect(card).toHaveTextContent("Objectiveupdated 12m agothe checkout in six parts");
  expect(card).toHaveTextContent("Does not close1Land the copy fixworking · a linked thread is resolved");
  expect(card).toHaveTextContent("In progress1Card tokensnext after the copy fix");
  // Only its own: no project or coordinator named on its rows.
  expect(within(card).queryByText(/^Shop · /)).not.toBeInTheDocument();
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
  await waitFor(() => expect(card).toHaveTextContent("Wait on you1Pilot with batch 2yes or no"));
  expect(card).toHaveTextContent("Does not close1Ship the couponsdone · a linked PR is still open");
  expect(card).toHaveTextContent("Done1Does it cut cost?yes, measured twice");
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

describe("whichever read lands first", () => {
  // A coordinator that runs nothing open, as awam's root reads today: a STATUS.md in free prose.
  const lone: ProjectThreadView[] = [{ id: "t-0010", title: "Checkout", parentId: "root", role: "coordinator", status: "open", group: "idle" }];
  const prose = (extra: object = {}) => ({ threads: [{ id: "t-0010", captures: [], deliverables: [], status: { text: "# Status\nfree prose", updated: minutesAgo(3), ...extra } }], status: null, usage: null, coordinator: null });
  const orders = [{ asks: 0, summary: 150 }, { asks: 150, summary: 0 }];

  it.each(orders)("a coordinator with nothing for a card draws none and keeps its STATUS.md open (asks at $asks ms, summary at $summary ms)", async (wait) => {
    setup("/project/shop/node/t-0010", { project: { threads: lone, waitingAsks: 0 }, asks: { asks: [], decisions: [] }, summary: prose(), wait });
    const status = await screen.findByRole("region", { name: "Status" });
    await waitFor(() => expect(status).toHaveTextContent("free prose"));
    await delay(200);
    expect(screen.queryByRole("region", { name: "Coordinator card" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Show STATUS.md" })).not.toBeInTheDocument();
  });

  it.each(orders)("a card that says what the file says folds it, and the file never shows open first (asks at $asks ms, summary at $summary ms)", async (wait) => {
    setup("/project/shop/node/t-0010", { project: { threads: lone, waitingAsks: 0 }, asks: { asks: [], decisions: [] }, summary: prose({ objective: "the checkout" }), wait });
    const card = await screen.findByRole("region", { name: "Coordinator card" });
    expect(card).toHaveTextContent("the checkout");
    // Until both reads are in, the file is not on screen at all.
    expect(screen.queryByText("free prose")).not.toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Show STATUS.md" })).toBeInTheDocument();
    await delay(200);
    expect(screen.queryByText("free prose")).not.toBeInTheDocument();
  });
});

it("reads the tokens again when the snapshot says the reading moved, with the page open", async () => {
  const { summaries, next } = setup("/project/shop/node/t-0010", { project: { usageStamp: "a" } });
  await screen.findByRole("region", { name: "Coordinator card" });
  await waitFor(() => expect(summaries).toHaveLength(1));
  await next({ waitingAsks: 3 });
  await delay(50);
  expect(summaries).toHaveLength(1);
  await next({ threads: threads.map((thread) => thread.id === "t-0010" ? { ...thread, usageStamp: "2026-10-16T21:00:00Z|context_warn" } : thread) });
  await waitFor(() => expect(summaries).toHaveLength(2));
});

describe("narrowing, chips and Answer (ADR 0093)", () => {
  const link = (kind: "thread" | "pr" | "task" | "page", text: string, extra: Partial<AskRow["links"][number]> = {}) =>
    ({ kind, text, target: "", thread: "", title: "", state: "", pr: "", prState: "", ...extra });
  // Organizations takes an answer on every row of a coordinator that runs.
  const linked: AsksList = { ...ASKS, answers: true, asks: [
    ask(CHECKOUT, "waiting", "needs-decision", "Prospects or numbers first?", { line: 5, answer: "both are ready", answerable: true,
      links: [link("thread", "t-0012", { thread: "t-0012", state: "working" }), link("task", "task:AWA-569", { state: "missing" }),
        link("pr", "https://github.com/acme/shop/pull/1352", { target: "https://github.com/acme/shop/pull/1352", state: "open" })] }),
    ...ASKS.asks!.map((row) => ({ ...row, answerable: true as const })),
  ] };

  it("reads an ask's links as chips: a thread opens its node, a pull request its page, a task names its state", async () => {
    const { router, user } = setup("/asks", { asks: linked });
    const waiting = await screen.findByRole("region", { name: "Wait on you" });
    const chips = within(within(waiting).getAllByRole("list", { name: "Links" })[0]!);
    expect(chips.getAllByRole("listitem").map((chip) => chip.textContent)).toEqual(["t-0012working", "AWA-569missing", "#1352open"]);
    expect(chips.getByRole("link", { name: /#1352/ })).toHaveAttribute("href", "https://github.com/acme/shop/pull/1352");
    expect(waiting).not.toHaveTextContent("task:AWA-569");
    await user.click(chips.getByRole("link", { name: /t-0012/ }));
    expect(router.state.location.pathname).toBe("/project/shop/node/t-0012");
  });

  it("answers an ask that waits on you, then shows it answered; a decision line has no Answer", async () => {
    let posted: unknown;
    server.use(http.post("/api/org/asks/answer", async ({ request }) => {
      posted = await request.json();
      return HttpResponse.json({ ok: true, answered: { project: "shop", coordinator: "t-0010", line: 5, answeredAt: "2026-10-17T10:00:00Z" } });
    }));
    const { user } = setup("/asks", { asks: linked });
    const waiting = await screen.findByRole("region", { name: "Wait on you" });
    expect(within(waiting).getAllByRole("button", { name: /^Answer/ }).map((button) => button.getAttribute("aria-label")))
      .toEqual(["Answer Prospects or numbers first?", "Answer Pilot with batch 2"]);
    await user.click(within(waiting).getByRole("button", { name: "Answer Prospects or numbers first?" }));
    // One line: a line break becomes a space.
    await user.type(screen.getByLabelText("Your answer"), "Prospects first,{Enter}then numbers");
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    await waitFor(() => expect(posted).toEqual({ project: "shop", coordinator: "t-0010", line: 5, text: "Prospects first, then numbers" }));
    const row = within(waiting).getByText("Prospects or numbers first?").closest("li")!;
    expect(row).toHaveTextContent("Answered · Prospects first, then numbers");
    expect(within(row).queryByRole("button", { name: /^Answer/ })).not.toBeInTheDocument();
  });

  it("offers no Answer on a row Organizations takes none on, and says an answered one is answered", async () => {
    const answered: AsksList = { ...linked, asks: [
      ask(CHECKOUT, "progress", "needs-decision", "Prospects or numbers first?", { line: 5, answerable: true, answeredAt: new Date(Date.now() - 5 * 60_000).toISOString() }),
      ask(ROOT, "waiting", "needs-decision", "Pilot with batch 2", { line: 4 }),
    ] };
    setup("/asks", { asks: answered });
    const progress = await screen.findByRole("region", { name: "In progress" });
    const row = within(progress).getByText("Prospects or numbers first?").closest("li")!;
    expect(row).toHaveTextContent("Answered 5m ago");
    expect(within(row).queryByRole("button", { name: /^Answer/ })).not.toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "Wait on you" })).queryByRole("button", { name: /^Answer/ })).not.toBeInTheDocument();
  });

  it("keeps the answer box open with the reason when Organizations refuses", async () => {
    server.use(http.post("/api/org/asks/answer", () => HttpResponse.json({ ok: false, error: "line 5 is not an ask" }, { status: 502 })));
    const { user } = setup("/asks", { asks: linked });
    await user.click(await screen.findByRole("button", { name: "Answer Prospects or numbers first?" }));
    await user.type(screen.getByLabelText("Your answer"), "yes");
    await user.click(screen.getByRole("button", { name: "Send answer" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("line 5 is not an ask");
    expect(screen.getByLabelText("Your answer")).toHaveValue("yes");
  });

  it("narrows to a project and then a coordinator, in the address", async () => {
    const { router, user } = setup("/asks", { asks: linked });
    await screen.findByRole("region", { name: "Wait on you" });
    // Each pick is a navigation: the page draws what it narrowed to once the router commits it, and
    // the Coordinator selector opens only then.
    await user.selectOptions(screen.getByLabelText("Project"), "shop");
    await waitFor(() => expect(router.state.location.search).toBe("?project=shop"));
    await waitFor(() => expect(screen.getByLabelText("Coordinator")).toBeEnabled());
    await user.selectOptions(screen.getByLabelText("Coordinator"), "t-0010");
    await waitFor(() => expect(router.state.location.search).toBe("?project=shop&coordinator=t-0010"));
    expect(await screen.findByText(/^Shop · Checkout · 2 wait on you/)).toBeInTheDocument();
    const main = within(screen.getByRole("main"));
    expect(main.queryByText("Pilot with batch 2")).not.toBeInTheDocument();
    expect(main.getByText("Card tokens")).toBeInTheDocument();
    // All projects clears the coordinator too.
    await user.selectOptions(screen.getByLabelText("Project"), "");
    await waitFor(() => expect(router.state.location.search).toBe(""));
  });

  it("opens narrowed from its address", async () => {
    setup("/asks?project=shop&coordinator=root", { asks: linked });
    expect(await screen.findByText(/^Shop · Coordinator · 1 waits on you/)).toBeInTheDocument();
    expect(screen.queryByText("Card tokens")).not.toBeInTheDocument();
  });
});
