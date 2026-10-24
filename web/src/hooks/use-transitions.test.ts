import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { setStatus } from "@/lib/status";
import type { AgentStatus, AgentView } from "@/lib/types";
import { useAgentTransitions } from "./use-transitions";

vi.mock("@/lib/status", () => ({ setStatus: vi.fn() }));
const notify = vi.mocked(setStatus);
const agent = (paneId: string, status: AgentStatus, extra: Partial<AgentView> = {}): AgentView => ({
  paneId, status, agent: "codex", workspaceId: "w1", workspaceLabel: "collie",
  workspaceNumber: 1, tabId: "w1:t1", cwd: "/work/collie", focused: false, ...extra,
});

function setup(agents: AgentView[], session?: string, openPaneId: string | null = null) {
  const hook = renderHook((props) => useAgentTransitions(props.agents, props.openPaneId, props.session), {
    initialProps: { agents, session, openPaneId },
  });
  return { ...hook, update: (next: AgentView[], activeSession = session, openPane = openPaneId) => {
    hook.rerender({ agents: next, session: activeSession, openPaneId: openPane });
  } };
}

beforeEach(() => notify.mockClear());

describe("useAgentTransitions", () => {
  it("does not announce the initial snapshot or newly discovered panes", () => {
    const { update } = setup([agent("one", "blocked")]);
    expect(notify).not.toHaveBeenCalled();
    act(() => update([agent("one", "blocked"), agent("new", "done")]));
    expect(notify).not.toHaveBeenCalled();
  });

  it("gives an agent asking for you a concise title and workspace/tab description", () => {
    const view = (status: AgentStatus) => agent("one", status, { agent: "claude", tabLabel: "Frontend" });
    const { update } = setup([view("working")]);
    act(() => update([view("blocked")]));
    expect(notify).toHaveBeenCalledExactlyOnceWith("Claude needs your input", "warn", undefined, {
      description: "collie · Frontend", background: true, to: "/pane/one",
    });
    act(() => update([view("blocked")]));
    expect(notify).toHaveBeenCalledOnce();
  });

  // Its row says "New" instead; a toast per finish chained over the phone's header and took its taps.
  it("raises nothing when agents finish, one or many", () => {
    const views = [agent("one", "working"), agent("two", "working")];
    const { update } = setup(views);
    act(() => update([agent("one", "done"), agent("two", "working")]));
    act(() => update([agent("one", "done"), agent("two", "done")]));
    expect(notify).not.toHaveBeenCalled();
  });

  // On a desk the bar marks the chat's row ("+1"), so a toast over the page would say it twice.
  it("raises no toast on a desk, where the sidebar marks the row instead", () => {
    const matchMedia = window.matchMedia;
    window.matchMedia = (query) => ({ matches: query === "(min-width: 1024px)", media: query }) as MediaQueryList;
    try {
      const { update } = setup([agent("one", "working"), agent("two", "working")]);
      act(() => update([agent("one", "done"), agent("two", "blocked")]));
      expect(notify).not.toHaveBeenCalled();
    } finally {
      window.matchMedia = matchMedia;
    }
  });

  it("does not notify the pane being read, including after navigating away from it", () => {
    const { update } = setup([agent("one", "working")], "qa", "one");
    act(() => update([agent("one", "blocked")]));
    act(() => update([agent("one", "blocked")], "qa", null));
    expect(notify).not.toHaveBeenCalled();
  });

  it("groups simultaneous asks once, and leaves out the agents that finished", () => {
    const views = [
      agent("one", "working", { workspaceLabel: "api" }),
      agent("two", "working", { workspaceLabel: "web" }),
      agent("three", "working", { workspaceLabel: "api" }),
      agent("four", "working", { workspaceLabel: "docs" }),
    ];
    const { update } = setup(views);
    act(() => update(views.map((view, index) => ({ ...view, status: index === 3 ? "done" : "blocked" }))));
    // Several at once open Home, whose Needs you lists them all.
    expect(notify).toHaveBeenCalledExactlyOnceWith("3 agents need your input", "warn", undefined, {
      description: "api, web", background: true, to: "/",
    });
  });

  it("resets the baseline on session changes when pane IDs are reused", () => {
    const { update } = setup([agent("one", "working")], "first");
    act(() => update([agent("one", "blocked")], "second"));
    expect(notify).not.toHaveBeenCalled();
    act(() => update([agent("one", "working")], "second"));
    act(() => update([agent("one", "blocked")], "second"));
    expect(notify).toHaveBeenCalledExactlyOnceWith("Codex needs your input", "warn", undefined, {
      description: "collie", background: true, to: "/pane/one?s=second",
    });
    act(() => update([agent("one", "blocked")], "first"));
    expect(notify).toHaveBeenCalledOnce();
  });

  it("ignores non-attention transitions and gives a reappearing pane a new baseline", () => {
    const { update } = setup([agent("one", "working")]);
    act(() => update([agent("one", "idle")]));
    act(() => update([agent("one", "unknown")]));
    act(() => update([]));
    act(() => update([agent("one", "blocked")]));
    expect(notify).not.toHaveBeenCalled();
  });

  it("names the pane the way its header does, not the CLI behind it", () => {
    const view = (status: AgentStatus) => agent("w1:working", status, { agent: "claude", paneLabel: "Working Claude", tabLabel: "redesign", workspaceLabel: "nenu" });
    const { update } = setup([view("working"), agent("w1:other", "working", { agent: "claude" })]);
    act(() => update([view("blocked"), agent("w1:other", "working", { agent: "claude" })]));
    expect(notify).toHaveBeenCalledExactlyOnceWith("Working Claude needs your input", "warn", undefined, {
      description: "nenu · redesign", background: true, to: "/pane/w1%3Aworking",
    });
  });

  it("falls back to Agent when the pane has no name at all", () => {
    const view = (status: AgentStatus) => agent("one", status, { agent: "" });
    const { update } = setup([view("working")]);
    act(() => update([view("blocked")]));
    expect(notify.mock.calls[0]?.[0]).toBe("Agent needs your input");
  });
});
