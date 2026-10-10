import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { vi } from "vitest";

import type { ProjectView, TemplateView } from "@/lib/types";
import { server } from "@/test/setup";
import { NewNodeActions } from "./node-start";

const project: ProjectView = {
  slug: "nenu",
  name: "Nenu",
  status: "active",
  nodeActions: true,
  threads: [
    { id: "t-1000", title: "Release", parentId: "root", role: "coordinator", status: "open" },
    { id: "t-2000", title: "Worker", parentId: "root", role: "worker", status: "open" },
    { id: "t-3000", title: "Old plan", parentId: "root", role: "coordinator", status: "resolved" },
  ],
};

const template: TemplateView = {
  name: "review-worker",
  scope: "project",
  description: "Review a change",
  role: "worker",
  canSpawn: true,
  harness: "claude",
  model: "sonnet",
  reasoningEffort: "high",
  rulesChars: 40,
  memoryChars: 15,
  updated: "2026-09-30T10:00:00Z",
};

function serveOptions(options: { templates?: TemplateView[]; profiles?: string[] } = {}) {
  let requests = 0;
  server.use(http.get("/api/org/start-options", () => {
    requests += 1;
    return HttpResponse.json({ ok: true, templates: options.templates ?? [], profiles: options.profiles ?? ["claude", "codex"] });
  }));
  return () => requests;
}

function recordStart() {
  const posted: unknown[] = [];
  let url = "";
  server.use(http.post("/api/org/node/start", async ({ request }) => {
    posted.push(await request.json());
    url = request.url;
    return HttpResponse.json({ ok: true, node: { id: "t-4000" } });
  }));
  return { posted, url: () => url };
}

it("creates a coordinator under an open coordinator with the profile picked, reading options only once the form opens", async () => {
  const user = userEvent.setup();
  const onStarted = vi.fn();
  const requests = serveOptions();
  const start = recordStart();
  render(<NewNodeActions project={project} session="work" onStarted={onStarted} />);

  expect(requests()).toBe(0);
  await user.click(screen.getByRole("button", { name: "New coordinator" }));
  const dialog = within(screen.getByRole("dialog", { name: "New coordinator" }));
  await user.type(dialog.getByLabelText("Title"), "Billing");
  // Only open coordinators can take children; the resolved one and the worker are not offered.
  const parent = dialog.getByLabelText("Parent");
  expect(within(parent).getAllByRole("option").map((option) => option.textContent)).toEqual(["Project root", "Release"]);
  await user.selectOptions(parent, "t-1000");
  await user.selectOptions(await dialog.findByLabelText("Profile"), "codex");
  await user.type(dialog.getByLabelText("Task"), "Coordinate invoices and receipts.");
  await user.click(dialog.getByRole("button", { name: "Create coordinator" }));

  await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
  expect(start.posted).toEqual([{ project: "nenu", role: "coordinator", title: "Billing", parent: "t-1000", task: "Coordinate invoices and receipts.", profile: "codex" }]);
  expect(new URL(start.url()).searchParams.get("session")).toBe("work");
  expect(requests()).toBe(1);
  expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
});

it("starts a thread from a template, which carries its own profile", async () => {
  const user = userEvent.setup();
  serveOptions({ templates: [template, { ...template, name: "planner", role: "coordinator" }] });
  const start = recordStart();
  render(<NewNodeActions project={project} onStarted={() => {}} />);

  await user.click(screen.getByRole("button", { name: "New thread" }));
  const dialog = within(screen.getByRole("dialog", { name: "New thread" }));
  // Only templates of this role are offered.
  const select = await dialog.findByLabelText("Template");
  expect(within(select).getAllByRole("option").map((option) => option.textContent)).toEqual(["None", "review-worker · project"]);
  await user.selectOptions(select, "review-worker");
  expect(dialog.queryByLabelText("Profile")).not.toBeInTheDocument();
  await user.type(dialog.getByLabelText("Title"), "Review accessibility");
  await user.type(dialog.getByLabelText("Task"), "Review keyboard navigation.");
  await user.click(dialog.getByRole("button", { name: "Create thread" }));

  await waitFor(() => expect(start.posted).toEqual([{ project: "nenu", role: "worker", title: "Review accessibility", parent: "root", task: "Review keyboard navigation.", template: "review-worker" }]));
});

it("offers only a top-level thread when upstream herdr-projects runs the project", async () => {
  const user = userEvent.setup();
  serveOptions({ profiles: [] });
  render(<NewNodeActions project={{ ...project, nodeActions: false }} onStarted={() => {}} />);

  expect(screen.queryByRole("button", { name: "New coordinator" })).not.toBeInTheDocument();
  await user.click(screen.getByRole("button", { name: "New thread" }));
  const dialog = within(screen.getByRole("dialog", { name: "New thread" }));
  expect(dialog.queryByLabelText("Parent")).not.toBeInTheDocument();
  await waitFor(() => expect(dialog.getByLabelText("Profile")).toBeEnabled());
  expect(within(dialog.getByLabelText("Profile")).getAllByRole("option").map((option) => option.textContent)).toEqual(["Project default"]);
});

it("offers nothing to start in a paused project, which Organizations would refuse", () => {
  const { container } = render(<NewNodeActions project={{ ...project, status: "paused" }} onStarted={() => {}} />);
  expect(container).toBeEmptyDOMElement();
});

it("keeps the dialog open with Organizations' refusal", async () => {
  const user = userEvent.setup();
  serveOptions();
  server.use(http.post("/api/org/node/start", () => HttpResponse.json({ ok: false, error: "there is no profile `codex` allowed for coordinators" }, { status: 502 })));
  render(<NewNodeActions project={project} onStarted={() => {}} />);

  await user.click(screen.getByRole("button", { name: "New coordinator" }));
  const dialog = within(screen.getByRole("dialog", { name: "New coordinator" }));
  await user.type(dialog.getByLabelText("Title"), "Billing");
  await user.type(dialog.getByLabelText("Task"), "Coordinate billing.");
  await user.click(dialog.getByRole("button", { name: "Create coordinator" }));

  expect(await dialog.findByRole("alert")).toHaveTextContent("there is no profile `codex` allowed for coordinators");
  expect(dialog.getByLabelText("Title")).toHaveValue("Billing");
});
