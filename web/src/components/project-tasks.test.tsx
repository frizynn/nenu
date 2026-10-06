import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { vi } from "vitest";

import type { ProjectView } from "@/lib/types";
import { server } from "@/test/setup";
import { ProjectTasks } from "./project-tasks";

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

it("lists the coordinator and open tasks, marks the current one and folds resolved ones into History", async () => {
  const { user, onOpenPane } = setup();
  expect(screen.getByRole("heading", { name: "Hub" })).toBeInTheDocument();
  expect(screen.getByText("Ship it")).toBeInTheDocument();
  const build = screen.getByRole("button", { name: /^Build/ });
  expect(build).toHaveTextContent("codex · needs you");
  expect(build.closest("li")).toHaveAttribute("aria-current", "true");
  const history = screen.getByText("History").closest("details")!;
  expect(history).not.toHaveAttribute("open");
  expect(within(history).getByText("Audit")).toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: /Coordinator/ }));
  expect(onOpenPane).toHaveBeenCalledWith("c");
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
