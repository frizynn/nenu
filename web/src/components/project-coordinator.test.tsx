import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { vi } from "vitest";

import type { ProjectThreadView, ProjectView } from "@/lib/types";
import { server } from "@/test/setup";
import { ProjectTasks } from "./project-tasks";

const thread = (id: string, title: string, parentId: string, extra: Partial<ProjectThreadView> = {}): ProjectThreadView =>
  ({ id, title, parentId, role: "worker", status: "open", ...extra });

const project: ProjectView = {
  slug: "awam",
  name: "AWAM",
  goal: "Ship the redesign",
  status: "active",
  nodeActions: true,
  threads: [
    thread("t-1", "Hotfix", "root", { paneId: "w:hot", liveStatus: "working" }),
    thread("t-2", "Mobile", "root", { role: "coordinator", paneId: "w:mob", liveStatus: "idle" }),
    thread("t-3", "Landing", "t-2", { paneId: "w:land", liveStatus: "working" }),
    thread("t-4", "Depot", "t-2", { paneId: "w:depot", liveStatus: "blocked" }),
    thread("t-5", "Old plan", "root", { role: "coordinator", status: "resolved" }),
    thread("t-6", "Old step", "t-5", { status: "resolved" }),
  ],
};

function setup(overrides: Partial<ProjectView> = {}, props: { readOnly?: boolean } = {}) {
  const onChanged = vi.fn(async () => {});
  const onOpenPane = vi.fn();
  render(<ProjectTasks project={{ ...project, ...overrides }} panes={[]} session="work" readOnly={props.readOnly ?? false}
    onOpenPane={onOpenPane} onOpenNode={vi.fn()} onChanged={onChanged} now={Date.parse("2026-10-10T14:00:00Z")} />);
  return { onChanged, onOpenPane, user: userEvent.setup() };
}

it("starts the project coordinator and refreshes, so the route can open its chat", async () => {
  let posted: unknown;
  const message = "codex is not ready yet (agent_not_ready). If it shows a dialog, answer it in pane w1:p3; it primes itself from AGENTS.md.";
  server.use(http.post("/api/org/project/open", async ({ request }) => { posted = await request.json(); return HttpResponse.json({ ok: true, message }); }));
  const { onChanged, user } = setup();

  const coordinator = within(screen.getByRole("region", { name: "Project coordinator" }));
  expect(coordinator.getByText("Not running")).toBeInTheDocument();
  await user.click(coordinator.getByRole("button", { name: "Start coordinator" }));
  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(posted).toEqual({ project: "awam" });
  // Still here after the refresh (the agent waits on a dialog): Organizations' own line says where.
  expect(coordinator.getByRole("status")).toHaveTextContent(message);
});

it("shows why the coordinator did not start and lets the person try again", async () => {
  server.use(http.post("/api/org/project/open", () => HttpResponse.json({ ok: false, error: "the herdr session at /tmp/s is not reachable" }, { status: 502 })));
  const { onChanged, user } = setup();

  const coordinator = within(screen.getByRole("region", { name: "Project coordinator" }));
  await user.click(coordinator.getByRole("button", { name: "Start coordinator" }));
  expect(await coordinator.findByRole("alert")).toHaveTextContent("the herdr session at /tmp/s is not reachable");
  expect(coordinator.getByRole("button", { name: "Start coordinator" })).toBeEnabled();
  expect(onChanged).not.toHaveBeenCalled();
});

it("offers no start, close or new on a read-only device", () => {
  setup({}, { readOnly: true });
  expect(screen.getByText("Not running")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Start coordinator" })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /^Close/ })).not.toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "New thread" })).not.toBeInTheDocument();
});

it("keeps Start but drops New in a paused project, and New coordinator under upstream herdr-projects", () => {
  const { unmount } = render(<ProjectTasks project={{ ...project, status: "paused" }} panes={[]} readOnly={false} onOpenPane={() => {}} onOpenNode={() => {}} onChanged={() => {}} />);
  expect(screen.getByText("Paused")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Start coordinator" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "New thread" })).not.toBeInTheDocument();
  unmount();

  render(<ProjectTasks project={{ ...project, nodeActions: false }} panes={[]} readOnly={false} onOpenPane={() => {}} onOpenNode={() => {}} onChanged={() => {}} />);
  expect(screen.getByRole("button", { name: "New thread" })).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "New coordinator" })).not.toBeInTheDocument();
});
