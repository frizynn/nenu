import { render, screen, within } from "@testing-library/react";
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
    deliverables: [{ path: `${LIB}/t-11/compare.html`, kind: "html" }, { path: `${LIB}/t-11/compare.pdf`, kind: "pdf" }, { path: `${LIB}/t-11/notes.md`, kind: "md" }],
  },
  { id: "t-20", summary: "Not under Checkout.", captures: [], deliverables: [] },
];

function setup(threads: ProjectThreadView[], reply: { threads: ThreadSummary[] | null } = { threads: summaries }) {
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
  }], { initialEntries: ["/project/hub/node/t-10"] });
  render(<RouterProvider router={router} />);
  return { router, asked, user: userEvent.setup() };
}

it("opens a coordinator whose threads reported on its Summary: decisions, work in progress, then done, each with what its report says", async () => {
  const { router, asked, user } = setup(reported);
  const main = within(await screen.findByRole("main"));
  expect(main.getByRole("tab", { name: "Summary" })).toHaveAttribute("aria-selected", "true");
  // The coordinator's own report heads the page.
  const own = main.getByRole("region", { name: "Node" });
  expect(await within(own).findByText("Checkout ships in three PRs; one needs your call on stock.")).toBeInTheDocument();
  expect(own).toHaveTextContent("Report: Done");
  expect(within(own).getByRole("link", { name: /plan\.html/ })).toHaveAttribute("href", `/api/org/library?project=hub&path=${encodeURIComponent(`${LIB}/t-10/plan.html`)}`);

  const sections = main.getAllByRole("region").filter((region) => region.getAttribute("aria-label") !== "Node");
  expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual(["Needs your decision", "In progress", "Done"]);
  const [decide, progress, done] = sections.map((section) => within(section));
  const stock = within(decide!.getByRole("article", { name: "Stock panel" }));
  expect(stock.getByText("Two ways to show stock at 390 px. Pick one.")).toBeInTheDocument();
  expect(stock.getByText(/Asks for your decision/)).toBeInTheDocument();
  const captures = within(stock.getByRole("list", { name: "Captures" }));
  expect(captures.getAllByRole("img").map((img) => img.getAttribute("alt"))).toEqual(["Option A: a list", "Option B: cards"]);
  expect(captures.getAllByRole("img")[0]).toHaveAttribute("src", `/api/org/library?project=hub&path=${encodeURIComponent(`${LIB}/t-11/a.png`)}`);
  expect(captures.getByText("Option B: cards")).toBeInTheDocument();
  const files = within(stock.getByRole("list", { name: "Deliverables" }));
  for (const name of ["compare.html", "compare.pdf"]) {
    expect(files.getByRole("link", { name: new RegExp(name.replace(".", "\\.")) })).toHaveAttribute("target", "_blank");
  }
  // Markdown is named, not served.
  expect(files.getByText("notes.md").closest("a")).toBeNull();

  expect(progress!.getByRole("article", { name: "Landing" })).toBeInTheDocument();
  expect(done!.getAllByRole("article").map((card) => card.getAttribute("aria-label"))).toEqual(["Coupons", "Login fix"]);
  expect(done!.getByRole("link", { name: /PR #7 approved/ })).toHaveAttribute("href", "https://github.com/acme/hub/pull/7");
  expect(done!.getByText(/PR #5 merged/)).toBeInTheDocument();
  // Only Checkout's subtree, read once for the project.
  expect(main.queryByText("Elsewhere")).not.toBeInTheDocument();
  expect(asked).toEqual(["hub"]);

  // A card opens its node; the tree is one tab away.
  await user.click(progress!.getByRole("button", { name: /^Landing/ }));
  expect(router.state.location.pathname).toBe("/project/hub/node/t-12");
  await router.navigate("/project/hub/node/t-10");
  await user.click(await screen.findByRole("tab", { name: /^Threads/ }));
  expect(within(screen.getByRole("list", { name: "Open threads" })).getByRole("button", { name: /^Stock panel/ })).toBeInTheDocument();
});

it("draws a report's summary as text, never as markup", async () => {
  setup(reported, { threads: [{ id: "t-11", summary: `<img src="x" onerror="alert(1)"> <b>bold</b>`, captures: [], deliverables: [] }] });
  const card = await screen.findByRole("article", { name: "Stock panel" });
  expect(await within(card).findByText(`<img src="x" onerror="alert(1)"> <b>bold</b>`)).toBeInTheDocument();
  expect(card.querySelector("b")).toBeNull();
  expect(card.querySelector('img[src="x"]')).toBeNull();
});

it("opens a coordinator whose threads never reported on its threads, as before, and its Summary shows only what Organizations knows", async () => {
  const quiet = reported.map(({ verdict: _verdict, ...thread }) => thread);
  const { user } = setup(quiet, { threads: [] });
  const main = within(await screen.findByRole("main"));
  expect(main.getByRole("tab", { name: /^Threads/ })).toHaveAttribute("aria-selected", "true");
  expect(within(main.getByRole("list", { name: "Open threads" })).getByRole("button", { name: /^Stock panel/ })).toBeInTheDocument();
  await user.click(main.getByRole("tab", { name: "Summary" }));
  const sections = main.getAllByRole("region").filter((region) => region.getAttribute("aria-label") !== "Node");
  expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual(["In progress", "Done"]);
  expect(main.queryByRole("list", { name: "Captures" })).not.toBeInTheDocument();
  expect(main.queryByRole("list", { name: "Deliverables" })).not.toBeInTheDocument();
  expect(main.getByRole("region", { name: "Node" })).not.toHaveTextContent("Report:");
});

it("opens a capture large, its caption as its name, and steps to the next", async () => {
  const { user } = setup(reported);
  const card = within(await screen.findByRole("article", { name: "Stock panel" }));
  await user.click(await card.findByRole("button", { name: "Open Option A: a list" }));
  const viewer = await screen.findByRole("dialog", { name: "Option A: a list" });
  expect(within(viewer).getAllByRole("img").some((img) => img.getAttribute("src") === `/api/org/library?project=hub&path=${encodeURIComponent(`${LIB}/t-11/a.png`)}`)).toBe(true);
  await user.keyboard("{ArrowRight}");
  expect(await screen.findByRole("dialog", { name: "Option B: cards" })).toBeInTheDocument();
  await user.keyboard("{Escape}");
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});
