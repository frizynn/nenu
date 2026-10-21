import type { ActivityResponse, ActivityWorkflow } from "./activity";
import { greeting, homeHeadline, needsYouCount, needsYouItems, readyToMerge, recentChats, reviewItems, reviewQueue, runningWorkflows } from "./home-stats";
import type { AgentView, ProjectView, PullRequestView } from "./types";

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
  it("leads with what needs you, never the pull requests, and says nothing does only once that was read", () => {
    expect(homeHeadline({ needs: 2, review: 2, working: 5 }, 9, true).title).toBe("2 need you");
    expect(homeHeadline({ needs: 1, review: 0, working: 5 }, 9, false).title).toBe("1 needs you");
    expect(homeHeadline({ needs: 0, review: 17, working: 8 }, 15, true).title).toBe("Nothing needs you");
    // Until the dialogs were read on a live herd, it says what the herd is doing instead.
    expect(homeHeadline({ needs: 0, review: 1, working: 3 }, 9, false).title).toBe("3 agents at work");
    expect(homeHeadline({ needs: 0, review: 0, working: 0 }, 9, false).title).toBe("All quiet");
    expect(homeHeadline({ needs: 0, review: 0, working: 0 }, 0, true).title).toBe("What should we work on?");
  });

  it("puts the live rest on a second line, never idle agents, and leaves it out when there is nothing else", () => {
    expect(homeHeadline({ needs: 1, review: 1, working: 1 }, 9, true).detail).toBe("1 to review · 1 working");
    expect(homeHeadline({ needs: 0, review: 17, working: 8 }, 15, true).detail).toBe("17 to review · 8 working");
    expect(homeHeadline({ needs: 2, review: 0, working: 1 }, 9, true).detail).toBe("1 working");
    expect(homeHeadline({ needs: 0, review: 1, working: 3 }, 9, false).detail).toBe("1 to review");
    expect(homeHeadline({ needs: 0, review: 0, working: 2 }, 9, false).detail).toBeNull();
    // "All quiet" already says it: a count of idle agents under it would repeat it.
    expect(homeHeadline({ needs: 0, review: 0, working: 0 }, 9, false).detail).toBeNull();
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

it("lists after them the threads whose agent stopped for your reply, on a live pane, once each", () => {
  const hub: ProjectView = {
    slug: "hub", name: "Hub", status: "active", source: "json",
    threads: [
      { id: "t1", title: "Copy", parentId: "root", role: "worker", status: "open", paneId: "r", liveStatus: "idle", group: "waiting-on-you", selfWaiting: true },
      { id: "t2", title: "Gone", parentId: "root", role: "worker", status: "open", paneId: "closed", liveStatus: "idle", group: "waiting-on-you", selfWaiting: true },
      { id: "t3", title: "Asks", parentId: "root", role: "worker", status: "open", paneId: "a", liveStatus: "blocked", group: "waiting-on-you", selfWaiting: true },
    ],
  };
  const items = needsYouItems([agent("a", "blocked"), agent("r", "idle")], [{ paneId: "a", detectedAt: 1 }], [hub]);
  expect(items.map((item) => `${item.paneId}:${item.interaction ? "asks" : item.reply ? "reply" : "blocked"}`)).toEqual(["a:asks", "r:reply"]);
});

it("leaves out a conversation that ended its turn, from Needs you, Home's count and its rows", () => {
  const talk = { id: "t1", title: "Charla", parentId: "root", role: "worker", status: "open", paneId: "c", liveStatus: "done", group: "waiting-on-you", selfWaiting: true, conversation: true } as const;
  const hub: ProjectView = { slug: "hub", name: "Hub", status: "active", source: "json", threads: [talk] };
  const agents = [agent("c", "done")];
  expect(needsYouItems(agents, [], [hub])).toEqual([]);
  expect(needsYouCount({ agents, projects: [hub] })).toBe(0);
  expect(recentChats(agents, [hub], new Set())[0]).not.toHaveProperty("ask");
  expect(reviewItems([hub])).toEqual([]);
  // Stopped on a dialog, it asks like any agent.
  const asking = [agent("c", "blocked")];
  expect(needsYouCount({ agents: asking, projects: [{ ...hub, threads: [{ ...talk, liveStatus: "blocked" }] }] })).toBe(1);
});

describe("review state", () => {
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
});

describe("review queue", () => {
  const gh = (number: number, extra: Partial<PullRequestView> = {}): PullRequestView => ({
    repo: "acme/shop", number, title: `PR ${number}`, url: `https://github.com/acme/shop/pull/${number}`, branch: `feat/${number}`,
    draft: false, updatedAt: number * 1000, paneIds: [], ...extra,
  });

  it("lists pull requests only, drafts last, green and approved first, then the most recent", () => {
    const rows = reviewQueue([], [
      gh(1),
      gh(2, { draft: true, updatedAt: 99_000 }),
      gh(3, { review: "approved", checks: { passed: 3, failed: 0, pending: 0 } }),
      gh(4, { checks: { passed: 1, failed: 1, pending: 0 } }),
      gh(5, { checks: { passed: 2, failed: 0, pending: 0 } }),
    ]);
    expect(rows.map((row) => row.number)).toEqual([3, 5, 4, 1, 2]);
    expect(rows[0]).toMatchObject({ key: "acme/shop#3", repo: "shop", branch: "feat/3", url: "https://github.com/acme/shop/pull/3" });
  });

  it("calls a pull request ready to merge only when it is approved, its checks pass and nothing blocks it", () => {
    const green = { passed: 3, failed: 0, pending: 0 };
    const rows = reviewQueue([], [
      gh(1, { review: "approved", checks: green }),
      gh(2, { checks: green }),
      gh(3, { review: "approved", checks: { passed: 2, failed: 1, pending: 0 } }),
      gh(4, { review: "approved", checks: { passed: 2, failed: 0, pending: 1 } }),
      gh(5, { review: "approved", checks: green, draft: true }),
      gh(6, { review: "approved", checks: green }),
      gh(7, { review: "approved" }),
    ]).sort((a, b) => a.number! - b.number!).map((row) => row.number === 6 ? { ...row, mergeBlocker: "branch out of date" } : row);
    expect(rows.map(readyToMerge)).toEqual([true, false, false, false, false, false, true]);
  });

  it("opens the agent on the PR's branch, else the PR on GitHub", () => {
    const [mapped, unmapped] = reviewQueue([], [gh(2, { paneIds: ["w1:p3", "w1:p4"] }), gh(1)]);
    expect(mapped!.open).toEqual({ paneId: "w1:p3" });
    expect(unmapped!.open).toBeUndefined();
  });

  it("joins the same PR from Organizations into one row that opens its thread", () => {
    const hub: ProjectView = {
      slug: "hub", name: "Hub", status: "active", source: "json",
      threads: [
        { id: "t2", title: "Thread title", parentId: "root", role: "worker", status: "open", paneId: "p2", liveStatus: "done", group: "ready-for-review",
          pr: { state: "open", number: 7, url: "https://github.com/acme/shop/pull/7", mergeBlocker: "checks failing" } },
        { id: "t3", title: "Org only", parentId: "root", role: "worker", status: "open", liveStatus: "done", group: "ready-for-review", pr: { state: "open", number: 12 } },
      ],
    };
    const rows = reviewQueue([hub], [gh(7, { paneIds: ["other"], updatedAt: 5_000 })]);
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.number === 7)).toMatchObject({ title: "PR 7", repo: "shop", open: { paneId: "p2" }, mergeBlocker: "checks failing" });
    expect(rows.find((row) => row.number === 12)).toMatchObject({ title: "Org only", repo: "Hub", open: { project: "hub", node: "t3" } });
  });
});

describe("background work", () => {
  const wf = (runId: string, status: ActivityWorkflow["status"], updatedAt?: number): ActivityWorkflow =>
    ({ runId, name: runId, status, updatedAt, phases: [], agentCount: 2, doneCount: 2 });

  it("lists the workflows still running, by pane", () => {
    const activity = new Map<string, ActivityResponse>([
      ["a", { available: true, sessionKey: "s", workflows: [wf("done", "completed", NOW), wf("live", "running")], tasks: [], artifacts: [], truncated: false }],
    ]);
    expect(runningWorkflows(activity).map((r) => `${r.paneId}:${r.workflow.runId}`)).toEqual(["a:live"]);
  });
});

describe("recent chats", () => {
  const panes = [
    agent("coord", "working", { lastActiveAt: NOW - 30 * MIN }),
    agent("worker", "done", { lastActiveAt: NOW - 2 * MIN, lastSeenAt: NOW - 5 * MIN }),
    agent("chat-old", "idle", { paneLabel: "Changelog", tabLabel: "docs", lastActiveAt: NOW - 60 * MIN, lastSeenAt: NOW - 20 * MIN }),
    agent("chat-asks", "blocked", { paneLabel: "Auth review", lastActiveAt: NOW - MIN }),
    agent("chat-quiet", "idle", { paneLabel: "Untouched" }),
  ];

  it("lists chats by their last movement or visit, leaving out what Needs you shows", () => {
    expect(recentChats(panes, [project], new Set(["chat-asks"])).map((chat) => chat.agent.paneId))
      .toEqual(["worker", "chat-old", "coord", "chat-quiet"]);
  });

  it("names a pane as every other view does: a thread by its title and project, a loose chat by its workspace and tab", () => {
    const [worker, old, coord] = recentChats(panes, [project], new Set(["chat-asks"]));
    expect(worker).toMatchObject({ title: "Build", place: "Hub", tab: null, at: NOW - 2 * MIN, unseen: true });
    expect(old).toMatchObject({ title: "Changelog", place: "nenu", tab: "docs", at: NOW - 20 * MIN, unseen: false });
    // The coordinator goes by its project's name in every view, never a bare "Coordinator".
    expect(coord).toMatchObject({ title: "Hub coordinator", place: "nenu" });
  });

  it("carries a session's pull request: GitHub's on its branch first, else the one its thread records", () => {
    const hub: ProjectView = {
      ...project, source: "json",
      threads: [
        { id: "t1", title: "Build", parentId: "root", role: "worker", status: "open", paneId: "worker", liveStatus: "done", group: "ready-for-review",
          pr: { state: "open", number: 7, diff: { additions: 9, deletions: 2 } } },
        { id: "t4", title: "Plan", parentId: "root", role: "coordinator", status: "open", paneId: "chat-old", liveStatus: "idle", group: "idle" },
      ],
    };
    const gh: PullRequestView = { repo: "acme/shop", number: 8, title: "Docs", url: "https://github.com/acme/shop/pull/8", branch: "docs", draft: false,
      diff: { additions: 30, deletions: 1 }, paneIds: ["chat-quiet"], updatedAt: 1 };
    const rows = recentChats(panes, [hub], new Set(["chat-asks"]), reviewQueue([hub], [gh]));
    const by = (id: string) => rows.find((row) => row.agent.paneId === id)!;
    expect(by("worker")).toMatchObject({ review: true, detail: "PR #7", diff: { additions: 9, deletions: 2 } });
    expect(by("chat-quiet")).toMatchObject({ review: false, detail: "PR #8", diff: { additions: 30, deletions: 1 } });
    // A coordinator thread says what it is where a worker would name its tab.
    expect(by("chat-old")).toMatchObject({ title: "Plan", place: "Hub", detail: "coordinator" });
    expect(by("coord")).toMatchObject({ review: false, detail: null });
    expect(by("coord")).not.toHaveProperty("diff");
  });

  it("says a session's thread waits for your reply, as Organizations' own word puts it", () => {
    const hub: ProjectView = {
      ...project, source: "json",
      threads: [{ id: "t1", title: "Build", parentId: "root", role: "worker", status: "open", paneId: "worker", liveStatus: "idle", group: "waiting-on-you", selfWaiting: true }],
    };
    expect(recentChats(panes, [hub], new Set()).find((row) => row.agent.paneId === "worker")).toMatchObject({ ask: "reply" });
    expect(recentChats(panes, [project], new Set()).find((row) => row.agent.paneId === "worker")).not.toHaveProperty("ask");
  });

  it("lists shells by the same clock, as plain sessions", () => {
    const shell = agent("sh", "idle", { kind: "shell", agent: "shell", paneLabel: "Logs", lastActiveAt: NOW - 3 * MIN });
    expect(recentChats([...panes, shell], [project], new Set(["chat-asks"])).map((chat) => chat.agent.paneId))
      .toEqual(["worker", "sh", "chat-old", "coord", "chat-quiet"]);
  });
});

