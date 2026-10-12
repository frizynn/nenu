import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { expect, it, vi } from "vitest";

import type { ProjectThreadView, ProjectView } from "@/lib/types";
import { server } from "@/test/setup";
import { PrBar, ciLabel } from "./pr-bar";

const thread: ProjectThreadView = {
  id: "T1", title: "Build", parentId: "root", role: "worker", status: "open", branch: "feat/build", autoFixCi: true, autoMerge: false,
  pr: { number: 1345, state: "open", diff: { additions: 212, deletions: 148 }, checks: { passed: 4, failed: 0, pending: 2 }, mergeBlocker: "checks pending" },
};
const project = (prActions: boolean): ProjectView => ({ slug: "hub", name: "Hub", status: "active", threads: [thread], prActions });

it("shows the PR and its checks, and toggles Organizations' automation", async () => {
  let posted: unknown;
  server.use(http.post("/api/org/thread/set", async ({ request }) => {
    posted = await request.json();
    return HttpResponse.json({ ok: true, flags: { id: "T1", autoFixCi: true, autoMerge: true } });
  }));
  const onChanged = vi.fn();
  render(<PrBar project={project(true)} thread={thread} session="s" readOnly={false} onChanged={onChanged} />);
  expect(screen.getByText("#1345")).toBeInTheDocument();
  expect(screen.getByText("+212")).toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "CI 4/6, checks" }));
  expect(screen.getByRole("checkbox", { name: "Auto-fix CI & address comments" })).toBeChecked();
  await userEvent.click(screen.getByRole("checkbox", { name: "Auto-merge when ready" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(posted).toEqual({ project: "hub", id: "T1", autoMerge: true });
});

it("lets a finger reach the PR number's link at 44 px", () => {
  render(<PrBar project={project(true)} thread={{ ...thread, pr: { ...thread.pr!, url: "https://github.com/awam/hub/pull/1345" } }} readOnly={false} onChanged={vi.fn()} />);
  // A 38 px wide "#n" on the bench; the shared .hit-area gives it the touch floor.
  expect(screen.getByRole("link", { name: /^#\d+$/ })).toHaveClass("hit-area");
});

// The checkbox is 16px; its label is the row a finger hits, and on a touch screen that row is 44px.
it("lets a finger reach each automation toggle at 44 px", async () => {
  render(<PrBar project={project(true)} thread={thread} readOnly={false} onChanged={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "CI 4/6, checks" }));
  for (const name of ["Auto-fix CI & address comments", "Auto-merge when ready"]) {
    expect(screen.getByRole("checkbox", { name }).closest("label")).toHaveClass("coarse:min-h-11");
  }
});

it("keeps the checks read-only when Organizations has no PR actions", async () => {
  render(<PrBar project={project(false)} thread={thread} readOnly={false} onChanged={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "CI 4/6, checks" }));
  expect(screen.queryByRole("checkbox")).not.toBeInTheDocument();
  expect(screen.getByText(/checks are read-only/)).toBeInTheDocument();
});

it("labels CI by passed checks out of all reported", () => {
  expect(ciLabel(undefined)).toBe("CI");
  expect(ciLabel({ passed: 6, failed: 0, pending: 0 })).toBe("CI 6/6");
});
