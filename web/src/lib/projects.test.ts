import { describe, expect, it } from "vitest";

import { groupByRecency, looseChats, projectChat, projectForPane, projectSummary, recencyOf } from "./projects";
import type { AgentView, ProjectView } from "./types";

const DAY = 86_400_000;
// Noon local time, so "today" has room on both sides regardless of the runner's timezone.
const now = new Date(2026, 9, 6, 12, 0, 0).getTime();

function pane(paneId: string, extra: Partial<AgentView> = {}): AgentView {
  return { paneId, workspaceId: "w", workspaceLabel: "w", workspaceNumber: 1, tabId: "t", agent: "claude", status: "idle", cwd: "/", focused: false, ...extra };
}

const project: ProjectView = {
  slug: "hub", name: "Hub", status: "active",
  coordinator: { paneId: "c", agent: "claude", liveStatus: "working" },
  threads: [
    { id: "T1", title: "Build", parentId: "root", role: "worker", status: "open", paneId: "a", liveStatus: "working" },
    { id: "T2", title: "Review", parentId: "root", role: "worker", status: "open", paneId: "b", liveStatus: "blocked" },
    { id: "T3", title: "Queued", parentId: "root", role: "worker", status: "starting" },
    { id: "T0", title: "Old", parentId: "root", role: "worker", status: "resolved", paneId: "z", liveStatus: "working" },
  ],
};

describe("recency", () => {
  it("splits at local midnight, at seven days and at thirty, and treats unknown times as older", () => {
    const midnight = new Date(2026, 9, 6).getTime();
    expect(recencyOf(midnight, now)).toBe("today");
    expect(recencyOf(midnight - 1, now)).toBe("week");
    expect(recencyOf(now - 7 * DAY + 1, now)).toBe("week");
    expect(recencyOf(now - 7 * DAY, now)).toBe("month");
    expect(recencyOf(now - 30 * DAY + 1, now)).toBe("month");
    expect(recencyOf(now - 30 * DAY, now)).toBe("older");
    expect(recencyOf(0, now)).toBe("older");
  });

  it("groups newest first into every period, an empty one included, as Cursor's history lists them", () => {
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
      ["Last 7 days", []],
      ["Last 30 days", ["month"]],
      ["Older", ["old", "unknown"]],
    ]);
  });
});

describe("project summary", () => {
  it("counts the live coordinator and open threads, never resolved ones", () => {
    expect(projectSummary(project)).toBe("2 working · 1 blocked");
  });

  it("falls back to paused, then to the open task count", () => {
    const quiet = { ...project, coordinator: undefined, threads: project.threads.filter((thread) => !thread.liveStatus) };
    expect(projectSummary(quiet)).toBe("1 open task");
    expect(projectSummary({ ...quiet, status: "paused" })).toBe("Paused");
    expect(projectSummary({ ...quiet, threads: [] })).toBe("No open tasks");
  });
});

describe("pane ownership", () => {
  it("finds the coordinator and thread panes, and leaves only the rest as chats", () => {
    expect(projectForPane([project], "c")).toEqual({ project });
    expect(projectForPane([project], "b")?.thread?.id).toBe("T2");
    expect(projectForPane([project], "nope")).toBeUndefined();
    expect(looseChats([pane("c"), pane("b"), pane("x")], [project]).map((chat) => chat.paneId)).toEqual(["x"]);
  });
});

describe("projectChat", () => {
  const pane = (paneId: string) => ({ paneId }) as AgentView;
  const worker = { id: "T1", title: "Build", parentId: "root", role: "worker", status: "open" } as const;
  const hub: ProjectView = { slug: "hub", name: "Hub", goal: "", status: "active", coordinator: { paneId: "coord", agent: "claude" }, threads: [worker] };

  it("is the project coordinator's chat while it runs, the page a back to the project lands on", () => {
    expect(projectChat(hub, [pane("coord")])).toBe("coord");
    expect(projectChat(hub, [])).toBeUndefined();
  });

  it("is none for a project that organizes coordinators: the project is their page", () => {
    const organizer = { ...hub, threads: [...hub.threads, { id: "L", title: "Lead", parentId: "root", role: "coordinator", status: "open" } as const] };
    expect(projectChat(organizer, [pane("coord")])).toBeUndefined();
  });
});
