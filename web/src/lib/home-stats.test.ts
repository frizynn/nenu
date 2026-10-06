import { activityByHour, greeting, herdCounts, herdHeadline, jumpTargets, projectProgress } from "./home-stats";
import type { AgentView, ProjectView } from "./types";

const NOW = new Date(2026, 9, 7, 15, 30).getTime();
const MIN = 60_000;

function agent(paneId: string, status: AgentView["status"], extra: Partial<AgentView> = {}): AgentView {
  return { paneId, workspaceId: "w", workspaceLabel: "nenu", workspaceNumber: 1, tabId: "t", agent: "claude", status, cwd: "/dev/nenu", focused: false, ...extra };
}

const project: ProjectView = {
  slug: "hub", name: "Hub", status: "active",
  coordinator: { paneId: "coord", agent: "claude", liveStatus: "working" },
  threads: [
    { id: "t1", title: "Build", parentId: "root", role: "worker", status: "open", paneId: "worker" },
    { id: "t2", title: "Ship", parentId: "root", role: "worker", status: "resolved" },
    { id: "t3", title: "Docs", parentId: "root", role: "worker", status: "resolved" },
  ],
};

describe("herd counts and headline", () => {
  const herd = [
    agent("a", "blocked"),
    agent("b", "done", { lastActiveAt: NOW - MIN, lastSeenAt: NOW - 10 * MIN }),
    agent("c", "done", { lastActiveAt: NOW - 10 * MIN, lastSeenAt: NOW - MIN }),
    agent("d", "working"),
    agent("e", "idle"),
  ];

  it("buckets with the triage classifier, so a seen done agent rests", () => {
    expect(herdCounts(herd)).toEqual({ needs: 1, ready: 1, working: 1, recent: 2, total: 5 });
  });

  it("leads with the most urgent fact", () => {
    expect(herdHeadline(herdCounts(herd))).toBe("1 agent needs you");
    expect(herdHeadline(herdCounts([agent("a", "blocked"), agent("b", "blocked")]))).toBe("2 agents need you");
    expect(herdHeadline(herdCounts([agent("b", "done", { lastActiveAt: 2, lastSeenAt: 1 })]))).toBe("1 result ready to review");
    expect(herdHeadline(herdCounts([agent("d", "working"), agent("e", "working")]))).toBe("2 agents at work");
    expect(herdHeadline(herdCounts([agent("e", "idle")]))).toBe("All quiet");
    expect(herdHeadline(herdCounts([]))).toBe("What should we work on?");
  });

  it("greets by the local hour", () => {
    expect(greeting(new Date(2026, 9, 7, 3).getTime())).toBe("Working late");
    expect(greeting(new Date(2026, 9, 7, 9).getTime())).toBe("Good morning");
    expect(greeting(NOW)).toBe("Good afternoon");
    expect(greeting(new Date(2026, 9, 7, 21).getTime())).toBe("Good evening");
  });
});

describe("activityByHour", () => {
  it("counts each agent once, in the hour of its latest change, ending with the current hour", () => {
    const buckets = activityByHour([
      agent("a", "working", { lastActiveAt: NOW - 5 * MIN }),
      agent("b", "idle", { lastActiveAt: NOW - 20 * MIN }),
      agent("c", "idle", { lastActiveAt: NOW - 3 * 60 * MIN }),
      agent("d", "idle", { lastActiveAt: NOW - 13 * 60 * MIN }),
      agent("e", "idle"),
    ], NOW, 12);
    expect(buckets).toHaveLength(12);
    expect(buckets.at(-1)).toEqual({ start: new Date(2026, 9, 7, 15).getTime(), count: 2 });
    expect(buckets.at(-4)!.count).toBe(1);
    expect(buckets.reduce((sum, bucket) => sum + bucket.count, 0)).toBe(3);
  });

  it("is all zeros, never invented, when the bridge reports no timestamps", () => {
    expect(activityByHour([agent("a", "working")], NOW).every((bucket) => bucket.count === 0)).toBe(true);
  });
});

it("measures project progress as resolved over all tasks", () => {
  expect(projectProgress(project)).toEqual({ resolved: 2, total: 3, ratio: 2 / 3 });
  expect(projectProgress({ ...project, threads: [] })).toEqual({ resolved: 0, total: 0, ratio: 0 });
});

describe("jumpTargets", () => {
  const panes = [
    agent("coord", "working", { lastActiveAt: NOW - 30 * MIN }),
    agent("worker", "working", { lastActiveAt: NOW - 2 * MIN }),
    agent("chat-old", "idle", { paneLabel: "Changelog", lastActiveAt: NOW - 60 * MIN }),
    agent("chat-new", "blocked", { paneLabel: "Auth review", workspaceLabel: "api", lastActiveAt: NOW - 10 * MIN }),
  ];

  it("lists projects and loose chats by last movement, a project moving with its panes", () => {
    expect(jumpTargets(panes, [project]).map((target) => `${target.kind}:${target.id}`))
      .toEqual(["project:hub", "chat:chat-new", "chat:chat-old"]);
    expect(jumpTargets(panes, [project])[1]).toMatchObject({ label: "Auth review", detail: "api", status: "blocked" });
  });

  it("filters with the sidebar's matcher, including a project's task titles", () => {
    expect(jumpTargets(panes, [project], "auth").map((target) => target.id)).toEqual(["chat-new"]);
    expect(jumpTargets(panes, [project], "ship").map((target) => target.id)).toEqual(["hub"]);
    expect(jumpTargets(panes, [project], "nothing like this")).toEqual([]);
  });
});
