import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { vi } from "vitest";

import type { ProjectView } from "@/lib/types";
import { server } from "@/test/setup";
import { ProjectTasks, coordinatedThreads, prSummary, threadBucket, threadTree } from "./project-tasks";

const project: ProjectView = {
  slug: "hub", name: "Hub", goal: "Ship it", status: "active",
  coordinator: { paneId: "c", agent: "claude", liveStatus: "working" },
  threads: [
    { id: "T1", title: "Build", parentId: "root", role: "worker", status: "open", paneId: "a", agent: "codex", liveStatus: "blocked" },
    { id: "T0", title: "Audit", parentId: "root", role: "worker", status: "resolved" },
  ],
};

function setup(overrides: Partial<Parameters<typeof ProjectTasks>[0]> = {}) {
  const props = { project, panes: [], session: "work", currentPaneId: "a", readOnly: false, onOpenPane: vi.fn(), onChanged: vi.fn(), ...overrides };
  render(<ProjectTasks {...props} />);
  return { ...props, user: userEvent.setup() };
}

it("lists the coordinator, then threads grouped by what they need, resolved ones folded", async () => {
  const { user, onOpenPane } = setup();
  expect(screen.getByRole("heading", { name: "Hub" })).toBeInTheDocument();
  expect(screen.getByText("Ship it")).toBeInTheDocument();
  const build = screen.getByRole("button", { name: /^Build/ });
  expect(build).toHaveTextContent("Asked you a question");
  expect(build.closest("li")).toHaveAttribute("aria-current", "true");
  expect(build.closest("details")).toHaveTextContent(/^Needs you/);
  const resolved = screen.getByText("Audit").closest("details")!;
  expect(resolved).toHaveTextContent(/^Resolved/);
  expect(resolved).not.toHaveAttribute("open");
  expect(within(resolved).getByText("Audit")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Coordinator/ }));
  expect(onOpenPane).toHaveBeenCalledWith("c");
});

it("buckets threads by their state and pull request", () => {
  const base = { parentId: "root", role: "worker", status: "open" } as const;
  expect(threadBucket({ ...base, id: "a", title: "a", paneId: "p", liveStatus: "blocked" })).toBe("needs");
  expect(threadBucket({ ...base, id: "b", title: "b", status: "failed" })).toBe("needs");
  expect(threadBucket({ ...base, id: "g", title: "g", group: "waiting-on-you" })).toBe("needs");
  expect(threadBucket({ ...base, id: "c", title: "c", group: "ready-for-review" })).toBe("ready");
  expect(threadBucket({ ...base, id: "d", title: "d", pr: { state: "open", review: "approved" } })).toBe("ready");
  expect(threadBucket({ ...base, id: "e", title: "e", paneId: "p", liveStatus: "working" })).toBe("working");
  expect(threadBucket({ ...base, id: "f", title: "f", status: "resolved" })).toBe("resolved");
  expect(prSummary({ number: 7, state: "open", review: "approved", checks: { passed: 6, failed: 0, pending: 0 } })).toBe("PR #7 · approved · checks passed");
  expect(prSummary({ number: 7, state: "open", checks: { passed: 4, failed: 0, pending: 2 } })).toBe("PR #7 · checks 4/6");
  expect(prSummary({ number: 7, state: "merged" })).toBe("PR #7 merged");
});

it("scopes a coordinator to the threads it runs", () => {
  const tree: ProjectView = { ...project, threads: [
    { id: "C", title: "Coord", parentId: "root", role: "coordinator", status: "open" },
    { id: "W1", title: "W1", parentId: "C", role: "worker", status: "open" },
    { id: "W2", title: "W2", parentId: "root", role: "worker", status: "open" },
    { id: "O", title: "Orphan", parentId: "gone", role: "worker", status: "open" },
  ] };
  expect(coordinatedThreads(tree, "C").map((t) => t.id)).toEqual(["W1"]);
  expect(coordinatedThreads(tree).map((t) => t.id)).toEqual(["C", "W2", "O"]);
  // Lists and counts at a coordinator cover what its own threads run too.
  expect(threadTree(tree).map((t) => t.id)).toEqual(["C", "W1", "W2", "O"]);
  expect(threadTree(tree, "C").map((t) => t.id)).toEqual(["W1"]);
});

it("closes a thread only after the in-app confirmation", async () => {
  let posted: unknown;
  server.use(http.post("/api/org/node/resolve", async ({ request }) => { posted = await request.json(); return HttpResponse.json({ ok: true }); }));
  const { user, onChanged } = setup();

  await user.click(screen.getByRole("button", { name: "Close Build" }));
  const dialog = screen.getByRole("dialog", { name: "Close this thread?" });
  await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(posted).toBeUndefined();
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

  await user.click(screen.getByRole("button", { name: "Close Build" }));
  await user.click(screen.getByRole("button", { name: "Close thread" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(posted).toEqual({ project: "hub", id: "T1" });
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("keeps the dialog open with the bridge's reason when closing fails", async () => {
  server.use(http.post("/api/org/node/resolve", () => HttpResponse.json({ ok: false, error: "Worktree is dirty." }, { status: 409 })));
  const { user, onChanged } = setup();
  await user.click(screen.getByRole("button", { name: "Close Build" }));
  await user.click(screen.getByRole("button", { name: "Close thread" }));
  expect(await within(screen.getByRole("dialog")).findByRole("alert")).toHaveTextContent("Worktree is dirty.");
  expect(onChanged).not.toHaveBeenCalled();
});

it("offers no close or new thread on a read-only device", () => {
  setup({ readOnly: true });
  expect(screen.queryByRole("button", { name: "Close Build" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "New thread" })).not.toBeInTheDocument();
});
