import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { vi } from "vitest";

import type { ProjectView, TemplateView } from "@/lib/types";
import { server } from "@/test/setup";
import { NewThreadMenu } from "./new-thread-menu";

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

it("loads templates only when the menu opens and lists them with role and scope", async () => {
  const user = userEvent.setup();
  let requests = 0;
  server.use(http.get("/api/org/templates", () => { requests += 1; return HttpResponse.json({ ok: true, templates: [template] }); }));
  render(<NewThreadMenu project={project} session="work" onStarted={() => {}} />);

  expect(requests).toBe(0);
  await user.click(screen.getByRole("button", { name: "New thread" }));
  expect(await screen.findByRole("button", { name: /review-worker/ })).toHaveTextContent("review-worker · worker · project");
  expect(screen.getByText("Review a change")).toBeInTheDocument();
  expect(requests).toBe(1);
});

it("starts a template with the exact form values in an in-app dialog", async () => {
  const user = userEvent.setup();
  const onStarted = vi.fn();
  let posted: unknown;
  let requestUrl = "";
  serveTemplates();
  server.use(http.post("/api/org/node/start", async ({ request }) => {
    posted = await request.json();
    requestUrl = request.url;
    return HttpResponse.json({ ok: true, node: { id: "t-1234", parentId: "t-1000", role: "worker", template: "review-worker" } });
  }));
  render(<NewThreadMenu project={project} session="work" onStarted={onStarted} />);

  await user.click(screen.getByRole("button", { name: "New thread" }));
  await user.click(await screen.findByRole("button", { name: /review-worker/ }));
  const dialog = screen.getByRole("dialog", { name: "New review-worker thread" });
  expect(dialog).toBeInTheDocument();
  expect(screen.getByLabelText("Title")).toHaveValue("review-worker");
  expect(screen.getByRole("option", { name: "t-1000 · Coordinator" })).toBeInTheDocument();
  expect(screen.queryByRole("option", { name: "t-2000 · Worker" })).not.toBeInTheDocument();
  await user.clear(screen.getByLabelText("Title"));
  await user.type(screen.getByLabelText("Title"), "Review accessibility");
  await user.selectOptions(screen.getByLabelText("Parent"), "t-1000");
  await user.type(screen.getByLabelText("Task"), "Review keyboard navigation.");
  await user.click(screen.getByRole("button", { name: "Start thread" }));

  await waitFor(() => expect(onStarted).toHaveBeenCalledTimes(1));
  expect(posted).toEqual({
    project: "nenu",
    template: "review-worker",
    title: "Review accessibility",
    parent: "t-1000",
    task: "Review keyboard navigation.",
  });
  expect(new URL(requestUrl).searchParams.get("session")).toBe("work");
  expect(screen.queryByRole("button", { name: "Start thread" })).not.toBeInTheDocument();
});

it("shows the API error message in the menu", async () => {
  const user = userEvent.setup();
  server.use(http.get("/api/org/templates", () => HttpResponse.json({ ok: false, error: "Template CLI unavailable." }, { status: 502 })));
  render(<NewThreadMenu project={project} session="work" onStarted={() => {}} />);

  await user.click(screen.getByRole("button", { name: "New thread" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Template CLI unavailable.");
});
