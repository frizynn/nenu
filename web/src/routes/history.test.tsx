import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createMemoryRouter, Outlet, RouterProvider } from "react-router";

import { ROOT_ROUTE_ID, type HistoryData, type HomeData } from "@/lib/loaders";
import type { AgentView, TranscriptEntry } from "@/lib/types";
import { HistoryRoute } from "./history";

// jsdom has no element scrolling; the list pins itself to the newest turn on open.
beforeAll(() => { Element.prototype.scrollTo ??= () => {}; });

const pane = (paneId: string, extra: Partial<AgentView> = {}): AgentView => ({
  paneId, workspaceId: "w2", workspaceLabel: "api", workspaceNumber: 2, tabId: "w2:t1", agent: "codex", status: "idle", cwd: "/", focused: false, ...extra,
});

const turns = (count: number): TranscriptEntry[] => Array.from({ length: count }, (_, i) => ({
  uuid: `e-${i}`,
  ts: new Date(Date.UTC(2026, 9, 10, 12, 0, i)).toISOString(),
  role: i % 2 ? "assistant" : "user",
  parts: [{ kind: "text", text: `Message ${i}` }],
}));

function setup(paneId: string, history: Partial<HistoryData>, agents: AgentView[] = [], snapshot: Partial<HomeData> = {}) {
  const root: HomeData = { bridge: "connected", agents, shellPanes: [], workspaces: [], tabs: [], device: undefined,
    sessions: [], session: undefined, snoozedUntil: null, update: undefined, error: false, authError: false, ...snapshot };
  const data: HistoryData = { paneId, session: undefined, entries: [], hasMore: false, total: 0, fileTruncated: false, ...history };
  const router = createMemoryRouter([{
    id: ROOT_ROUTE_ID, path: "/", loader: () => root, element: <Outlet />,
    children: [
      { index: true, element: <p>HOME</p> },
      { path: "pane/:paneId", element: <p>PANE</p> },
      { path: "pane/:paneId/history", loader: () => data, element: <HistoryRoute /> },
    ],
  }], { initialEntries: [`/pane/${encodeURIComponent(paneId)}/history`] });
  render(<RouterProvider router={router} />);
  return { router, user: userEvent.setup() };
}

const header = async () => within(await screen.findByRole("banner"));

describe("history header", () => {
  it("names the pane the way every other view does, not by its workspace", async () => {
    setup("w2:codex", { entries: turns(4), total: 4 }, [pane("w2:codex", { terminalTitle: "Fix the header" })]);
    expect((await header()).getByText("Fix the header")).toBeInTheDocument();
    expect(screen.queryByText("api")).not.toBeInTheDocument();
  });

  it("never shows a pane's raw id, even once the pane is gone", async () => {
    setup("w9:ghost", { unavailable: "no-session" });
    await screen.findByRole("banner");
    expect(screen.queryByText(/w9:ghost/)).not.toBeInTheDocument();
  });

  it("offers Find only when there is something to find", async () => {
    setup("w2:codex", { unavailable: "no-session" }, [pane("w2:codex", { paneLabel: "Codex" })]);
    await screen.findByRole("heading", { name: "No conversation yet" });
    expect(screen.queryByRole("button", { name: "Find in history" })).not.toBeInTheDocument();
  });

  // jsdom applies no media queries, so each control's breakpoint is read off the class that hides it;
  // the bench captures (redesign-shots/system-coherence) show the two widths.
  it("goes back to its pane with one control at each width: the shared back on a phone, a close on the desk", async () => {
    setup("w1:idle", { entries: turns(4), total: 4 }, [pane("w1:idle", { paneLabel: "Idle Claude" })]);
    const bar = await header();
    const back = bar.getByRole("link", { name: "Back to Idle Claude" });
    const close = bar.getByRole("link", { name: "Close history" });
    expect(back).toHaveAttribute("href", "/pane/w1%3Aidle");
    expect(close).toHaveAttribute("href", "/pane/w1%3Aidle");
    expect(back).toHaveClass("lg:hidden");
    expect(close.closest(".max-lg\\:hidden")).not.toBeNull();
    expect(bar.queryByRole("button", { name: /^(Back|Close history)$/ })).not.toBeInTheDocument();
    // Titled like every other bar: the screen's name, then whose it is.
    expect(bar.getByRole("heading", { level: 1, name: "History" })).toBeInTheDocument();
  });

  it("goes back Home from a closed pane's history", async () => {
    setup("w9:ghost", { unavailable: "no-session" });
    expect((await header()).getByRole("link", { name: "Back to Home" })).toHaveAttribute("href", "/");
  });

  it("leaves the count out of the header", async () => {
    setup("w1:idle", { entries: turns(4), total: 4 }, [pane("w1:idle", { paneLabel: "Idle Claude" })]);
    expect((await header()).queryByText(/\d+\s*\/\s*\d+/)).not.toBeInTheDocument();
  });
});

describe("history list", () => {
  it("says how much of a long thread is showing where the older turns load", async () => {
    setup("w1:idle", { entries: turns(90), total: 90 }, [pane("w1:idle", { paneLabel: "Idle Claude" })]);
    expect(await screen.findByRole("button", { name: "Load older" })).toBeInTheDocument();
    expect(screen.getByText("Showing 60 of 90")).toBeInTheDocument();
  });

  it("marks the start of a thread that is all on screen, without a count", async () => {
    setup("w1:idle", { entries: turns(4), total: 4 }, [pane("w1:idle", { paneLabel: "Idle Claude" })]);
    expect(await screen.findByText("Start of the conversation")).toBeInTheDocument();
    expect(screen.queryByText(/^Showing/)).not.toBeInTheDocument();
  });
});

describe("history with nothing to read", () => {
  it("says why, names the pane and offers one way back to it", async () => {
    const { router, user } = setup("w2:codex", { unavailable: "no-session" }, [pane("w2:codex", { paneLabel: "Codex" })]);
    expect(await screen.findByRole("heading", { name: "No conversation yet" })).toBeInTheDocument();
    expect(screen.getByText(/no agent session in Codex/)).toBeInTheDocument();
    const main = screen.getByRole("main");
    // The way back is a link to the pane, the same as the bar's.
    expect(within(main).queryByRole("button")).not.toBeInTheDocument();
    expect(within(main).getAllByRole("link")).toHaveLength(1);
    await user.click(within(main).getByRole("link", { name: "Back to Codex" }));
    expect(router.state.location.pathname).toBe("/pane/w2%3Acodex");
  });

  it("says a closed pane is closed and sends its reader Home", async () => {
    const { router, user } = setup("w9:ghost", { unavailable: "no-session" });
    expect(await screen.findByRole("heading", { name: "This pane is closed" })).toBeInTheDocument();
    // The one action style every empty and error page shares: the large ink button.
    // Every empty state says the way home in the same words (not-found.tsx, pane-gone.tsx).
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Go to Home" })).toHaveClass("ui-button-lg", "bg-foreground", "text-body");
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Go to Home" })).not.toHaveClass("text-footnote");
    await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Go to Home" }));
    expect(router.state.location.pathname).toBe("/");
  });

  it("says a shell keeps no transcript, without promising one later", async () => {
    setup("w2:shell", { unavailable: "no-session" }, [], { shellPanes: [pane("w2:shell", { kind: "shell", paneLabel: "Shell" })] });
    expect(await screen.findByRole("heading", { name: "Shells keep no transcript" })).toBeInTheDocument();
    expect(screen.queryByText(/\byet\b/)).not.toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Back to Shell" })).toBeInTheDocument();
  });

  // A pane missing from a snapshot that failed, or from one taken while Herdr is down, may be alive.
  it("does not call a pane closed when the snapshot could not be read", async () => {
    const { router, user } = setup("w1:idle", { unavailable: "error" }, [], { bridge: undefined, error: true });
    expect(await screen.findByRole("heading", { name: "Couldn't read the transcript" })).toBeInTheDocument();
    expect(screen.queryByText(/closed/i)).not.toBeInTheDocument();
    expect(screen.getByText(/^Can’t reach Nenu\./)).toBeInTheDocument();
    await user.click(within(screen.getByRole("main")).getByRole("link", { name: "Back to the pane" }));
    expect(router.state.location.pathname).toBe("/pane/w1%3Aidle");
  });

  it("does not call a pane closed while Herdr is disconnected", async () => {
    setup("w1:idle", { unavailable: "error" }, [], { bridge: "disconnected" });
    expect(await screen.findByRole("heading", { name: "Couldn't read the transcript" })).toBeInTheDocument();
    expect(screen.queryByText(/closed/i)).not.toBeInTheDocument();
    expect(screen.getByText(/^Herdr isn’t responding\./)).toBeInTheDocument();
  });

  it("explains a transcript it could not read", async () => {
    setup("w1:idle", { unavailable: "error" }, [pane("w1:idle", { paneLabel: "Idle Claude" })]);
    expect(await screen.findByRole("heading", { name: "Couldn't read the transcript" })).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Back to Idle Claude" })).toBeInTheDocument();
  });
});
