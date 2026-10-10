import type { ActivityResponse, ActivityWorkflow } from "./activity";
import { finishedNotices, greeting, homeHeadline, jumpTargets, needsYouItems, projectStateCounts, reviewItems, runningWorkflows } from "./home-stats";
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

describe("headline", () => {
  it("names what needs you and what is ready, never a list", () => {
    expect(homeHeadline({ needs: 2, review: 2, working: 5 }, 9)).toBe("2 threads need you, 2 are ready to review");
    expect(homeHeadline({ needs: 1, review: 0, working: 5 }, 9)).toBe("1 thread needs you");
    expect(homeHeadline({ needs: 0, review: 1, working: 0 }, 9)).toBe("1 result ready to review");
    expect(homeHeadline({ needs: 0, review: 0, working: 2 }, 9)).toBe("2 agents at work");
    expect(homeHeadline({ needs: 0, review: 0, working: 0 }, 9)).toBe("All quiet");
    expect(homeHeadline({ needs: 0, review: 0, working: 0 }, 0)).toBe("What should we work on?");
  });

  it("keeps the phone's to two facts", () => {
    expect(homeHeadline({ needs: 2, review: 0, working: 5 }, 9, true)).toBe("2 need you · 5 working");
    expect(homeHeadline({ needs: 1, review: 3, working: 5 }, 9, true)).toBe("1 needs you · 3 to review");
    expect(homeHeadline({ needs: 0, review: 0, working: 0 }, 1, true)).toBe("All quiet");
  });

  it("greets by the local hour", () => {
    expect(greeting(new Date(2026, 9, 7, 3).getTime())).toBe("Working late");
    expect(greeting(new Date(2026, 9, 7, 9).getTime())).toBe("Good morning");
    expect(greeting(NOW)).toBe("Good afternoon");
    expect(greeting(new Date(2026, 9, 7, 21).getTime())).toBe("Good evening");
  });
});

it("lists dialogs oldest first, then blocked panes the bridge read no dialog on", () => {
  const agents = [agent("a", "blocked", { lastActiveAt: 5 }), agent("b", "blocked"), agent("c", "blocked", { lastActiveAt: 1 }), agent("d", "working")];
  const items = needsYouItems(agents, [{ paneId: "b", detectedAt: 20 }, { paneId: "a", detectedAt: 10 }]);
  expect(items.map((item) => `${item.paneId}:${item.interaction ? "asks" : "blocked"}`)).toEqual(["a:asks", "b:asks", "c:blocked"]);
});

describe("review and project state", () => {
  const hub: ProjectView = {
    slug: "hub", name: "Hub", status: "active", source: "json",
    coordinator: { paneId: "coord", agent: "codex", liveStatus: "working" },
    threads: [
      { id: "t1", title: "Coordinator", parentId: "root", role: "coordinator", status: "open", paneId: "coord", liveStatus: "working", group: "working" },
      { id: "t2", title: "Panel", parentId: "t1", role: "worker", status: "open", paneId: "p2", liveStatus: "done", group: "ready-for-review", pr: { state: "open", number: 12 } },
      { id: "t3", title: "Asks", parentId: "t1", role: "worker", status: "open", paneId: "p3", liveStatus: "blocked", group: "ready-for-review" },
      { id: "t4", title: "Idle", parentId: "t1", role: "worker", status: "open", paneId: "p4", liveStatus: "idle", group: "idle" },
      { id: "t5", title: "Shipped", parentId: "t1", role: "worker", status: "resolved", group: "resolved" },
    ],
  };

  it("takes Organizations' ready-for-review group, unless the thread is asking", () => {
    expect(reviewItems([hub]).map((item) => item.thread.id)).toEqual(["t2"]);
  });

  it("falls back to an open pull request on a stopped agent for a files-only project", () => {
    const files: ProjectView = { ...hub, source: "files", threads: hub.threads.map(({ group: _group, ...thread }) => thread) };
    expect(reviewItems([files]).map((item) => item.thread.id)).toEqual(["t2"]);
  });

  it("counts open threads by their dot, the coordinator once", () => {
    expect(projectStateCounts(hub)).toEqual({ blocked: 1, working: 1, review: 1, idle: 1 });
    expect(projectStateCounts({ ...hub, threads: [] })).toEqual({ blocked: 0, working: 1, review: 0, idle: 0 });
  });
});

describe("background work", () => {
  const wf = (runId: string, status: ActivityWorkflow["status"], updatedAt?: number): ActivityWorkflow =>
    ({ runId, name: runId, status, updatedAt, phases: [], agentCount: 2, doneCount: 2 });
  const res = (workflows: ActivityWorkflow[], tasks: Extract<ActivityResponse, { available: true }>["tasks"] = []): ActivityResponse =>
    ({ available: true, sessionKey: "s", workflows, tasks, artifacts: [], truncated: false });

  it("announces work that ended since the thread was last opened, newest first", () => {
    const activity = new Map<string, ActivityResponse>([
      ["a", res([wf("old", "completed", NOW - 30 * MIN), wf("new", "failed", NOW - 5 * MIN), wf("live", "running")],
        [{ id: "k", kind: "bash", title: "Typecheck", status: "failed", exitCode: 2, at: NOW - 10 * MIN, hasOutput: true },
         { id: "ok", kind: "bash", title: "Build", status: "completed", at: NOW - 2 * MIN, hasOutput: true }])],
      ["b", res([wf("seen", "completed", NOW - 30 * MIN)])],
      ["gone", res([wf("orphan", "completed", NOW - MIN)])],
    ]);
    const notices = finishedNotices(activity, [agent("a", "idle", { lastSeenAt: NOW - 60 * MIN }), agent("b", "idle", { lastSeenAt: NOW - 20 * MIN })], NOW);
    expect(notices.map((n) => `${n.kind}:${n.id}:${n.failed}`)).toEqual(["workflow:new:true", "task:k:true", "workflow:old:false"]);
    expect(runningWorkflows(activity).map((r) => `${r.paneId}:${r.workflow.runId}`)).toEqual(["a:live"]);
  });

  it("keeps one failed command per pane and skips commands stopped by a signal", () => {
    const failed = (id: string, exitCode: number, ago: number) => ({ id, kind: "bash" as const, title: id, status: "failed" as const, exitCode, at: NOW - ago * MIN, hasOutput: true });
    const activity = new Map([["a", res([], [failed("older", 1, 20), failed("killed", 144, 2), failed("latest", 2, 5)])]]);
    expect(finishedNotices(activity, [agent("a", "idle", { lastSeenAt: NOW - 60 * MIN })], NOW).map((n) => n.id)).toEqual(["latest"]);
  });

  it("lets a day-old result go", () => {
    const activity = new Map([["a", res([wf("ancient", "completed", NOW - 25 * 60 * MIN)])]]);
    expect(finishedNotices(activity, [agent("a", "idle")], NOW)).toEqual([]);
  });
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
