import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { ProjectThreadView, ProjectView, ThreadSummary } from "@/lib/types";
import { NodeRoute } from "@/routes/node";
import { server } from "@/test/setup";

const LIB = "/srv/projects/hub/library";
const node = (id: string, title: string, extra: Partial<ProjectThreadView> = {}): ProjectThreadView =>
  ({ id, title, parentId: "t-10", role: "worker", status: "open", ...extra });

const reported: ProjectThreadView[] = [
  node("t-10", "Checkout", { parentId: "root", role: "coordinator", verdict: "done", group: "idle" }),
  node("t-11", "Stock panel", { verdict: "needs-decision", updated: "2026-10-16T10:00:00Z" }),
  node("t-12", "Landing", { group: "working" }),
  node("t-13", "Coupons", { verdict: "done", pr: { url: "https://github.com/acme/hub/pull/7", number: 7, state: "open", review: "approved" } }),
  node("t-14", "Login fix", { status: "resolved", pr: { url: "https://github.com/acme/hub/pull/5", number: 5, state: "merged" } }),
  node("t-20", "Elsewhere", { parentId: "root", verdict: "blocked" }),
];

const summaries: ThreadSummary[] = [
  { id: "t-10", summary: "Checkout ships in three PRs; one needs your call on stock.", captures: [], deliverables: [{ path: `${LIB}/t-10/plan.html`, kind: "html" }] },
  {
    id: "t-11", summary: "Two ways to show stock at 390 px. Pick one.",
    captures: [{ path: `${LIB}/t-11/a.png`, caption: "Option A: a list" }, { path: `${LIB}/t-11/b.png`, caption: "Option B: cards" }],
    deliverables: [{ path: `${LIB}/t-11/compare.html`, kind: "html" }, { path: `${LIB}/t-11/compare.pdf`, kind: "pdf" }],
  },
  { id: "t-20", summary: "Not under Checkout.", captures: [], deliverables: [] },
];

function setup(threads: ProjectThreadView[], reply: { threads: ThreadSummary[] | null } = { threads: summaries }, path = "/project/hub/node/t-10") {
  const asked: string[] = [];
  server.use(http.get("/api/org/summary", ({ request }) => {
    asked.push(new URL(request.url).searchParams.get("project") ?? "");
    return HttpResponse.json({ ok: true, ...reply });
  }));
  const project: ProjectView = { slug: "hub", name: "Hub", status: "active", nodeActions: true, source: "json", threads };
  const data: HomeData = { bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], projects: [project], device: undefined,
    sessions: [], session: undefined, snoozedUntil: null, update: undefined, error: false, authError: false };
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID, path: "/", loader: () => data, element: <Outlet />,
    children: [{ path: "project/:projectSlug/node/:nodeId", element: <NodeRoute /> }],
  }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return { router, asked, user: userEvent.setup() };
}

it("opens a coordinator on its own report and its live work as the tree; what finished is the tree's folded History, never report cards", async () => {
  const { router, asked, user } = setup(reported);
  const main = within(await screen.findByRole("main"));
  // The coordinator's own report heads the page.
  const own = main.getByRole("region", { name: "Node" });
  expect(await within(own).findByText("Checkout ships in three PRs; one needs your call on stock.")).toBeInTheDocument();
  expect(own).toHaveTextContent("Report: Done");
  expect(within(own).getByRole("link", { name: /plan\.html/ })).toHaveAttribute("href", `/api/org/library?project=hub&path=${encodeURIComponent(`${LIB}/t-10/plan.html`)}`);

  // One view: no Summary switch, no cards, no other thread's report on this page.
  expect(main.queryByRole("tab", { name: "Summary" })).toBeNull();
  expect(main.queryByRole("article")).toBeNull();
  expect(main.queryByText("Two ways to show stock at 390 px. Pick one.")).toBeNull();
  const open = within(main.getByRole("list", { name: "Open threads" }));
  for (const name of ["Stock panel", "Landing", "Coupons"]) expect(open.getByRole("button", { name: new RegExp(`^${name}`) })).toBeInTheDocument();
  expect(main.queryByText("Login fix")).toBeNull();
  expect(main.getByRole("button", { name: /History · 1/ })).toHaveAttribute("aria-expanded", "false");
  // Only Checkout's subtree, read once for the project.
  expect(main.queryByText("Elsewhere")).not.toBeInTheDocument();
  expect(asked).toEqual(["hub"]);

  await user.click(open.getByRole("button", { name: /^Landing/ }));
  expect(router.state.location.pathname).toBe("/project/hub/node/t-12");
});

it("draws a report's summary as text, never as markup", async () => {
  setup(reported, { threads: [{ id: "t-11", summary: `<img src="x" onerror="alert(1)"> <b>bold</b>`, captures: [], deliverables: [] }] }, "/project/hub/node/t-11");
  const own = await screen.findByRole("region", { name: "Node" });
  expect(await within(own).findByText(`<img src="x" onerror="alert(1)"> <b>bold</b>`)).toBeInTheDocument();
  expect(own.querySelector("b")).toBeNull();
  expect(own.querySelector('img[src="x"]')).toBeNull();
});

it("shows only what Organizations knows of a thread that never reported", async () => {
  const quiet = reported.map(({ verdict: _verdict, ...thread }) => thread);
  setup(quiet, { threads: [] });
  const main = within(await screen.findByRole("main"));
  expect(within(main.getByRole("list", { name: "Open threads" })).getByRole("button", { name: /^Stock panel/ })).toBeInTheDocument();
  expect(main.queryByRole("list", { name: "Captures" })).not.toBeInTheDocument();
  expect(main.queryByRole("list", { name: "Deliverables" })).not.toBeInTheDocument();
  expect(main.getByRole("region", { name: "Node" })).not.toHaveTextContent("Report:");
});

it("opens a capture of a thread's report large, its caption as its name, and steps to the next", async () => {
  const { user } = setup(reported, { threads: summaries }, "/project/hub/node/t-11");
  const own = within(await screen.findByRole("region", { name: "Node" }));
  const files = within(await own.findByRole("list", { name: "Deliverables" }));
  for (const name of ["compare.html", "compare.pdf"]) {
    expect(files.getByRole("link", { name: new RegExp(name.replace(".", "\\.")) })).toHaveAttribute("target", "_blank");
  }
  await user.click(await own.findByRole("button", { name: "Open Option A: a list" }));
  const viewer = await screen.findByRole("dialog", { name: "Option A: a list" });
  expect(within(viewer).getAllByRole("img").some((img) => img.getAttribute("src") === `/api/org/library?project=hub&path=${encodeURIComponent(`${LIB}/t-11/a.png`)}`)).toBe(true);
  await user.keyboard("{ArrowRight}");
  expect(await screen.findByRole("dialog", { name: "Option B: cards" })).toBeInTheDocument();
  // It fades out as the file preview does, then leaves.
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
});

it("leads with the report in plain words once Organizations wrote them, and asks for them where it offers to", async () => {
  const asked: unknown[] = [];
  server.use(http.post("/api/org/thread/explain", async ({ request }) => {
    asked.push(await request.json());
    return HttpResponse.json({ ok: true, explained: { id: "t-11", text: "You have to pick how stock looks on a phone: a list or cards." } });
  }));
  const plain: ThreadSummary[] = [
    { ...summaries[0]!, plain: { text: "Checkout is ready except one choice about stock, which is yours.", current: true } },
    // A plain summary of an older report is not shown; the agent's words are, with the button.
    { ...summaries[1]!, plain: { text: "Old words.", current: false }, explainable: true },
  ];
  const { user, router } = setup(reported, { threads: plain });
  const own = within(await screen.findByRole("region", { name: "Node" }));
  expect(await own.findByText("Checkout is ready except one choice about stock, which is yours.")).toBeInTheDocument();
  expect(own.queryByText("Checkout ships in three PRs; one needs your call on stock.")).toBeNull();
  await user.click(own.getByRole("button", { name: "Agent's words" }));
  expect(own.getByText("Checkout ships in three PRs; one needs your call on stock.")).toBeInTheDocument();

  await router.navigate("/project/hub/node/t-11");
  const stock = within(await screen.findByRole("region", { name: "Node" }));
  expect(stock.queryByText("Old words.")).toBeNull();
  expect(await stock.findByText("Two ways to show stock at 390 px. Pick one.")).toBeInTheDocument();
  await user.click(stock.getByRole("button", { name: "In plain words" }));
  expect(await stock.findByText("You have to pick how stock looks on a phone: a list or cards.")).toBeInTheDocument();
  expect(asked).toEqual([{ project: "hub", id: "t-11" }]);
});

it("says why the summary agent could not explain a report, and keeps the agent's words", async () => {
  server.use(http.post("/api/org/thread/explain", () => HttpResponse.json({ ok: false, error: "rate limited" }, { status: 400 })));
  const { user } = setup(reported, { threads: [summaries[0]!, { ...summaries[1]!, explainable: true }] }, "/project/hub/node/t-11");
  const own = within(await screen.findByRole("region", { name: "Node" }));
  await user.click(await own.findByRole("button", { name: "In plain words" }));
  expect(await own.findByRole("alert")).toHaveTextContent("Could not explain it: rate limited");
  expect(own.getByText("Two ways to show stock at 390 px. Pick one.")).toBeInTheDocument();
});
