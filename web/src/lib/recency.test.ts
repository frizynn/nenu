import { describe, expect, it } from "vitest";

import { groupByRecency, recencyOf } from "./recency";
import type { AgentView } from "./types";

const DAY = 86_400_000;
// Noon local time, so "today" has room on both sides regardless of the runner's timezone.
const now = new Date(2026, 9, 6, 12, 0, 0).getTime();

function pane(paneId: string, extra: Partial<AgentView> = {}): AgentView {
  return { paneId, workspaceId: "w", workspaceLabel: "w", workspaceNumber: 1, tabId: "t", agent: "claude", status: "idle", cwd: "/", focused: false, ...extra };
}

describe("recency", () => {
  it("splits at local midnight, the one before, at seven days and at thirty, and treats unknown times as older", () => {
    const midnight = new Date(2026, 9, 6).getTime();
    expect(recencyOf(midnight, now)).toBe("today");
    expect(recencyOf(midnight - 1, now)).toBe("yesterday");
    expect(recencyOf(new Date(2026, 9, 5).getTime(), now)).toBe("yesterday");
    expect(recencyOf(new Date(2026, 9, 5).getTime() - 1, now)).toBe("week");
    expect(recencyOf(now - 7 * DAY + 1, now)).toBe("week");
    expect(recencyOf(now - 7 * DAY, now)).toBe("month");
    expect(recencyOf(now - 30 * DAY + 1, now)).toBe("month");
    expect(recencyOf(now - 30 * DAY, now)).toBe("older");
    expect(recencyOf(0, now)).toBe("older");
  });

  it("groups newest first under the periods that hold a chat, and draws no empty one", () => {
    const chats = [
      pane("old", { lastActiveAt: now - 40 * DAY }),
      pane("seen", { lastActiveAt: now - 20 * DAY, lastSeenAt: now - 60_000 }),
      pane("month", { lastActiveAt: now - 12 * DAY }),
      pane("active", { lastActiveAt: now - 1000 }),
      pane("unknown"),
    ];
    const groups = groupByRecency(chats, (chat) => Math.max(chat.lastActiveAt ?? 0, chat.lastSeenAt ?? 0), now);
    expect(groups.map((group) => [group.label, group.items.map((chat) => chat.paneId)])).toEqual([
      ["Today", ["active", "seen"]],
      ["Previous 30 days", ["month"]],
      ["Older", ["old", "unknown"]],
    ]);
  });
});
