import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { PaneDiff } from "@/lib/types";
import { server } from "@/test/setup";
import { InspectorToggle, panelLink, SessionInspector, useSessionInspector, type SessionPr } from "./session-inspector";
// Loaded up front, as a desk has it cached: the lazy import then resolves at once.
import "./inspector-panels";

const branch: PaneDiff = {
  ok: true, base: "main", head: "feat/checkout", source: "worktree",
  totals: { files: 3, additions: 4, deletions: 2 },
  files: [
    { path: "app/cart.ts", status: "modified", additions: 3, deletions: 1, hunks: [
      { header: "@@ -1,3 +1,5 @@", oldStart: 1, newStart: 1, lines: [" a", "-b", "+bee", "+c", "+d"] },
    ] },
    { path: "notes.txt", status: "added", additions: 0, deletions: 0, omitted: "untracked" },
    { path: ".env", status: "modified", additions: 1, deletions: 1, omitted: "private" },
  ],
};
const uncommitted: PaneDiff = { ...branch, source: "uncommitted", base: "feat/checkout", totals: { files: 1, additions: 0, deletions: 0 }, files: [branch.files[1]!] };

let seen: string[] = [];
const desk = window.matchMedia;
function deskWidth(on: boolean) {
  window.matchMedia = ((query: string) => ({ matches: on && query === "(min-width: 1024px)", media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false })) as typeof window.matchMedia;
}

beforeEach(() => {
  seen = [];
  deskWidth(true);
  server.use(
    http.get("/api/pane/:id/diff", ({ request }) => {
      const scope = new URL(request.url).searchParams.get("scope");
      seen.push(`diff?scope=${scope}`);
      return HttpResponse.json(scope === "uncommitted" ? uncommitted : branch);
    }),
    http.get("/api/pane/:id/files", ({ request }) => {
      seen.push(`files?${new URL(request.url).searchParams.toString()}`);
      return HttpResponse.json({ path: ".", files: [{ name: "app", path: "app", kind: "directory", size: 0, updatedAt: "" }], truncated: false });
    }),
    http.get("/api/pane/:id/history", () => {
      seen.push("history");
      return HttpResponse.json({ available: true, entries: [], total: 0, hasMore: false, fileTruncated: false });
    }),
    http.get("/api/pane/:id/activity", () => {
      seen.push("activity");
      return HttpResponse.json({ available: false });
    }),
  );
});
afterEach(() => {
  window.matchMedia = desk;
});

function Desk({ pr, artifacts = true }: { pr?: SessionPr; artifacts?: boolean }) {
  const inspector = useSessionInspector();
  if (!inspector.desk) return <p>phone</p>;
  return <>
    {!inspector.open && <InspectorToggle inspector={inspector} pr={pr} />}
    {inspector.open && <SessionInspector inspector={inspector} paneId="w1:p1" artifacts={artifacts} pr={pr} />}
  </>;
}
const panel = () => screen.getByRole("complementary", { name: "Session panel" });

it("reads only the tab on screen: Changes first, Files and its Artifacts when picked", async () => {
  render(<Desk />);
  // The panel is a chunk of its own; React resolves it once, on the first render.
  await screen.findByRole("complementary", { name: "Session panel" });
  await within(panel()).findByRole("button", { name: /app\/cart\.ts/ });
  expect(seen).toEqual(["diff?scope=branch"]);

  await userEvent.click(within(panel()).getByRole("tab", { name: /Files/ }));
  await within(panel()).findByText("app");
  expect(seen).toEqual(["diff?scope=branch", "files?path=."]);

  await userEvent.click(within(panel()).getByRole("radio", { name: "Artifacts" }));
  await within(panel()).findByText("No artifacts in this conversation");
  expect(seen.slice(2).sort()).toEqual(["activity", "history"]);
});

it("shows a session's changes without a pull request, Branch or Uncommitted", async () => {
  render(<Desk />);
  expect(await within(panel()).findByText(/This session's worktree on/)).toBeInTheDocument();
  expect(within(panel()).queryByRole("link", { name: /Open on GitHub/ })).not.toBeInTheDocument();
  expect(within(panel()).getByText("Untracked, not in git yet")).toBeInTheDocument();
  // A credential file is named among the changes, its lines never shown.
  expect(within(panel()).getByText("Private file, not shown")).toBeInTheDocument();

  const scope = within(panel()).getByRole("radiogroup", { name: "Diff scope" });
  expect(within(scope).getByRole("radio", { name: "Branch" })).toHaveAttribute("aria-checked", "true");
  await userEvent.click(within(scope).getByRole("radio", { name: "Uncommitted" }));
  expect(await within(panel()).findByText(/What is not committed on/)).toBeInTheDocument();
  expect(seen).toEqual(["diff?scope=branch", "diff?scope=uncommitted"]);

  // The file opens in place, its lines as text.
  await userEvent.click(within(scope).getByRole("radio", { name: "Branch" }));
  await userEvent.click(await within(panel()).findByRole("button", { name: /app\/cart\.ts/ }));
  expect(within(panel()).getByText("bee")).toBeInTheDocument();
});

it("leads Changes with the pull request: number, branches, checks, review and GitHub", async () => {
  const pr: SessionPr = { number: 42, title: "Checkout flow", url: "https://github.com/acme/shop/pull/42", head: "feat/checkout", base: "main",
    review: "review_required", checks: { passed: 6, failed: 0, pending: 0 }, diff: { additions: 44, deletions: 16 } };
  render(<Desk pr={pr} />);
  const summary = await within(panel()).findByRole("region", { name: "Pull request #42" });
  expect(within(summary).getByText("Checkout flow")).toBeInTheDocument();
  expect(within(summary).getByText("feat/checkout → main")).toBeInTheDocument();
  expect(within(summary).getByText("CI 6/6")).toBeInTheDocument();
  expect(within(summary).getByText("Review required")).toBeInTheDocument();
  expect(within(summary).getByRole("link", { name: /Open on GitHub/ })).toHaveAttribute("href", pr.url);
});

it("folds with ⌘⌥B or its button, and a desk remembers it and the width", async () => {
  const { unmount } = render(<Desk pr={{ number: 42, title: "Checkout flow", diff: { additions: 44, deletions: 16 } }} />);
  await within(panel()).findByRole("button", { name: /app\/cart\.ts/ });
  // Typing in a field, the shortcut folds the panel and leaves the cursor there.
  const field = document.body.appendChild(document.createElement("textarea"));
  field.focus();
  fireEvent.keyDown(field, { key: "∫", code: "KeyB", metaKey: true, altKey: true });
  expect(screen.queryByRole("complementary", { name: "Session panel" })).not.toBeInTheDocument();
  expect(field).toHaveFocus();
  field.remove();
  const toggle = screen.getByRole("button", { name: "Show session panel" });
  expect(toggle).toHaveTextContent("+44 −16");

  await userEvent.click(toggle);
  const separator = within(panel()).getByRole("separator", { name: "Resize session panel" });
  expect(separator).toHaveAttribute("aria-valuenow", "460");
  fireEvent.keyDown(separator, { key: "ArrowLeft" });
  expect(separator).toHaveAttribute("aria-valuenow", "476");
  await userEvent.click(within(panel()).getByRole("button", { name: "Hide session panel" }));
  expect(screen.getByRole("button", { name: "Show session panel" })).toHaveFocus();
  unmount();

  render(<Desk />);
  expect(screen.queryByRole("complementary", { name: "Session panel" })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole("button", { name: "Show session panel" }));
  expect(within(panel()).getByRole("separator", { name: "Resize session panel" })).toHaveAttribute("aria-valuenow", "476");
});

it("still opens and folds when the browser refuses storage", async () => {
  const original = Storage.prototype.getItem;
  const set = Storage.prototype.setItem;
  Storage.prototype.getItem = () => { throw new Error("blocked"); };
  Storage.prototype.setItem = () => { throw new Error("blocked"); };
  try {
    render(<Desk />);
    expect(panel()).toBeInTheDocument();
    await userEvent.click(within(panel()).getByRole("button", { name: "Hide session panel" }));
    expect(screen.getByRole("button", { name: "Show session panel" })).toBeInTheDocument();
  } finally {
    Storage.prototype.getItem = original;
    Storage.prototype.setItem = set;
  }
});

it("offers Changes, Files and Terminal, and no Artifacts for a shell", async () => {
  render(<Desk artifacts={false} />);
  await within(panel()).findByRole("button", { name: /app\/cart\.ts/ });
  const tabs = within(within(panel()).getByRole("tablist", { name: "Session" })).getAllByRole("tab").map((tab) => tab.textContent);
  expect(tabs).toEqual(["Changes", "Files", "Terminal"]);
  await userEvent.click(within(panel()).getByRole("tab", { name: /Files/ }));
  await within(panel()).findByText("app");
  expect(within(panel()).queryByRole("radio", { name: "Artifacts" })).not.toBeInTheDocument();
});

it("folds after its slide out, and an open during the slide keeps the panel where it is", async () => {
  const finishes: Array<() => void> = [];
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ finished: new Promise<void>((resolve) => finishes.push(resolve)), cancel }));
  Object.defineProperty(HTMLElement.prototype, "animate", { value: animate, configurable: true });
  try {
    render(<Desk />);
    await within(panel()).findByRole("button", { name: /app\/cart\.ts/ });
    await userEvent.click(within(panel()).getByRole("button", { name: "Hide session panel" }));
    // Still on screen while it slides out; the shortcut then brings it back instead of folding twice.
    expect(panel()).toBeInTheDocument();
    act(() => { fireEvent.keyDown(window, { key: "∫", code: "KeyB", metaKey: true, altKey: true }); });
    expect(cancel).toHaveBeenCalledOnce();
    await act(async () => { finishes[0]!(); });
    expect(panel()).toBeInTheDocument();

    await userEvent.click(within(panel()).getByRole("button", { name: "Hide session panel" }));
    await act(async () => { finishes[1]!(); });
    expect(screen.getByRole("button", { name: "Show session panel" })).toBeInTheDocument();
  } finally {
    delete (HTMLElement.prototype as { animate?: unknown }).animate;
  }
});

it("has no panel and no shortcut on a phone", async () => {
  deskWidth(false);
  render(<Desk />);
  expect(screen.getByText("phone")).toBeInTheDocument();
  act(() => { fireEvent.keyDown(window, { key: "∫", code: "KeyB", metaKey: true, altKey: true }); });
  await waitFor(() => expect(seen).toEqual([]));
});

/** A desk whose chat reads the panel's link the way agent-chat.tsx does. */
function LinkedDesk() {
  const inspector = useSessionInspector();
  const link = panelLink(inspector);
  return <>
    <p data-testid="slots">{link.terminal ? `mirror:${link.terminal.mirror.isConnected} controls:${link.terminal.controls.isConnected}` : "none"}</p>
    <button type="button" onClick={link.showTerminal}>Show terminal</button>
    {!inspector.open && <InspectorToggle inspector={inspector} />}
    {inspector.open && <SessionInspector inspector={inspector} paneId="w1:p1" artifacts />}
  </>;
}

it("adds Terminal last, and lends its places to the chat only while it is on screen", async () => {
  render(<LinkedDesk />);
  await within(panel()).findByRole("button", { name: /app\/cart\.ts/ });
  expect(within(panel()).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Changes", "Files", "Terminal"]);
  expect(screen.getByTestId("slots")).toHaveTextContent("none");

  await userEvent.click(within(panel()).getByRole("tab", { name: /Terminal/ }));
  expect(screen.getByTestId("slots")).toHaveTextContent("mirror:true controls:true");
  // A tab of its own reads nothing: the chat draws the mirror and the controls into it.
  expect(seen).toEqual(["diff?scope=branch"]);

  await userEvent.click(within(panel()).getByRole("button", { name: "Hide session panel" }));
  expect(screen.getByTestId("slots")).toHaveTextContent("none");
  await userEvent.click(screen.getByRole("button", { name: "Show terminal" }));
  expect(within(panel()).getByRole("tab", { name: /Terminal/ })).toHaveAttribute("aria-selected", "true");
  expect(screen.getByTestId("slots")).toHaveTextContent("mirror:true controls:true");
});
