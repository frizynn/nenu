import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";

import type { ProjectThreadView, ProjectView, ThreadReport } from "@/lib/types";
import { server } from "@/test/setup";
import { OwnReport } from "./coordinator-summary";

// A thread's own page offers its whole report (ADR 0096), read only once it is opened.

const REPORT: ThreadReport = {
  title: "ACM-12 proposals", verdict: "needs-decision",
  text: "Status: needs-decision\n\n## Summary\nPick one.\n\n## Report\n| | A | B |\n| --- | --- | --- |\n| Drop-off | -20 % | -8 % |\n\n## Captures\n- today.png - Today",
  captures: [], deliverables: [],
};
const project: ProjectView = { slug: "acme", name: "Acme", status: "active", threads: [] };
const thread: ProjectThreadView = { id: "t-0021", title: "ACM-12 proposals", parentId: "t-0020", role: "worker", status: "resolved", verdict: "needs-decision" };

it("opens the whole report under the summary, with its table, read only when opened", async () => {
  const reads: string[] = [];
  server.use(http.get("/api/org/report", ({ request }) => {
    reads.push(new URL(request.url).search);
    return HttpResponse.json({ ok: true, report: REPORT });
  }));
  render(<OwnReport project={project} thread={thread} summary={{ id: "t-0021", summary: "Pick one.", captures: [], deliverables: [] }} />);
  expect(screen.getByText("Pick one.")).toBeInTheDocument();
  expect(reads).toEqual([]);
  await userEvent.setup().click(screen.getByRole("button", { name: "Full report" }));
  const full = screen.getByRole("region", { name: "Full report" });
  await within(full).findByRole("table");
  expect(within(full).getByRole("cell", { name: "-20 %" })).toBeInTheDocument();
  expect(full).not.toHaveTextContent("Status: needs-decision");
  expect(reads).toEqual(["?project=acme&thread=t-0021"]);
});
