import { describe, expect, it } from "vitest";

import { groupChats, jumpTargets, looseChats, nestThreads, paneIdentity, paneTitle, projectForPane, projectGroups, projectSummary, recencyOf } from "./projects";
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
  it("splits at local midnight and at seven days, and treats unknown times as older", () => {
    const midnight = new Date(2026, 9, 6).getTime();
    expect(recencyOf(midnight, now)).toBe("today");
    expect(recencyOf(midnight - 1, now)).toBe("week");
    expect(recencyOf(now - 7 * DAY + 1, now)).toBe("week");
    expect(recencyOf(now - 7 * DAY, now)).toBe("older");
    expect(recencyOf(0, now)).toBe("older");
  });

  it("groups newest first, by the later of activity and last visit, skipping empty groups", () => {
    const groups = groupChats([
      pane("old", { lastActiveAt: now - 30 * DAY }),
      pane("seen", { lastActiveAt: now - 20 * DAY, lastSeenAt: now - 60_000 }),
      pane("active", { lastActiveAt: now - 1000 }),
      pane("unknown"),
    ], now);
    expect(groups.map((group) => [group.label, group.chats.map((chat) => chat.paneId)])).toEqual([
      ["Today", ["active", "seen"]],
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

describe("project groups", () => {
  const titles = (query: string) => projectGroups([project], query).map((group) =>
    [group.coordinator, group.open.map((thread) => thread.id), group.resolved.map((thread) => thread.id)]);

  it("splits open tasks from history and keeps every row when the project itself matches", () => {
    expect(titles("")).toEqual([[true, ["T1", "T2", "T3"], ["T0"]]]);
    expect(titles("hub")).toEqual([[true, ["T1", "T2", "T3"], ["T0"]]]);
  });

  it("narrows to matching tasks, including resolved ones, and drops projects with nothing left", () => {
    expect(titles("review")).toEqual([[false, ["T2"], []]]);
    expect(titles("old")).toEqual([[false, [], ["T0"]]]);
    expect(titles("nothing")).toEqual([]);
  });

  it("names a project pane after its task, or the coordinator", () => {
    expect(paneTitle(pane("b", { paneLabel: "raw" }), projectForPane([project], "b"))).toBe("Review");
    expect(paneTitle(pane("c"), projectForPane([project], "c"))).toBe("Coordinator");
    expect(paneTitle(pane("x", { paneLabel: "Loose" }), undefined)).toBe("Loose");
  });
});

it("nests threads by parent and lists an orphan or a parent loop at the root", () => {
  const t = (id: string, parentId: string) => ({ id, title: id, parentId, role: "worker" as const, status: "open" as const });
  const tree = nestThreads([t("a", "root"), t("b", "a"), t("c", "gone"), t("x", "y"), t("y", "x")]);
  expect(tree.map((node) => [node.thread.id, node.children.map((child) => child.thread.id)])).toEqual([["a", ["b"]], ["c", []], ["x", []], ["y", []]]);
});

describe("pane identity", () => {
  it("names a project pane by its thread and project, any other by its own name, workspace and tab", () => {
    expect(paneIdentity(pane("b", { tabLabel: "server" }), [project])).toEqual({ title: "Review", place: "Hub", tab: null });
    expect(paneIdentity(pane("c"), [project])).toEqual({ title: "Coordinator", place: "Hub", tab: null });
    expect(paneIdentity(pane("x", { paneLabel: "Changelog", workspaceLabel: "nenu", tabLabel: "docs" }), [project]))
      .toEqual({ title: "Changelog", place: "nenu", tab: "docs" });
    expect(paneIdentity(pane("y", { workspaceLabel: "" }), undefined)).toEqual({ title: "claude", place: "w", tab: null });
  });
});

describe("jump targets", () => {
  const MIN = 60_000;
  const panes = [
    pane("c", { lastActiveAt: now - 30 * MIN }),
    pane("a", { lastActiveAt: now - 2 * MIN }),
    pane("old", { paneLabel: "Changelog", lastActiveAt: now - 60 * MIN }),
    pane("new", { paneLabel: "Auth review", workspaceLabel: "api", lastActiveAt: now - 10 * MIN }),
  ];

  it("lists projects and loose chats by last movement, a project moving with its panes", () => {
    expect(jumpTargets(panes, [project]).map((target) => `${target.kind}:${target.id}`)).toEqual(["project:hub", "chat:new", "chat:old"]);
  });

  it("filters with the sidebar's matchers, including a project's thread titles", () => {
    expect(jumpTargets(panes, [project], "auth").map((target) => target.id)).toEqual(["new"]);
    expect(jumpTargets(panes, [project], "queued").map((target) => target.id)).toEqual(["hub"]);
    expect(jumpTargets(panes, [project], "nothing like this")).toEqual([]);
  });
});
