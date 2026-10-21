import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { HomeProjects } from "./home-projects";
import type { AgentView, ProjectView } from "@/lib/types";

const now = new Date(2026, 9, 6, 12, 0, 0).getTime();
const MIN = 60_000;
const ago = (minutes: number) => new Date(now - minutes * MIN).toISOString();

function project(slug: string, minutes: number, extra: Partial<ProjectView> = {}): ProjectView {
  return { slug, name: slug.toUpperCase(), status: "active", workspaceIds: [`w-${slug}`],
    threads: [{ id: "t-1", title: "Work", parentId: "root", role: "worker", status: "open", group: "idle", updated: ago(minutes) }], ...extra };
}
const agent = (paneId: string, workspaceId: string, status: AgentView["status"]): AgentView =>
  ({ paneId, workspaceId, workspaceLabel: workspaceId, workspaceNumber: 1, tabId: "t", agent: "claude", status, cwd: "/", focused: false });

function show(projects: ProjectView[], agents: AgentView[] = []) {
  // Home draws them as its Projects tab's panel.
  const router = createMemoryRouter([{ path: "/", element: <section aria-label="Projects"><HomeProjects projects={projects} agents={agents} now={now} /></section> }]);
  render(<RouterProvider router={router} />);
  const region = within(screen.getByRole("region", { name: "Projects" }));
  // A row's second child is its name, after the project's mark.
  return { region, names: () => region.getAllByRole("link").map((link) => link.children[1]?.textContent) };
}

const working = (slug: string, minutes: number, extra: Partial<ProjectView> = {}) =>
  project(slug, minutes, { threads: [{ id: "t-1", title: "Work", parentId: "root", role: "worker", status: "open", group: "ready-for-review", updated: ago(minutes) }], ...extra });

describe("Home's projects", () => {
  it("leads with the projects where something moves, and folds the quiet ones under one row at the end", async () => {
    const { region, names } = show([project("idle", 1), working("busy", 5), project("paused", 2, { status: "paused" }), project("empty", 3, { threads: [] })]);
    expect(names()).toEqual(["BUSY"]);
    const quiet = region.getByRole("button", { name: /^Quiet/ });
    expect(quiet).toHaveTextContent("Quiet 3");
    expect(quiet).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(quiet);
    // Quiet ones keep their order by last activity, paused ones last.
    expect(names()).toEqual(["BUSY", "IDLE", "EMPTY", "PAUSED"]);
  });

  it("says so when nothing moves in any project", () => {
    const { region } = show([project("a", 1)]);
    expect(region.getByText("Nothing is running in your projects.")).toBeInTheDocument();
  });

  it("says what waits on you, what works and what to review, each in words; working counts agents, not threads", () => {
    // Three threads whose last group says working, two agents at work: the row says two, as the headline would.
    const busy = project("a", 1, { waitingAsks: 2, threads: [
      { id: "t-1", title: "Flow", parentId: "root", role: "worker", status: "open", group: "ready-for-review", updated: ago(1) },
      ...["t-2", "t-3", "t-4"].map((id) => ({ id, title: id, parentId: "root", role: "worker" as const, status: "open" as const, group: "working", updated: ago(2) })),
    ] });
    const { region } = show([busy], [agent("p1", "w-a", "working"), agent("p2", "w-a", "working"), agent("p3", "w-a", "idle"), agent("p4", "w-other", "working")]);
    expect(region.getByRole("link", { name: /^A/ })).toHaveTextContent("2 asks2 working1 to review");
    // A row always opens its project, whose page leads to its asks and its coordinators.
    expect(region.getByRole("link", { name: /^A/ }).getAttribute("href")).toBe("/project/a");
  });

  it("says one ask in the singular, and calls waiting nodes waiting where Organizations lists no asks", () => {
    const one = project("a", 1, { waitingAsks: 1 });
    const older = project("b", 2, { threads: [{ id: "t-1", title: "Hook", parentId: "root", role: "worker", status: "open", group: "waiting-on-you", updated: ago(2) }] });
    const { region } = show([one, older]);
    expect(region.getByRole("link", { name: /^A/ })).toHaveTextContent("1 ask");
    expect(region.getByRole("link", { name: /^B/ })).toHaveTextContent("1 waiting");
    expect(region.getByRole("link", { name: /^B/ }).getAttribute("href")).toBe("/project/b");
  });

  it("says what a quiet project is: paused, nothing running, or nothing open", async () => {
    const { region } = show([project("a", 1), project("b", 2, { status: "paused" }), project("c", 3, { threads: [] })]);
    await userEvent.click(region.getByRole("button", { name: /^Quiet/ }));
    expect(region.getByRole("link", { name: /^A/ })).toHaveTextContent("Nothing running · 1 open thread");
    expect(region.getByRole("link", { name: /^B/ })).toHaveTextContent("Paused · 1 open thread");
    expect(region.getByRole("link", { name: /^C/ })).toHaveTextContent("No open threads");
  });

  it("puts the one that moved last first and folds past five behind Show all", async () => {
    const many = [working("old", 50), ...["b", "c", "d", "e", "f"].map((slug, i) => working(slug, 10 + i))];
    const { region, names } = show(many);
    expect(names()).toEqual(["B", "C", "D", "E", "F"]);
    await userEvent.click(region.getByRole("button", { name: "Show all 6" }));
    expect(names()).toEqual(["B", "C", "D", "E", "F", "OLD"]);
  });
});
