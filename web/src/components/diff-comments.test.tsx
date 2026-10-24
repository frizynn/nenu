import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, RouterProvider } from "react-router";

import { diffCommentsFor, saveDiffComment } from "@/lib/diff-comments";
import { ROOT_ROUTE_ID } from "@/lib/loaders";
import type { AgentView, PaneDiff } from "@/lib/types";
import { DiffBody, type DiffRead } from "./diff-viewer";

// A changed line of a diff takes a comment for the pane the diff was read from: a "+" beside it on
// a desk, a tap on the line on a phone, a one-line box under it (Enter saves, Esc cancels), and the
// line marked once saved. Where that pane is not the open chat, the viewer says where they wait.

const diff: PaneDiff = {
  ok: true, pr: 42, base: "main", head: "e2e-demo", source: "worktree",
  totals: { files: 1, additions: 2, deletions: 1 },
  files: [{
    path: "app/cart.ts", status: "modified", additions: 2, deletions: 1,
    hunks: [{ header: "@@ -20,3 +20,4 @@", oldStart: 20, newStart: 20, lines: [" keep();", "-const total = items.length;", "+const total = sum(items);", "+const tax = total * rate;", " done();"] }],
  }],
};
const read: DiffRead = { state: "read", diff };
let pane = 0;
const nextPane = () => `w8:p${++pane}`;

/** The diff as a route draws it: `open` is the chat on screen, `target` the pane the diff was read from. */
function renderDiff(target: string | undefined, open = target ?? "w8:none", onLeave?: () => void) {
  const agents = [{ paneId: target ?? "", agent: "claude", kind: "agent", paneLabel: "Checkout flow" }] as AgentView[];
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID, path: "/", loader: () => ({ agents }),
    children: [{ path: "pane/:paneId", element: <DiffBody read={read} comments={target ? { paneId: target } : undefined} onLeave={onLeave} /> }],
  }], { initialEntries: [`/pane/${encodeURIComponent(open)}`] });
  render(<RouterProvider router={router} />);
  return router;
}

async function openFile(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: /app\/cart\.ts/ }));
}

it("offers a comment on each added or removed line, never on context", async () => {
  const user = userEvent.setup();
  renderDiff(nextPane());
  await openFile(user);
  expect(screen.getAllByRole("button", { name: /^Comment on/ }).map((b) => b.getAttribute("aria-label"))).toEqual([
    "Comment on removed app/cart.ts:21", "Comment on app/cart.ts:21", "Comment on app/cart.ts:22",
  ]);
});

it("saves a comment with Enter, for the diff's pane, and marks its line", async () => {
  const user = userEvent.setup();
  const target = nextPane();
  renderDiff(target);
  await openFile(user);
  await user.click(screen.getByRole("button", { name: "Comment on app/cart.ts:22" }));
  await user.type(screen.getByRole("textbox", { name: "Comment on app/cart.ts:22" }), "Round the tax{Enter}");
  expect(diffCommentsFor(target)).toEqual([{ path: "app/cart.ts", side: "+", line: 22, quote: "const tax = total * rate;", text: "Round the tax" }]);
  expect(screen.queryByRole("textbox", { name: "Comment on app/cart.ts:22" })).toBeNull();
  expect(screen.getByText("Round the tax")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Remove comment on app/cart.ts:22" })).toBeInTheDocument();
});

it("cancels with Esc, saving nothing and leaving the sheet around it open", async () => {
  const user = userEvent.setup();
  const target = nextPane();
  const sheet = vi.fn();
  window.addEventListener("keydown", sheet);
  try {
    renderDiff(target);
    await openFile(user);
    await user.click(screen.getByRole("button", { name: "Comment on removed app/cart.ts:21" }));
    const box = screen.getByRole("textbox", { name: "Comment on removed app/cart.ts:21" });
    await user.type(box, "Not this");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(diffCommentsFor(target)).toEqual([]);
    expect(sheet.mock.calls.filter(([event]) => (event as KeyboardEvent).key === "Escape")).toEqual([]);
  } finally {
    window.removeEventListener("keydown", sheet);
  }
});

it("opens the box from a tap on the line where nothing hovers", async () => {
  const user = userEvent.setup();
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({ matches: query === "(hover: none)", media: query })) as typeof window.matchMedia;
  try {
    renderDiff(nextPane());
    await openFile(user);
    await user.click(screen.getByText("const total = sum(items);"));
    expect(screen.getByRole("textbox", { name: "Comment on app/cart.ts:21" })).toHaveFocus();
  } finally {
    window.matchMedia = original;
  }
});

it("opens nothing from a click on the line where a pointer hovers: the + is the way", async () => {
  const user = userEvent.setup();
  renderDiff(nextPane());
  await openFile(user);
  await user.click(screen.getByText("const total = sum(items);"));
  expect(screen.queryByRole("textbox")).toBeNull();
});

it("edits a saved comment from its line, and removes it from there", async () => {
  const user = userEvent.setup();
  const target = nextPane();
  saveDiffComment(target, undefined, { path: "app/cart.ts", side: "+", line: 21, quote: "const total = sum(items);" }, "Use reduce");
  renderDiff(target);
  await openFile(user);
  await user.click(screen.getByRole("button", { name: "Edit comment on app/cart.ts:21" }));
  const box = screen.getByRole("textbox", { name: "Comment on app/cart.ts:21" });
  expect(box).toHaveValue("Use reduce");
  await user.clear(box);
  await user.type(box, "Keep sum{Enter}");
  expect(diffCommentsFor(target).map((c) => c.text)).toEqual(["Keep sum"]);
  await user.click(screen.getByRole("button", { name: "Remove comment on app/cart.ts:21" }));
  expect(diffCommentsFor(target)).toEqual([]);
});

it("offers nothing to comment when no pane is named", async () => {
  const user = userEvent.setup();
  renderDiff(undefined);
  await openFile(user);
  expect(screen.queryAllByRole("button", { name: /^Comment on/ })).toEqual([]);
});

describe("a diff of another thread than the open chat", () => {
  it("says how many comments wait for that thread, and opens its chat", async () => {
    const user = userEvent.setup();
    const target = nextPane();
    const onLeave = vi.fn();
    const router = renderDiff(target, "w8:coordinator", onLeave);
    await openFile(user);
    expect(screen.queryByText(/for Checkout flow/)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Comment on app/cart.ts:22" }));
    await user.type(screen.getByRole("textbox", { name: "Comment on app/cart.ts:22" }), "Round the tax{Enter}");
    expect(screen.getByText("1 comment for Checkout flow")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Open chat" }));
    expect(router.state.location.pathname).toBe(`/pane/${encodeURIComponent(target)}`);
    expect(onLeave).toHaveBeenCalledOnce();
  });

  it("says nothing where the open chat is the thread itself: its chips are right there", async () => {
    const user = userEvent.setup();
    const target = nextPane();
    saveDiffComment(target, undefined, { path: "app/cart.ts", side: "+", line: 22, quote: "const tax = total * rate;" }, "Round the tax");
    renderDiff(target, target);
    await openFile(user);
    expect(screen.queryByText(/comments? for/)).toBeNull();
  });
});
