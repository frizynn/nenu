import { describe, expect, it } from "vitest";

import { deskChats, liveliest } from "./desk-nav";
import type { AgentView } from "./types";

const now = new Date(2026, 9, 6, 12, 0, 0).getTime();
const MIN = 60_000;

function pane(paneId: string, extra: Partial<AgentView> = {}): AgentView {
  return { paneId, workspaceId: "w1", workspaceLabel: "w1", workspaceNumber: 1, tabId: "t", agent: "claude", status: "idle", cwd: "/", focused: false, ...extra };
}

describe("the desk's chats", () => {
  it("lists every agent pane by its name, dated by when it last moved or was opened", () => {
    const agents = [pane("flow", { paneLabel: "Checkout flow", lastActiveAt: now - 2 * MIN }), pane("loose", { paneLabel: "loose", lastSeenAt: now - 3 * MIN })];
    expect(deskChats({ agents }).map((chat) => [chat.title, chat.paneId, chat.at])).toEqual([
      ["Checkout flow", "flow", now - 2 * MIN],
      ["loose", "loose", now - 3 * MIN],
    ]);
  });
});

describe("a row's state", () => {
  it("draws the most pressing state among the agents it holds", () => {
    expect(liveliest([pane("a", { status: "working" }), pane("b", { status: "blocked" })])).toBe("blocked");
    expect(liveliest([pane("a")])).toBeUndefined();
  });
});

describe("a chat's +1", () => {
  it("marks a chat that finished or needs you since it was last opened, and nothing else", () => {
    const agents = [
      pane("flow", { paneLabel: "flow", status: "done", lastActiveAt: now, lastSeenAt: now - MIN }),
      pane("asked", { paneLabel: "asked", status: "blocked", lastActiveAt: now, lastSeenAt: now - MIN }),
      pane("seen", { paneLabel: "seen", status: "blocked", lastActiveAt: now - MIN, lastSeenAt: now }),
      pane("busy", { paneLabel: "busy", status: "working", lastActiveAt: now, lastSeenAt: now - MIN }),
    ];
    expect(deskChats({ agents }).map((chat) => [chat.title, chat.unread])).toEqual([
      ["flow", true], ["asked", true], ["seen", false], ["busy", false],
    ]);
  });
});
