import { describe, expect, it } from "vitest";

import { awaits, closeRefusal, coordinatorState, flatten, historyCount, moveTargets, nodeState, openCoordinators, orgTree, STATE_LABEL, workUnder, type OrgNode } from "./org-tree";
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
    // Finished with its pull request open and its pane gone: only the merge is left, nothing to open.
    expect(nodeState(node("a", "root", { group: "awaiting-merge", pr: { state: "open", review: "approved" } }))).toBe("merging");
    expect(nodeState(node("a", "root", { status: "failed", group: "awaiting-merge" }))).toBe("needs");
    // A live status reported for a node with no pane is not evidence of anything.
    expect(nodeState(node("a", "root", { liveStatus: "working" }))).toBe("idle");
  });
});

describe("a coordinator's state", () => {
  const coordinator = (extra: Partial<ProjectThreadView>) => node("c", "root", { role: "coordinator", ...extra });
  it("never reads as ready for review: it works, needs you, or is idle", () => {
    // Organizations groups a coordinator whose report has a verdict as ready for review.
    expect(nodeState(coordinator({ group: "ready-for-review", verdict: "done" }))).toBe("idle");
    // Herdr's `done` is a turn that ended: the coordinator waits at its prompt.
    expect(nodeState(coordinator({ paneId: "p", liveStatus: "done", group: "ready-for-review" }))).toBe("idle");
    expect(nodeState(coordinator({ paneId: "p", liveStatus: "working", group: "ready-for-review" }))).toBe("working");
    expect(nodeState(coordinator({ paneId: "p", liveStatus: "blocked", group: "idle" }))).toBe("needs");
    expect(nodeState(coordinator({ group: "waiting-on-you" }))).toBe("needs");
    expect(nodeState(coordinator({ status: "failed" }))).toBe("needs");
    expect(nodeState(coordinator({ group: "working" }))).toBe("working");
    expect(nodeState(coordinator({ status: "starting" }))).toBe("working");
    expect(nodeState(coordinator({ status: "resolved", group: "resolved" }))).toBe("resolved");
    // A thread keeps Organizations' reading.
    expect(nodeState(node("t", "root", { group: "ready-for-review" }))).toBe("review");
  });

  it("reads the project's own coordinator the same way", () => {
    expect([coordinatorState("done"), coordinatorState("working"), coordinatorState("blocked"), coordinatorState("idle"), coordinatorState("unknown")])
      .toEqual(["idle", "working", "needs", "idle", undefined]);
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

  it("reads a conversation that ended its turn as a chat at rest, not as one waiting for your reply", () => {
    // Organizations groups it Waiting on you after every turn, because it reports `Waiting for you` before each answer.
    const resting = node("a", "root", { conversation: true, paneId: "p", liveStatus: "done", group: "waiting-on-you", selfWaiting: true, reportUnacked: true });
    expect(nodeState(resting)).toBe("idle");
    expect(awaits(resting)).toBeUndefined();
    expect(nodeState({ ...resting, liveStatus: "idle" })).toBe("idle");
    expect(nodeState({ ...resting, liveStatus: "working", group: "working", selfWaiting: undefined })).toBe("working");
    // Herdr's `done` after a turn is no review for a conversation either.
    expect(nodeState({ ...resting, group: "ready-for-review", selfWaiting: undefined })).toBe("idle");
    // Its own pull request, approved or landing, is still something to review.
    expect(nodeState({ ...resting, group: "landing", selfWaiting: undefined })).toBe("review");
    expect(nodeState({ ...resting, group: "idle", selfWaiting: undefined, pr: { state: "open", review: "approved" } })).toBe("review");
    expect(nodeState({ ...resting, liveStatus: "working", group: "working", selfWaiting: undefined, pr: { state: "open", review: "approved" } })).toBe("review");
    // A pane Herdr cannot read is not known to be at rest.
    expect(nodeState({ ...resting, liveStatus: "unknown" })).toBe("needs");
  });

  it("leaves a coordinator as it was, kept open or not", () => {
    const coordinator = node("c", "root", { role: "coordinator", paneId: "p", liveStatus: "done", group: "landing", pr: { state: "open", review: "approved" } });
    expect(nodeState(coordinator)).toBe("idle");
    expect(nodeState({ ...coordinator, conversation: true })).toBe("idle");
    expect(nodeState({ ...coordinator, conversation: true, group: "waiting-on-you", selfWaiting: true })).toBe("needs");
  });

  it("still says a conversation needs you when it is stopped on a dialog, failed, or lost its pane", () => {
    const base = { conversation: true, group: "waiting-on-you", selfWaiting: true } as const;
    expect(awaits(node("a", "root", { ...base, paneId: "p", liveStatus: "blocked" }))).toBe("question");
    expect(nodeState(node("a", "root", { ...base, status: "failed", paneId: "p", liveStatus: "idle" }))).toBe("needs");
    expect(nodeState(node("a", "root", { ...base, note: "pane closed" }))).toBe("needs");
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
});

it("reads a review whose pull request merged as closing: no work to review, about to resolve", () => {
  const thread = (pr: ProjectThreadView["pr"]): ProjectThreadView => ({ id: "t-1", title: "Copy", parentId: "root", role: "worker", status: "open", group: "ready-for-review", pr });
  expect(nodeState(thread({ state: "merged", number: 9 }))).toBe("closing");
  expect(nodeState(thread({ state: "open", number: 9 }))).toBe("review");
  expect(STATE_LABEL.closing).toBe("Merged, closes on its own");
});

it("groups the open work under a coordinator as the tree orders it: each coordinator under it, the most urgent first, then its own threads", () => {
  // Everything under t-1, three levels deep, as threadTree hands it over.
  const groups = workUnder([
    node("t-2", "t-1"),
    node("t-3", "t-1", { role: "coordinator" }),
    node("t-4", "t-3"),
    node("t-5", "t-1", { role: "coordinator" }),
    node("t-6", "t-5", { role: "coordinator" }),
    node("t-7", "t-6", { group: "working" }),
    node("t-8", "t-1", { group: "ready-for-review" }),
    node("t-9", "t-3", { status: "resolved" }),
  ]);
  expect(groups.map((group) => [group.coordinator?.thread.id ?? "own", group.rows.map(({ node: row, depth }) => `${row.thread.id}@${depth}`)])).toEqual([
    ["t-5", ["t-6@0", "t-7@1"]],
    ["t-3", ["t-4@0"]],
    ["own", ["t-8@0", "t-2@0"]],
  ]);
  expect(workUnder([])).toEqual([]);
});
