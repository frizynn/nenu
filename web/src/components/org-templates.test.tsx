import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { vi } from "vitest";

import type { ProjectView, TemplateView } from "@/lib/types";
import { server } from "@/test/setup";
import { OrgTemplates } from "./org-templates";

const project: ProjectView = {
  slug: "nenu",
  name: "Nenu",
  status: "active",
  threads: [
    { id: "t-1000", title: "Coordinator", parentId: "root", role: "coordinator", status: "open" },
    { id: "t-2000", title: "Worker", parentId: "root", role: "worker", status: "open" },
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

function serveTemplates(templates: TemplateView[] = [template]) {
  server.use(http.get("/api/org/templates", () => HttpResponse.json({ ok: true, templates })));
}

it("lists templates with scope, role, description, and memory size", async () => {
  serveTemplates();
  render(<OrgTemplates project={project} session="work" readOnly={false} onChanged={() => {}} />);

  expect(await screen.findByText("review-worker")).toBeInTheDocument();
  expect(screen.getByText("project")).toBeInTheDocument();
  expect(screen.getByText("worker")).toBeInTheDocument();
  expect(screen.getByText("Review a change")).toBeInTheDocument();
  expect(screen.getByText("memory 15 chars")).toBeInTheDocument();
});

it("starts a template with the exact form values and notifies the project route", async () => {
  const user = userEvent.setup();
  const onChanged = vi.fn();
  let posted: unknown;
  let requestUrl = "";
  serveTemplates();
  server.use(http.post("/api/org/node/start", async ({ request }) => {
    posted = await request.json();
    requestUrl = request.url;
    return HttpResponse.json({ ok: true, node: { id: "t-1234", parentId: "t-1000", role: "worker", template: "review-worker" } });
  }));
  render(<OrgTemplates project={project} session="work" readOnly={false} onChanged={onChanged} />);

  await user.click(await screen.findByRole("button", { name: "Open" }));
  expect(screen.getByLabelText("Title")).toHaveValue("review-worker");
  expect(screen.getByRole("option", { name: "t-1000 · Coordinator" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "t-2000 · Worker" })).not.toBeInTheDocument();
  await user.clear(screen.getByLabelText("Title"));
  await user.type(screen.getByLabelText("Title"), "Review accessibility");
  await user.selectOptions(screen.getByLabelText("Parent"), "t-1000");
  await user.type(screen.getByLabelText("Task"), "Review keyboard navigation.");
  await user.click(screen.getByRole("button", { name: "Start" }));

  await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  expect(posted).toEqual({
    project: "nenu",
    template: "review-worker",
    title: "Review accessibility",
    parent: "t-1000",
    task: "Review keyboard navigation.",
  });
  expect(new URL(requestUrl).searchParams.get("session")).toBe("work");
  expect(screen.queryByRole("button", { name: "Start" })).not.toBeInTheDocument();
});

it("hides Open on a read-only device", async () => {
  serveTemplates();
  render(<OrgTemplates project={project} session="work" readOnly onChanged={() => {}} />);

  expect(await screen.findByText("review-worker")).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: "Open" })).not.toBeInTheDocument();
});

it("shows the API error message", async () => {
  server.use(http.get("/api/org/templates", () => HttpResponse.json({ ok: false, error: "Template CLI unavailable." }, { status: 502 })));
  render(<OrgTemplates project={project} session="work" readOnly={false} onChanged={() => {}} />);

  expect(await screen.findByRole("alert")).toHaveTextContent("Template CLI unavailable.");
});
