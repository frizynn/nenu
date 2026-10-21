import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";
import { http, HttpResponse } from "msw";
import { afterEach, vi } from "vitest";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { ProjectThreadView, ProjectView, StatusFile, ThreadSummary } from "@/lib/types";
import { NodeRoute } from "@/routes/node";
import { ProjectRoute } from "@/routes/project";
import { server } from "@/test/setup";

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

const STATUS = `# Status
Objective: ship the new checkout

## Asked
- [needs-decision] Which stock layout? : list or cards (https://github.com/acme/hub/pull/9)
- [working] Coupons at 390 px : t-0011 is on it
- [done] Login with email : merged, see [the PR](https://github.com/acme/hub/pull/5)
- [shipped] An unknown state stays text
- t-9999 is not in this project <script>alert(1)</script>`;

const threads: ProjectThreadView[] = [
  { id: "t-0010", title: "Checkout", parentId: "root", role: "coordinator", status: "open", group: "idle", statusUpdated: hoursAgo(2) },
  { id: "t-0011", title: "Coupons", parentId: "t-0010", role: "worker", status: "open", group: "working" },
];

function setup(path: string, reply: { threads: ThreadSummary[] | null; status?: StatusFile | null }, project: Partial<ProjectView> = {}) {
  server.use(http.get("/api/org/summary", () => HttpResponse.json({ ok: true, ...reply })));
  const data: HomeData = { bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], device: undefined, sessions: [], session: undefined,
    projects: [{ slug: "hub", name: "Hub", goal: "Ship the shop", status: "active", nodeActions: true, source: "json", threads, ...project }],
    snoozedUntil: null, update: undefined, error: false, authError: false };
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID, path: "/", loader: () => data, element: <Outlet />,
    children: [{ path: "project/:projectSlug", element: <ProjectRoute /> }, { path: "project/:projectSlug/node/:nodeId", element: <NodeRoute /> }],
  }], { initialEntries: [path] });
  render(<RouterProvider router={router} />);
  return { router, user: userEvent.setup() };
}

afterEach(() => vi.restoreAllMocks());

it("heads a coordinator's page with its STATUS.md: states as chips, thread ids open their node, links a new tab, and markup stays text", async () => {
  const { router, user } = setup("/project/hub/node/t-0010", { threads: [{ id: "t-0010", captures: [], deliverables: [], status: { text: STATUS, updated: hoursAgo(2) } }] });
  const block = await screen.findByRole("region", { name: "Status" });
  const main = within(screen.getByRole("main"));
  // First under the title: above the node's own card and its work.
  const regions = main.getAllByRole("region").map((region) => region.getAttribute("aria-label"));
  expect(regions.slice(0, 2)).toEqual(["Status", "Node"]);
  const status = within(block);
  expect(status.getByText("updated 2h ago")).toBeInTheDocument();
  // The file's own "# Status" is the block's title already.
  expect(status.getAllByText("Status")).toHaveLength(1);
  expect(status.getByText("Asked")).toBeInTheDocument();
  expect(status.getByText("Needs decision")).toHaveAttribute("data-state", "needs-decision");
  expect(status.getByText("Working")).toHaveAttribute("data-state", "working");
  expect(status.getByText("Done")).toHaveAttribute("data-state", "done");
  expect(status.getByText(/\[shipped\] An unknown state stays text/)).toBeInTheDocument();
  expect(status.getByRole("link", { name: "the PR" })).toHaveAttribute("target", "_blank");
  expect(status.getByRole("link", { name: "the PR" })).toHaveAttribute("rel", "noopener noreferrer");
  expect(status.getByText(/<script>alert\(1\)<\/script>/)).toBeInTheDocument();
  expect(block.querySelector("script")).toBeNull();
  // Only an id this project lists becomes a way to its node.
  expect(status.queryByRole("button", { name: "t-9999" })).not.toBeInTheDocument();
  await user.click(status.getByRole("button", { name: "t-0011" }));
  expect(router.state.location.pathname).toBe("/project/hub/node/t-0011");
});

it("shows the root coordinator's STATUS.md on the project page, under its name", async () => {
  setup("/project/hub", { threads: [], status: { text: "# Status\nObjective: ship the shop\n## Needs your decision\n- Stock layout : list or cards", updated: hoursAgo(26) } },
    { statusUpdated: hoursAgo(26) });
  const block = await screen.findByRole("region", { name: "Status" });
  expect(within(block).getByText("updated 1d ago")).toBeInTheDocument();
  expect(within(block).getByText("Needs your decision")).toBeInTheDocument();
  expect(block.compareDocumentPosition(screen.getByRole("heading", { name: "Hub", level: 2 })) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();
});

it("folds a long STATUS.md under Show all, and a short one not at all", async () => {
  // jsdom lays nothing out: the folded box reports more content than it shows.
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320);
  const { user } = setup("/project/hub/node/t-0010", { threads: [{ id: "t-0010", captures: [], deliverables: [], status: { text: STATUS, updated: hoursAgo(2) } }] });
  const block = within(await screen.findByRole("region", { name: "Status" }));
  await user.click(await block.findByRole("button", { name: "Show all" }));
  expect(block.queryByRole("button", { name: "Show all" })).not.toBeInTheDocument();
  expect(block.getByRole("button", { name: "Show less" })).toBeInTheDocument();
});

it("opens a STATUS.md the card already summed up whole, never into a clipped box the wheel cannot move", async () => {
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(320);
  const { user } = setup("/project/hub/node/t-0010", { threads: [{ id: "t-0010", captures: [], deliverables: [], status: { text: STATUS, updated: hoursAgo(2), objective: "ship the new checkout" } }] });
  const block = within(await screen.findByRole("region", { name: "Status" }));
  await user.click(await block.findByRole("button", { name: "Show STATUS.md" }));
  expect(await block.findByText("Asked")).toBeInTheDocument();
  expect(block.queryByRole("button", { name: "Show all" })).toBeNull();
  expect(screen.getByRole("region", { name: "Status" }).querySelector(".max-h-72")).toBeNull();
});

it("draws no block without the field, on either page, and the pages stay as they were", async () => {
  setup("/project/hub/node/t-0010", { threads: [] });
  expect(await screen.findByRole("region", { name: "Node" })).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole("region", { name: "Status" })).not.toBeInTheDocument());
});

it("draws no block on a project page whose root has no STATUS.md", async () => {
  setup("/project/hub", { threads: null });
  expect(await screen.findByRole("heading", { name: "Hub", level: 2 })).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByRole("region", { name: "Status" })).not.toBeInTheDocument());
});
