import type { ActivityResponse, ActivityWorkflow } from "./activity";
import { greeting, homeHeadline, needsYouCount, needsYouItems, readyToMerge, recentChats, reviewQueue, reviewsByRepo, runningWorkflows } from "./home-stats";
import type { AgentView, PullRequestView } from "./types";

const NOW = new Date(2026, 9, 7, 15, 30).getTime();
const MIN = 60_000;

function agent(paneId: string, status: AgentView["status"], extra: Partial<AgentView> = {}): AgentView {
  return { paneId, workspaceId: "w", workspaceLabel: "nenu", workspaceNumber: 1, tabId: "t", agent: "claude", status, cwd: "/dev/nenu", focused: false, ...extra };
}

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

it("counts by the snapshot alone the blocked panes", () => {
  expect(needsYouCount({ agents: [agent("a", "blocked"), agent("b", "working"), agent("c", "blocked")] })).toBe(2);
});


describe("review queue", () => {
  const gh = (number: number, extra: Partial<PullRequestView> = {}): PullRequestView => ({
    repo: "acme/shop", number, title: `PR ${number}`, url: `https://github.com/acme/shop/pull/${number}`, branch: `feat/${number}`,
    draft: false, updatedAt: number * 1000, paneIds: [], ...extra,
  });

  it("lists pull requests only, drafts last, green and approved first, then the most recent", () => {
    const rows = reviewQueue([
      gh(1),
      gh(2, { draft: true, updatedAt: 99_000 }),
      gh(3, { review: "approved", checks: { passed: 3, failed: 0, pending: 0 } }),
      gh(4, { checks: { passed: 1, failed: 1, pending: 0 } }),
      gh(5, { checks: { passed: 2, failed: 0, pending: 0 } }),
    ]);
    expect(rows.map((row) => row.number)).toEqual([3, 5, 4, 1, 2]);
    expect(rows[0]).toMatchObject({ key: "acme/shop#3", repo: "shop", owner: "acme", branch: "feat/3", url: "https://github.com/acme/shop/pull/3" });
  });

  it("groups by repo: ready to merge, then blocked, then in review, drafts last, the latest-moved repo first", () => {
    const green = { passed: 3, failed: 0, pending: 0 };
    const other = (number: number, extra: Partial<PullRequestView> = {}) => gh(number, { url: `https://github.com/acme/api/pull/${number}`, ...extra });
    const repos = reviewsByRepo(reviewQueue([
      gh(1, { draft: true, updatedAt: 90_000 }),
      gh(2),
      gh(3, { review: "changes_requested" }),
      gh(4, { checks: { passed: 1, failed: 1, pending: 0 } }),
      gh(5, { review: "approved", checks: green }),
      gh(6),
      other(7, { updatedAt: 95_000 }),
    ]));
    expect(repos.map((repo) => [repo.key, repo.name, repo.owner])).toEqual([["acme/api", "api", "acme"], ["acme/shop", "shop", "acme"]]);
    expect(repos[1]!.entries.map((row) => row.number)).toEqual([5, 4, 3, 6, 2, 1]);
  });

  it("calls a pull request ready to merge only when it is approved, its checks pass and it is no draft", () => {
    const green = { passed: 3, failed: 0, pending: 0 };
    const rows = reviewQueue([
      gh(1, { review: "approved", checks: green }),
      gh(2, { checks: green }),
      gh(3, { review: "approved", checks: { passed: 2, failed: 1, pending: 0 } }),
      gh(4, { review: "approved", checks: { passed: 2, failed: 0, pending: 1 } }),
      gh(5, { review: "approved", checks: green, draft: true }),
      gh(6, { review: "approved" }),
    ]).sort((a, b) => a.number! - b.number!);
    expect(rows.map(readyToMerge)).toEqual([true, false, false, false, false, true]);
  });

  it("opens the agent on the PR's branch, else the PR on GitHub", () => {
    const [mapped, unmapped] = reviewQueue([gh(2, { paneIds: ["w1:p3", "w1:p4"] }), gh(1)]);
    expect(mapped!.open).toEqual({ paneId: "w1:p3" });
    expect(unmapped!.open).toBeUndefined();
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
    expect(recentChats(panes, new Set(["chat-asks"])).map((chat) => chat.agent.paneId))
      .toEqual(["worker", "chat-old", "coord", "chat-quiet"]);
  });

  it("names a pane as every other view does: by its own name, its workspace and tab", () => {
    const [worker, old] = recentChats(panes, new Set(["chat-asks"]));
    expect(worker).toMatchObject({ title: "claude", place: "nenu", tab: null, at: NOW - 2 * MIN, unseen: true });
    expect(old).toMatchObject({ title: "Changelog", place: "nenu", tab: "docs", at: NOW - 20 * MIN, unseen: false });
  });

  it("carries the pull request GitHub has on a session's branch", () => {
    const gh: PullRequestView = { repo: "acme/shop", number: 8, title: "Docs", url: "https://github.com/acme/shop/pull/8", branch: "docs", draft: false,
      diff: { additions: 30, deletions: 1 }, paneIds: ["chat-quiet"], updatedAt: 1 };
    const rows = recentChats(panes, new Set(["chat-asks"]), reviewQueue([gh]));
    const by = (id: string) => rows.find((row) => row.agent.paneId === id)!;
    expect(by("chat-quiet")).toMatchObject({ detail: "PR #8", diff: { additions: 30, deletions: 1 } });
    expect(by("coord")).toMatchObject({ detail: null });
    expect(by("coord")).not.toHaveProperty("diff");
  });

  it("lists shells by the same clock, as plain sessions", () => {
    const shell = agent("sh", "idle", { kind: "shell", agent: "shell", paneLabel: "Logs", lastActiveAt: NOW - 3 * MIN });
    expect(recentChats([...panes, shell], new Set(["chat-asks"])).map((chat) => chat.agent.paneId))
      .toEqual(["worker", "sh", "chat-old", "coord", "chat-quiet"]);
  });
});

