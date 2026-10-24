import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { PaneStrip } from "./pane-strip";
import type { AgentView } from "@/lib/types";

function pane(
  paneId: string,
  agent: string,
  kind: "agent" | "shell" = "agent",
  extra: Partial<AgentView> = {},
): AgentView {
  return {
    paneId,
    workspaceId: "w1",
    workspaceLabel: "proj",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent,
    status: "idle",
    cwd: "/home/proj",
    focused: false,
    kind,
    ...extra,
  };
}

describe("PaneStrip", () => {
  it("renders nothing when the tab holds fewer than two panes", () => {
    const { container } = render(
      <PaneStrip panes={[pane("w1:p1", "claude")]} currentPaneId="w1:p1" onSelect={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("lists every pane in the tab and marks the current one", () => {
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "codex"), pane("w1:p3", "shell", "shell")]}
        currentPaneId="w1:p2"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("claude")).toBeInTheDocument();
    expect(screen.getByText("codex")).toBeInTheDocument();
    expect(screen.getByText("shell")).toBeInTheDocument(); // shell panes show a "shell" label
    // The current pane (codex / w1:p2) is the one marked active.
    expect(screen.getByRole("button", { name: /codex/ })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: /claude/ })).not.toHaveAttribute("aria-current");
  });

  it("shows Claude's /rename session name on a pill when no user label is set", () => {
    render(
      <PaneStrip
        panes={[
          pane("w1:p1", "claude", "agent", { sessionName: "auth-refactor" }),
          // A user label still wins over the session name.
          pane("w1:p2", "claude", "agent", { sessionName: "ignored", paneLabel: "deploy" }),
        ]}
        currentPaneId="w1:p1"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getByText("auth-refactor")).toBeInTheDocument();
    expect(screen.getByText("deploy")).toBeInTheDocument();
    expect(screen.queryByText("ignored")).toBeNull();
  });

  it("names a pill once, without the pane id Herdr gave it", () => {
    render(
      <PaneStrip panes={[pane("w1:p1", "claude"), pane("w1:p2", "codex")]} currentPaneId="w1:p1" onSelect={vi.fn()} />,
    );
    // The name, then its status in words (the dot is colour only), and nothing else.
    expect(screen.getByRole("button", { name: "claude, idle" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "codex, idle" })).toBeInTheDocument();
    expect(screen.queryByText(/p1|p2/)).toBeNull();
  });

  it("numbers panes that share a name, and only those", () => {
    render(
      <PaneStrip
        panes={[
          pane("w1:p1", "claude", "agent", { paneLabel: "Payments adapter" }),
          pane("w1:p2", "claude", "agent", { paneLabel: "deploy" }),
          pane("w1:p3", "claude", "agent", { paneLabel: "Payments adapter" }),
        ]}
        currentPaneId="w1:p2"
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Payments adapter · 1, idle",
      "deploy, idle",
      "Payments adapter · 2, idle",
    ]);
  });

  it("names the actions sheet as its pill does", () => {
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude", "agent", { paneLabel: "Blocked Claude" }), pane("w1:p2", "codex")]}
        currentPaneId="w1:p2"
        onSelect={vi.fn()}
        onRenamed={vi.fn()}
        onClosed={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: /Blocked Claude/ }));
    expect(screen.getByRole("dialog", { name: "Blocked Claude" })).toBeInTheDocument();
  });

  // A destructive confirmation that says only "Payments adapter" doesn't say which of the two closes.
  it("names a repeated pane's sheet and its close confirmation with its number, as its pill does", async () => {
    const user = userEvent.setup();
    render(
      <PaneStrip
        panes={[
          pane("w1:p1", "claude", "agent", { paneLabel: "Payments adapter" }),
          pane("w1:p2", "claude", "agent", { paneLabel: "Payments adapter" }),
        ]}
        currentPaneId="w1:p1"
        onSelect={vi.fn()}
        onRenamed={vi.fn()}
        onClosed={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getAllByRole("button", { name: /Payments adapter/ })[1]!);
    expect(screen.getByRole("dialog", { name: "Payments adapter · 2" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Close pane" }));
    expect(screen.getByRole("heading", { name: "Close “Payments adapter · 2”?" })).toBeInTheDocument();
  });

  it("fires onSelect with the pane id when a pane is tapped", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "codex")]}
        currentPaneId="w1:p1"
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByRole("button", { name: /codex/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w1:p2");
  });

  // A long-press on a pill reaches the DOM as a `contextmenu` event (Android Chrome / right-click);
  // with the write actions wired it opens the actions sheet. This is the path the on-device bug broke.
  it("opens the actions sheet on a long-press (contextmenu) when actions are wired", () => {
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "codex")]}
        currentPaneId="w1:p1"
        onSelect={vi.fn()}
        onRenamed={vi.fn()}
        onClosed={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    fireEvent.contextMenu(screen.getByRole("button", { name: /codex/ }));
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
  });

  it("stays inert on contextmenu when the write actions are not wired", () => {
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "codex")]}
        currentPaneId="w1:p1"
        onSelect={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByRole("button", { name: /codex/ }));
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  // Tapping the already-active pill used to be a dead re-navigate (onSelect with the same id it's
  // already on). With actions wired, that tap now opens the same sheet a long-press would — so the
  // pill is never a dead tap.
  it("opens the actions sheet on a plain tap of the ACTIVE pill when actions are wired", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "codex")]}
        currentPaneId="w1:p1"
        onSelect={onSelect}
        onRenamed={vi.fn()}
        onClosed={vi.fn()}
      />,
    );
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
    await user.click(screen.getByRole("button", { name: /claude/ }));
    expect(screen.getByRole("button", { name: "Rename" })).toBeInTheDocument();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("marks the open pill, and only it, as opening its actions when they are wired", () => {
    render(
      <PaneStrip panes={[pane("w1:p1", "claude"), pane("w1:p2", "codex")]} currentPaneId="w1:p1" onSelect={vi.fn()} onRenamed={vi.fn()} onClosed={vi.fn()} />,
    );
    const open = screen.getByRole("button", { name: /claude/ });
    expect(open).toHaveAttribute("aria-haspopup", "dialog");
    expect(open.querySelector("[data-chip-actions]")).not.toBeNull();
    expect(screen.getByRole("button", { name: /codex/ }).querySelector("[data-chip-actions]")).toBeNull();
  });

  // A read-only device's sheet holds only a note, so the open pill promises nothing; a long-press
  // still shows the note.
  it("puts no actions affordance on the open pill on a read-only device", () => {
    render(
      <PaneStrip panes={[pane("w1:p1", "claude"), pane("w1:p2", "codex")]} currentPaneId="w1:p1" onSelect={vi.fn()} readOnly onRenamed={vi.fn()} onClosed={vi.fn()} />,
    );
    const open = screen.getByRole("button", { name: /claude/ });
    expect(open).not.toHaveAttribute("aria-haspopup");
    expect(open.querySelector("[data-chip-actions]")).toBeNull();
  });

  it("still navigates on a tap of an INACTIVE pill even when actions are wired", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "codex")]}
        currentPaneId="w1:p1"
        onSelect={onSelect}
        onRenamed={vi.fn()}
        onClosed={vi.fn()}
      />,
    );
    await user.click(screen.getByRole("button", { name: /codex/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w1:p2");
    expect(screen.queryByRole("button", { name: "Rename" })).toBeNull();
  });

  it("a tap of the ACTIVE pill still just re-selects (no-op) when actions are NOT wired", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(
      <PaneStrip
        panes={[pane("w1:p1", "claude"), pane("w1:p2", "codex")]}
        currentPaneId="w1:p1"
        onSelect={onSelect}
      />,
    );
    await user.click(screen.getByRole("button", { name: /claude/ }));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith("w1:p1");
  });
});
