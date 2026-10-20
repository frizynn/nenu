import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import type { OrgProjectDetail, ProjectView } from "@/lib/types";
import { server } from "@/test/setup";
import { __forgetContexts, prefetchContext, ProjectContext } from "./project-context";

// A desk project's Context: the files every thread receives as cards of their own, drawn as Markdown
// when opened; a return paints the last read at once, and a hover's read is the one the tab joins.

const project: ProjectView = { slug: "hub", name: "Hub", goal: "Ship it", status: "active", source: "json", nodeActions: true, threads: [] };
const detail: OrgProjectDetail = {
  instructions: "# Instructions\n\n- Read **AGENTS.md** first",
  memory: "# Memory\n\n- [Merges](memory/merges.md): how main merges",
  memoryFiles: [{ name: "merges.md", text: "# Merges\n\nA merge commit, never a squash." }],
  repos: [], coordinatorProfile: "", threadProfile: "", maxParallelThreads: 0,
};

let reads = 0;
beforeEach(() => {
  __forgetContexts();
  reads = 0;
  server.use(http.get("/api/org/context", () => {
    reads++;
    return HttpResponse.json({ ok: true, detail, routines: null });
  }));
});

test("each file is its own card, its Markdown drawn under its header when opened", async () => {
  render(<ProjectContext project={project} threads={[]} />);
  const memory = await screen.findByRole("button", { name: /MEMORY\.md/ });
  const files = screen.getByRole("region", { name: "Every thread receives" });
  expect(within(files).getAllByRole("listitem")).toHaveLength(3);
  expect(within(files).queryByText("Memory")).toBeNull();
  await userEvent.click(memory);
  expect(memory).toHaveAttribute("aria-expanded", "true");
  // Drawn as Markdown, not as its source: the heading without its `#`, the link without its brackets.
  expect(within(files).getByText("Memory")).toHaveClass("text-headline");
  expect(within(files).queryByText(/\[Merges\]/)).toBeNull();
  expect(within(files).getByText("Merges: how main merges")).toBeInTheDocument();
});

test("a return paints the last read at once and does not read again while it is fresh", async () => {
  const first = render(<ProjectContext project={project} threads={[]} />);
  await screen.findByRole("button", { name: /PROJECT\.md/ });
  first.unmount();
  render(<ProjectContext project={project} threads={[]} />);
  expect(screen.getByRole("button", { name: /PROJECT\.md/ })).toBeInTheDocument();
  expect(screen.queryByRole("status")).toBeNull();
  expect(reads).toBe(1);
});

test("the tab joins the read a hover started", async () => {
  prefetchContext("hub");
  prefetchContext("hub");
  render(<ProjectContext project={project} threads={[]} />);
  expect(screen.getByRole("status")).toHaveTextContent("Reading the project");
  await screen.findByRole("button", { name: /PROJECT\.md/ });
  expect(reads).toBe(1);
});
