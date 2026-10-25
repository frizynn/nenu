import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { expect, it } from "vitest";

import type { PaneDiff } from "@/lib/types";
import { server } from "@/test/setup";
import { DiffStat } from "./diff-stat";
// Loaded up front, as a phone has it cached: the lazy import then resolves at once, however busy the run.
import "./diff-viewer";

const diff: PaneDiff = {
  ok: true, pr: 1345, base: "main", head: "feat/build", source: "worktree",
  totals: { files: 4, additions: 7, deletions: 3 },
  files: [
    { path: "src/a.ts", status: "modified", additions: 2, deletions: 1, hunks: [
      { header: "@@ -1,4 +1,5 @@ export function a()", oldStart: 1, newStart: 1, lines: [" line 1", " line 2", "-line 3", "+line three", "+line 11", " line 4"] },
    ] },
    { path: "docs/new.md", from: "docs/old.md", status: "renamed", additions: 0, deletions: 0, hunks: [] },
    { path: "logo.png", status: "modified", additions: 0, deletions: 0, binary: true, omitted: "binary" },
    { path: "bun.lock", status: "modified", additions: 5, deletions: 2, omitted: "budget" },
  ],
  truncated: { bytes: true },
};

function serve(body: PaneDiff, seen: string[] = []) {
  server.use(http.get("/api/pane/:id/diff", ({ request, params }) => {
    seen.push(`${String(params.id)}?${new URL(request.url).searchParams.toString()}`);
    return HttpResponse.json(body);
  }));
  return seen;
}

it("is plain text when there is no pane to read the diff from", () => {
  render(<DiffStat diff={{ additions: 212, deletions: 148 }} />);
  expect(screen.getByText("+212")).toBeInTheDocument();
  expect(screen.queryByRole("button")).not.toBeInTheDocument();
});

it("opens the pull request's files, reading the diff only when opened", async () => {
  const seen = serve(diff);
  render(<DiffStat diff={{ additions: 212, deletions: 148 }} paneId="w1:p1" pr={1345} session="s" url="https://github.com/a/b/pull/1345" />);
  expect(seen).toEqual([]);
  await userEvent.click(screen.getByRole("button", { name: "View changes: 212 added, 148 removed" }));
  const viewer = await screen.findByRole("dialog", { name: "PR #1345 changes" });
  await waitFor(() => expect(within(viewer).getByText("4 files")).toBeInTheDocument());
  // The repo goes along: a fork's folder can see the same number in two repos.
  expect(seen).toEqual(["w1:p1?pr=1345&repo=a%2Fb&session=s"]);
  expect(within(viewer).getByText(/uncommitted edits included/)).toBeInTheDocument();
  expect(within(viewer).getByText(/over the size limit/)).toBeInTheDocument();

  // Files start folded: no line is drawn until one is opened.
  expect(within(viewer).queryByText("line three")).not.toBeInTheDocument();
  const file = within(viewer).getByRole("button", { name: /src\/a\.ts/ });
  expect(file).toHaveAttribute("aria-expanded", "false");
  await userEvent.click(file);
  expect(file).toHaveAttribute("aria-expanded", "true");
  expect(within(viewer).getByText("line three")).toBeInTheDocument();
  expect(within(viewer).getByText("@@ -1,4 +1,5 @@ export function a()")).toBeInTheDocument();

  expect(within(viewer).getByText("docs/old.md →", { exact: false })).toBeInTheDocument();
  expect(within(viewer).getByText("Binary file")).toBeInTheDocument();
  expect(within(viewer).getByText("Past the size limit")).toBeInTheDocument();
});

it("says how many files it lists when there are more", async () => {
  serve({ ...diff, totals: { files: 422, additions: 28163, deletions: 5513 }, truncated: { files: true } });
  render(<DiffStat diff={{ additions: 28163, deletions: 5513 }} paneId="w1:p1" pr={1345} />);
  await userEvent.click(screen.getByRole("button", { name: /View changes/ }));
  expect(await screen.findByText("Showing 4 of 422 files.")).toBeInTheDocument();
});

it("says why there is no diff, and offers GitHub", async () => {
  serve({ ok: false, reason: "head-missing", message: "This pane's folder is not on the pull request's branch." });
  render(<DiffStat diff={{ additions: 9340, deletions: 1452 }} paneId="w1:p1" pr={1352} url="https://github.com/a/b/pull/1352" />);
  await userEvent.click(screen.getByRole("button", { name: /View changes/ }));
  expect(await screen.findByText("This pane's folder is not on the pull request's branch.")).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /Open on GitHub/ })).toHaveAttribute("href", "https://github.com/a/b/pull/1352");
});

it("reads the diff again on every opening", async () => {
  const seen = serve(diff);
  render(<DiffStat diff={{ additions: 7, deletions: 3 }} paneId="w1:p1" pr={1345} />);
  await userEvent.click(screen.getByRole("button", { name: /View changes/ }));
  await screen.findByText("4 files");
  await userEvent.click(screen.getByRole("button", { name: "Close" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  await userEvent.click(screen.getByRole("button", { name: /View changes/ }));
  await screen.findByText("4 files");
  expect(seen).toEqual(["w1:p1?pr=1345", "w1:p1?pr=1345"]);
});
