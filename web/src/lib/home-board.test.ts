import { boardColumns, lastFolder, pickUp, startTarget, viewAsked } from "./home-board";
import { sessionChats } from "./home-stats";
import type { AgentView } from "./types";

const MIN = 60_000;

function agent(paneId: string, status: AgentView["status"], extra: Partial<AgentView> = {}): AgentView {
  return { paneId, workspaceId: "w", workspaceLabel: "nenu", workspaceNumber: 1, tabId: "t", agent: "claude", status, cwd: "/dev/nenu", focused: false, ...extra };
}

describe("the Board", () => {
  it("sorts the chats by state, keeping their order, and rests shells with the idle", () => {
    const chats = sessionChats([
      agent("a", "working"), agent("b", "done"), agent("c", "idle"), agent("d", "working"), agent("s", "unknown", { kind: "shell" }),
    ]);
    const { working, review, resting } = boardColumns(chats);
    expect(working.map((chat) => chat.agent.paneId)).toEqual(["a", "d"]);
    expect(review.map((chat) => chat.agent.paneId)).toEqual(["b"]);
    expect(resting.map((chat) => chat.agent.paneId)).toEqual(["c", "s"]);
  });
});

describe("what to pick up", () => {
  it("leads with finished turns, unseen ones first, then whatever moved last, never a shell, three at most", () => {
    const chats = sessionChats([
      agent("moved", "working", { lastActiveAt: 9 * MIN }),
      agent("seen", "done", { lastActiveAt: 8 * MIN, lastSeenAt: 8.5 * MIN }),
      agent("shell", "idle", { kind: "shell", lastActiveAt: 7 * MIN }),
      agent("unseen", "done", { lastActiveAt: 6 * MIN }),
      agent("rest", "idle", { lastActiveAt: 5 * MIN }),
    ]);
    expect(pickUp(chats).map((chat) => chat.agent.paneId)).toEqual(["unseen", "seen", "moved"]);
  });
});

describe("where a new chat starts", () => {
  it("is the folder an agent last moved in, a shell's only when no agent has one", () => {
    const agents = [agent("old", "idle", { cwd: "/dev/old", lastActiveAt: MIN }), agent("new", "idle", { cwd: "/dev/shop", project: "shop", lastActiveAt: 2 * MIN })];
    const shell = agent("sh", "idle", { kind: "shell", cwd: "/dev/sh", lastActiveAt: 3 * MIN });
    expect(lastFolder(agents, [shell])).toEqual({ cwd: "/dev/shop", project: "shop" });
    expect(lastFolder([], [shell])).toEqual({ cwd: "/dev/sh", project: "sh" });
    expect(lastFolder([], [])).toBeNull();
  });

  it("opens a tab of the workspace that last moved in that folder, else a workspace of its own", () => {
    const panes = [agent("a", "idle", { workspaceId: "w1", lastActiveAt: MIN }), agent("b", "idle", { workspaceId: "w2", lastActiveAt: 2 * MIN })];
    expect(startTarget("/dev/nenu", panes)).toEqual({ kind: "tab", workspaceId: "w2" });
    expect(startTarget("/dev/elsewhere", panes)).toEqual({ kind: "workspace" });
  });
});

it("opens on the view a link names, and on nothing else", () => {
  expect(viewAsked({ list: "prs" })).toBe("prs");
  expect(viewAsked({ list: "board" })).toBe("board");
  expect(viewAsked({ list: "elsewhere" })).toBeUndefined();
  expect(viewAsked(null)).toBeUndefined();
});
