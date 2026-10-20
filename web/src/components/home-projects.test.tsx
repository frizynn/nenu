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
  const router = createMemoryRouter([{ path: "/", element: <HomeProjects projects={projects} agents={agents} now={now} /> }]);
  render(<RouterProvider router={router} />);
  const region = within(screen.getByRole("region", { name: /^Projects/ }));
  // A row's second child is its name, after the project's mark.
  return { region, names: () => region.getAllByRole("link").filter((link) => link.textContent !== "See all").map((link) => link.children[1]?.textContent) };
}

describe("Home's projects", () => {
  it("names the region by its heading alone, with See all beside it", () => {
    const { region } = show([project("a", 5)]);
    expect(screen.getByRole("region", { name: /^Projects/ })).not.toHaveAccessibleName(/See all/);
    expect(region.getByRole("link", { name: "See all" }).closest("h2")).toBeNull();
  });

  it("says what waits on you, what works and what to review, each in words; working counts agents, not threads", () => {
    // Three threads whose last group says working, two agents at work: the row says two, as the headline would.
    const busy = project("a", 1, { waitingAsks: 2, threads: [
      { id: "t-1", title: "Flow", parentId: "root", role: "worker", status: "open", group: "ready-for-review", updated: ago(1) },
      ...["t-2", "t-3", "t-4"].map((id) => ({ id, title: id, parentId: "root", role: "worker" as const, status: "open" as const, group: "working", updated: ago(2) })),
    ] });
    const { region } = show([busy], [agent("p1", "w-a", "working"), agent("p2", "w-a", "working"), agent("p3", "w-a", "idle"), agent("p4", "w-other", "working")]);
    expect(region.getByRole("link", { name: /^A/ })).toHaveTextContent("2 asks2 working1 to review");
    expect(region.getByRole("link", { name: /^A/ }).getAttribute("href")).toBe("/project/a?tab=waiting");
  });

  it("says what a quiet project is: paused, nothing running, or nothing open", () => {
    const { region } = show([project("a", 1), project("b", 2, { status: "paused" }), project("c", 3, { threads: [] })]);
    expect(region.getByRole("link", { name: /^A/ })).toHaveTextContent("Nothing running · 1 open thread");
    expect(region.getByRole("link", { name: /^B/ })).toHaveTextContent("Paused · 1 open thread");
    expect(region.getByRole("link", { name: /^C/ })).toHaveTextContent("No open threads");
  });

  it("puts the one that moved last first, paused ones last, and folds past five behind Show all", async () => {
    const many = [project("old", 50), project("paused", 1, { status: "paused" }), ...["b", "c", "d", "e", "f"].map((slug, i) => project(slug, 10 + i))];
    const { region, names } = show(many);
    expect(names()).toEqual(["B", "C", "D", "E", "F"]);
    await userEvent.click(region.getByRole("button", { name: "Show all 7" }));
    expect(names()).toEqual(["B", "C", "D", "E", "F", "OLD", "PAUSED"]);
  });
});
