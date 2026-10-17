import { describe, expect, it } from "vitest";

import { awaits, closeRefusal, flatten, historyCount, moveTargets, nodeState, openCoordinators, openUnder, orgTree, type OrgNode } from "./org-tree";
import type { ProjectThreadView } from "./types";

const node = (id: string, parentId: string, extra: Partial<ProjectThreadView> = {}): ProjectThreadView =>
  ({ id, title: id, parentId, role: "worker", status: "open", ...extra });
const shape = (nodes: OrgNode[]): unknown[] => nodes.map((n) => n.children.length ? [n.thread.id, shape(n.children)] : n.thread.id);

describe("nodeState", () => {
  it("reads Organizations' group the way its popup does, the live pane being the fresher word on work", () => {
    expect(nodeState(node("a", "root", { status: "resolved", group: "waiting-on-you" }))).toBe("resolved");
    expect(nodeState(node("a", "root", { status: "failed" }))).toBe("needs");
    expect(nodeState(node("a", "root", { group: "waiting-on-you" }))).toBe("needs");
    expect(nodeState(node("a", "root", { paneId: "p", liveStatus: "blocked", group: "ready-for-review" }))).toBe("needs");
    expect(nodeState(node("a", "root", { group: "ready-for-review" }))).toBe("review");
    expect(nodeState(node("a", "root", { group: "landing" }))).toBe("review");
    expect(nodeState(node("a", "root", { pr: { state: "open", review: "approved" } }))).toBe("review");
    expect(nodeState(node("a", "root", { paneId: "p", liveStatus: "done" }))).toBe("review");
    expect(nodeState(node("a", "root", { paneId: "p", liveStatus: "idle", group: "working" }))).toBe("idle");
    expect(nodeState(node("a", "root", { paneId: "p", liveStatus: "unknown", group: "working" }))).toBe("working");
    expect(nodeState(node("a", "root", { status: "starting" }))).toBe("working");
    // A live status reported for a node with no pane is not evidence of anything.
    expect(nodeState(node("a", "root", { liveStatus: "working" }))).toBe("idle");
  });
});

describe("awaits", () => {
  it("tells a dialog on screen from an agent that said it waits for your reply", () => {
    // Herdr reads the pane blocked: a question or a permission prompt waits on screen.
    expect(awaits(node("a", "root", { paneId: "p", liveStatus: "blocked" }))).toBe("question");
    expect(awaits(node("a", "root", { paneId: "p", liveStatus: "blocked", group: "waiting-on-you", selfWaiting: true }))).toBe("question");
    // Organizations groups it Waiting on you because the agent reported so; the pane is idle at its prompt.
    expect(awaits(node("a", "root", { paneId: "p", liveStatus: "idle", group: "waiting-on-you", selfWaiting: true }))).toBe("reply");
    // Other reasons Organizations has (a closed pane, a failed or stuck start) are neither.
    expect(awaits(node("a", "root", { group: "waiting-on-you", note: "pane closed" }))).toBeUndefined();
    expect(awaits(node("a", "root", { status: "failed", paneId: "p", liveStatus: "idle", selfWaiting: true }))).toBeUndefined();
    expect(awaits(node("a", "root", { paneId: "p", liveStatus: "idle", group: "waiting-on-you" }))).toBeUndefined();
    // A stale report on a node that no longer needs you says nothing.
    expect(awaits(node("a", "root", { paneId: "p", liveStatus: "working", group: "working", selfWaiting: true }))).toBeUndefined();
  });
});

describe("orgTree", () => {
  it("nests only open nodes, coordinators first, then needs you, review, working and idle, ties in id order", () => {
    const { open } = orgTree([
      node("w-idle", "root"),
      node("w-needs", "root", { group: "waiting-on-you" }),
      node("c-idle", "root", { role: "coordinator", group: "idle" }),
      node("w-work-1", "c-idle", { group: "working" }),
      node("w-review", "c-idle", { group: "ready-for-review" }),
      node("w-work-2", "c-idle", { group: "working" }),
      node("c-needs", "root", { role: "coordinator", group: "waiting-on-you" }),
      node("w-done", "c-idle", { status: "resolved" }),
    ]);
    expect(shape(open)).toEqual(["c-needs", ["c-idle", ["w-review", "w-work-1", "w-work-2"]], "w-needs", "w-idle"]);
  });

  it("keeps History apart: each resolved coordinator holds its resolved threads, coordinators first, newest first", () => {
    const tree = orgTree([
      node("old-c", "root", { role: "coordinator", status: "resolved", updated: "2026-09-01T00:00:00Z" }),
      node("old-w", "old-c", { status: "resolved", updated: "2026-09-02T00:00:00Z" }),
      node("open-c", "root", { role: "coordinator" }),
      node("under-open", "open-c", { status: "resolved", updated: "2026-10-03T00:00:00Z" }),
      node("new-c", "root", { role: "coordinator", status: "resolved", updated: "2026-10-01T00:00:00Z" }),
      node("fix", "root", { status: "resolved", updated: "2026-10-02T00:00:00Z" }),
      node("undated", "root", { status: "resolved" }),
    ]);
    expect(shape(tree.history)).toEqual(["new-c", ["old-c", ["old-w"]], "under-open", "fix", "undated"]);
    expect(shape(tree.open)).toEqual(["open-c"]);
    expect(tree.resolved).toEqual({ coordinators: 2, threads: 4 });
    expect(historyCount(tree.resolved)).toBe("2 coordinators, 4 threads");
    expect(historyCount({ coordinators: 0, threads: 1 })).toBe("1 thread");
    expect(historyCount({ coordinators: 1, threads: 0 })).toBe("1 coordinator");
  });

  it("lists an orphan, an open node under a resolved coordinator, or a parent loop at the top", () => {
    const { open } = orgTree([
      node("gone-child", "gone"),
      node("x", "y"), node("y", "x"), node("self", "self"),
      node("z", "x"),
      node("done-c", "root", { role: "coordinator", status: "resolved" }),
      node("stray", "done-c"),
    ]);
    expect(shape(open)).toEqual(["gone-child", ["x", ["z"]], "y", "self", "stray"]);
  });
});

it("refuses to close a coordinator that still runs open nodes, and says how many", () => {
  const [lead, solo] = orgTree([
    node("lead", "root", { role: "coordinator", title: "Lead" }),
    node("a", "lead"), node("b", "lead"), node("c", "lead", { status: "resolved" }),
    node("solo", "root", { role: "coordinator" }),
  ]).open;
  expect(closeRefusal(lead!)).toBe("Lead still has 2 open under it.");
  expect(closeRefusal(solo!)).toBeUndefined();
});

describe("a project's coordinators", () => {
  // Lead runs Docs and Checkout, which runs Pay; Old is resolved; Hotfix sits at the top level.
  const tree = orgTree([
    node("lead", "root", { role: "coordinator" }),
    node("docs", "lead", { group: "waiting-on-you" }),
    node("checkout", "lead", { role: "coordinator" }),
    node("pay", "checkout"),
    node("old", "root", { role: "coordinator", status: "resolved" }),
    node("hotfix", "root"),
  ]);
  const find = (id: string) => flatten(tree.open).find((n) => n.thread.id === id)!;

  it("lists every open coordinator in the tree's order, with how deep it sits", () => {
    expect(openCoordinators(tree).map(({ node: n, depth }) => [n.thread.id, depth])).toEqual([["lead", 0], ["checkout", 1]]);
  });

  it("moves a node only to the top level or a coordinator outside it and other than its parent", () => {
    const ids = (n: OrgNode) => { const t = moveTargets(tree, n); return [t.root, t.coordinators.map(({ node: c }) => c.thread.id)]; };
    expect(ids(find("docs"))).toEqual([true, ["checkout"]]);
    expect(ids(find("pay"))).toEqual([true, ["lead"]]);
    expect(ids(find("hotfix"))).toEqual([false, ["lead", "checkout"]]);
    // Its own coordinator under it is no place for a coordinator.
    expect(ids(find("lead"))).toEqual([false, []]);
  });

  it("counts the open work under a node and how much of it needs you", () => {
    expect(openUnder(find("lead"))).toEqual({ open: 3, needs: 1 });
    expect(openUnder(find("hotfix"))).toEqual({ open: 0, needs: 0 });
  });
});
