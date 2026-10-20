import { describe, expect, it } from "vitest";

import { deskChats, liveliest, projectActivity, projectAgents, projectPulse } from "./desk-nav";
import type { AgentView, ProjectView } from "./types";

const now = new Date(2026, 9, 6, 12, 0, 0).getTime();
const MIN = 60_000;

function pane(paneId: string, extra: Partial<AgentView> = {}): AgentView {
  return { paneId, workspaceId: "w1", workspaceLabel: "w1", workspaceNumber: 1, tabId: "t", agent: "claude", status: "idle", cwd: "/", focused: false, ...extra };
}

const acme: ProjectView = {
  slug: "acme", name: "Acme", status: "active", workspaceIds: ["w1"],
  coordinator: { paneId: "coord", agent: "claude", liveStatus: "idle" },
  threads: [
    { id: "t-1", title: "Checkout flow", parentId: "root", role: "worker", status: "open", paneId: "flow", liveStatus: "working", updated: new Date(now - 90 * MIN).toISOString() },
    { id: "t-2", title: "Cart badge", parentId: "root", role: "worker", status: "open", group: "ready-for-review", updated: new Date(now - 30 * MIN).toISOString(),
      pr: { url: "https://github.com/acme/shop/pull/41", number: 41, state: "open", review: "approved" } },
    { id: "t-3", title: "Search index", parentId: "root", role: "worker", status: "resolved", updated: new Date(now - 5 * MIN).toISOString() },
  ],
};

describe("the desk's chats", () => {
  const agents = [pane("coord", { lastActiveAt: now }), pane("flow", { lastActiveAt: now - 2 * MIN }), pane("loose", { workspaceId: "w2", paneLabel: "loose", lastSeenAt: now - 3 * MIN })];

  it("lists every open thread and every chat outside a project, never the project's own coordinator or a resolved thread", () => {
    expect(deskChats({ agents, projects: [acme] }).map((chat) => chat.title)).toEqual(["Checkout flow", "Cart badge", "loose"]);
  });

  it("opens a running thread's pane, and the node page of one that runs nowhere", () => {
    const [flow, badge] = deskChats({ agents, projects: [acme] });
    expect(flow).toMatchObject({ paneId: "flow", thread: { id: "t-1" } });
    expect(badge).toMatchObject({ paneId: undefined, project: "acme", thread: { id: "t-2" } });
  });

  it("dates each chat by its last real activity: the later of the thread's update and its pane's", () => {
    const chats = deskChats({ agents, projects: [acme] });
    expect(chats.map((chat) => [chat.title, chat.at])).toEqual([
      ["Checkout flow", now - 2 * MIN],
      ["Cart badge", now - 30 * MIN],
      ["loose", now - 3 * MIN],
    ]);
  });
});

describe("a project's row", () => {
  const agents = [pane("coord", { lastActiveAt: now - 50 * MIN }), pane("flow", { status: "blocked", lastActiveAt: now - 60 * MIN }), pane("loose", { workspaceId: "w2", status: "working" })];

  it("dates the project by anything in it that moved last, resolved threads included", () => {
    expect(projectActivity(acme, agents)).toBe(now - 5 * MIN);
    expect(projectActivity({ ...acme, threads: [], coordinator: undefined }, agents)).toBe(0);
  });

  it("draws the most pressing state among the agents it holds", () => {
    expect(projectAgents(acme, agents, [acme]).map((agent) => agent.paneId)).toEqual(["coord", "flow"]);
    expect(liveliest(projectAgents(acme, agents, [acme]))).toBe("blocked");
    expect(liveliest([pane("a")])).toBeUndefined();
  });
});

describe("a chat's +1", () => {
  it("marks a chat that finished or needs you since it was last opened, and nothing else", () => {
    const agents = [
      pane("flow", { status: "done", lastActiveAt: now, lastSeenAt: now - MIN }),
      pane("loose", { workspaceId: "w2", paneLabel: "asked", status: "blocked", lastActiveAt: now, lastSeenAt: now - MIN }),
      pane("seen", { workspaceId: "w2", paneLabel: "seen", status: "blocked", lastActiveAt: now - MIN, lastSeenAt: now }),
      pane("busy", { workspaceId: "w2", paneLabel: "busy", status: "working", lastActiveAt: now, lastSeenAt: now - MIN }),
    ];
    expect(deskChats({ agents, projects: [acme] }).map((chat) => [chat.title, chat.unread])).toEqual([
      ["Checkout flow", true], ["Cart badge", false], ["asked", true], ["seen", false], ["busy", false],
    ]);
  });
});

describe("a project's pulse", () => {
  it("counts open work by the tree's state, and takes what waits on you from Organizations' asks when it has them", () => {
    const asking = { ...acme, threads: [...acme.threads, { id: "t-4", title: "Pricing", parentId: "root", role: "worker" as const, status: "open" as const, group: "waiting-on-you" }] };
    expect(projectPulse(asking, [pane("flow", { status: "working" })])).toMatchObject({ waiting: 1, working: 1, review: 1, coordinators: 0, threads: 3 });
    expect(projectPulse({ ...asking, waitingAsks: 4 }, []).waiting).toBe(4);
    expect(projectPulse(acme, []).at).toBe(now - 5 * MIN);
  });
});
