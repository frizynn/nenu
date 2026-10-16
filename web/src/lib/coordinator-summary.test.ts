import { outcome, summarySections } from "./coordinator-summary";
import type { ProjectThreadView } from "./types";

const thread = (id: string, extra: Partial<ProjectThreadView> = {}): ProjectThreadView =>
  ({ id, title: id, parentId: "t-0", role: "worker", status: "open", ...extra });

describe("where a thread's work stands in its coordinator's Summary", () => {
  it("needs your decision when its report asks for one, is blocked or failed, or Organizations says it waits on you", () => {
    for (const extra of [
      { verdict: "needs-decision" }, { verdict: "blocked" }, { verdict: "failed" }, { group: "waiting-on-you" }, { status: "failed" },
      { paneId: "p", liveStatus: "blocked" },
    ] as const) expect(outcome(thread("t", extra)), JSON.stringify(extra)).toBe("decide");
  });

  it("is done when its report says so, its PR merged, it is resolved, or its PR waits for review", () => {
    for (const extra of [
      { verdict: "done" }, { pr: { state: "merged" } }, { status: "resolved" }, { status: "resolved", verdict: "blocked" },
      { group: "ready-for-review" }, { pr: { state: "merged" }, verdict: "needs-decision" },
    ] as const) expect(outcome(thread("t", extra)), JSON.stringify(extra)).toBe("done");
  });

  it("is in progress while it works, whatever an older report said, and while it idles without one", () => {
    for (const extra of [
      { group: "working" }, { status: "starting" }, { group: "working", verdict: "done" }, { paneId: "p", liveStatus: "working", verdict: "blocked" }, { group: "idle" },
    ] as const) expect(outcome(thread("t", extra)), JSON.stringify(extra)).toBe("progress");
  });

  it("still asks you while the agent waits on you, even after a report that said done", () => {
    expect(outcome(thread("t", { group: "waiting-on-you", verdict: "done" }))).toBe("decide");
  });
});

describe("a coordinator's Summary", () => {
  it("lists decisions, then work in progress, then what is done, newest first, and leaves out a section with nothing in it", () => {
    const sections = summarySections([
      thread("old-done", { verdict: "done", updated: "2026-10-01T00:00:00Z" }),
      thread("working", { group: "working" }),
      thread("new-done", { status: "resolved", updated: "2026-10-03T00:00:00Z" }),
      thread("blocked", { verdict: "blocked" }),
    ]);
    expect(sections.map(({ label, threads }) => [label, threads.map((item) => item.id)])).toEqual([
      ["Needs your decision", ["blocked"]],
      ["In progress", ["working"]],
      ["Done", ["new-done", "old-done"]],
    ]);
    expect(summarySections([thread("a", { group: "working" })]).map(({ label }) => label)).toEqual(["In progress"]);
    expect(summarySections([])).toEqual([]);
  });
});
