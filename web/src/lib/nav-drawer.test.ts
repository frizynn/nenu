import { describe, expect, it } from "vitest";

import type { AgentView } from "@/lib/types";
import { drawerSections, RECENT_CHATS } from "./nav-drawer";

function pane(paneId: string, status: AgentView["status"], active: number, extra: Partial<AgentView> = {}): AgentView {
  return {
    paneId, workspaceId: "w", workspaceLabel: "Developer", workspaceNumber: 1, tabId: "t", agent: "claude", status,
    cwd: "/", focused: false, lastActiveAt: active, paneLabel: paneId, ...extra,
  };
}

describe("drawerSections", () => {
  it("lists what needs you newest first, then the other chats by last activity with the open one marked", () => {
    const agents = [
      pane("quiet", "idle", 10),
      pane("asks-old", "blocked", 20),
      pane("here", "working", 30, { lastSeenAt: 95 }),
      pane("asks-new", "blocked", 80),
      pane("done", "done", 90),
    ];
    const { needsYou, recent } = drawerSections({ agents }, "here");
    expect(needsYou.map((row) => row.pane.paneId)).toEqual(["asks-new", "asks-old"]);
    // A chat waiting on you is already above; Recent does not list it twice.
    expect(recent.map((row) => [row.pane.paneId, row.current])).toEqual([["here", true], ["done", false], ["quiet", false]]);
  });

  it("keeps Recent short", () => {
    const agents = Array.from({ length: RECENT_CHATS + 3 }, (_, i) => pane(`p${i}`, "idle", 100 - i));
    const { recent } = drawerSections({ agents }, undefined);
    expect(recent.map((row) => row.pane.paneId)).toEqual(["p0", "p1", "p2", "p3", "p4"]);
  });
});
