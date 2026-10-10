import { describe, expect, it } from "vitest";

import { closeRefusal, historyCount, nodeState, orgTree, type OrgNode } from "./org-tree";
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
