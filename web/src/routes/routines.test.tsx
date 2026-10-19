import { render, screen, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { ROOT_ROUTE_ID, type HomeData } from "@/lib/loaders";
import type { ProjectView, RoutineView } from "@/lib/types";
import { server } from "@/test/setup";
import { RoutinesRoute } from "./routines";

const project = (slug: string, name: string): ProjectView => ({ slug, name, status: "active", threads: [] });
const root = (projects: ProjectView[]): HomeData => ({
  bridge: "connected", agents: [], shellPanes: [], workspaces: [], tabs: [], projects, device: undefined,
  sessions: [], session: "work", snoozedUntil: null, update: undefined, error: false, authError: false,
});
const routine = (name: string, extra: Partial<RoutineView> = {}): RoutineView =>
  ({ name, trigger: "schedule", to: "", parent: "", prompt: "", schedule: "daily 03:00", events: [], enabled: true, lastRun: "", nextRun: "", ...extra });

function serve(lists: Record<string, unknown>) {
  const asked: string[] = [];
  server.use(http.get("/api/org/routines", ({ request }) => {
    const url = new URL(request.url);
    asked.push(`${url.searchParams.get("project")}@${url.searchParams.get("session")}`);
    const list = lists[url.searchParams.get("project") ?? ""];
    return list === "fail" ? HttpResponse.json({ ok: false, error: "herdr-organizations failed (1): no project" }, { status: 502 }) : HttpResponse.json({ ok: true, ...list as object });
  }));
  return asked;
}

function open(projects: ProjectView[]) {
  const router = createMemoryRouter([{ id: ROOT_ROUTE_ID, path: "/", loader: () => root(projects), element: <Outlet />, children: [
    { path: "routines", element: <RoutinesRoute /> },
  ] }], { initialEntries: ["/routines?s=work"] });
  render(<RouterProvider router={router} />);
  return router;
}

it("lists each project's routines once, read only: what runs, when, and whether it is on", async () => {
  const nextRun = new Date(Date.now() + 4 * 3_600_000 + 60_000).toISOString();
  const asked = serve({
    shop: { available: true, broken: 0, routines: [
      routine("nightly-deps", { nextRun }),
      routine("pr-follow-up", { trigger: "pr", schedule: "", events: ["checks-failed", "review"] }),
      routine("weekly-report", { schedule: "every 7d", enabled: false }),
    ] },
    docs: { available: true, broken: 0, routines: [] },
  });
  open([project("shop", "Acme Shop"), project("docs", "Docs site")]);

  const shop = within(await screen.findByRole("region", { name: "Acme Shop" }));
  const rows = await shop.findAllByRole("listitem");
  expect(rows.map((row) => row.textContent)).toEqual([
    "nightly-depsdaily 03:00in 4h",
    "pr-follow-upon checks-failed, reviewon",
    "weekly-reportevery 7doff",
  ]);
  expect(within(await screen.findByRole("region", { name: "Docs site" })).getByText("No routines")).toBeInTheDocument();
  expect(within(screen.getByRole("main")).queryByRole("button")).toBeNull();
  expect(asked.sort()).toEqual(["docs@work", "shop@work"]);
});

it("says when Organizations cannot list routines, or failed to, instead of claiming there are none", async () => {
  serve({ shop: { available: false, broken: 0, routines: [] }, docs: "fail" });
  open([project("shop", "Acme Shop"), project("docs", "Docs site")]);
  expect(await within(await screen.findByRole("region", { name: "Acme Shop" })).findByText(/can.t list routines/)).toBeInTheDocument();
  expect(await within(screen.getByRole("region", { name: "Docs site" })).findByText(/no project/)).toBeInTheDocument();
});

it("marks each project with the glyph it picked in Organizations", async () => {
  serve({ shop: { available: true, broken: 0, routines: [] } });
  open([{ ...project("shop", "Acme Shop"), icon: "flag", tone: "red" }]);
  const glyph = (await screen.findByRole("region", { name: "Acme Shop" })).querySelector<SVGElement>("svg[data-glyph]")!;
  expect(glyph).toHaveAttribute("data-glyph", "flag");
  expect(glyph.style.color).toBe("var(--glyph-red)");
});

it("says there is nothing to list without projects", async () => {
  serve({});
  open([]);
  expect(await screen.findByText("No projects yet")).toBeInTheDocument();
});
