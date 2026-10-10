import { describe, expect, test } from "bun:test";

import { parsePullRequests, parseRepo, PR_TTL_MS, PullRequestRegistry, summarizeChecks, type CommandRun } from "./pull-requests.ts";
import type { AgentView, LiveEvent } from "./types.ts";

function pane(paneId: string, cwd: string): AgentView {
  return { paneId, workspaceId: "w1", workspaceLabel: "W", workspaceNumber: 1, tabId: "t1", agent: "claude", status: "idle", cwd, focused: false };
}

const ghRow = (number: number, branch: string, extra: Record<string, unknown> = {}) => ({
  number, title: `PR ${number}`, url: `https://github.com/acme/shop/pull/${number}`, headRefName: branch, baseRefName: "main",
  isDraft: false, reviewDecision: "", statusCheckRollup: [], additions: 10, deletions: 2, updatedAt: "2026-10-10T10:00:00Z", ...extra,
});

/**
 * A fake git + gh. Folders map to (common dir, toplevel, branch); repos (by toplevel) map to the PR
 * list gh prints, or a failure. Every call is recorded.
 */
function fakeRun(state: {
  folders: Record<string, [string, string, string]>;
  prs: Record<string, unknown[] | { code: number; stderr: string } | "hang" | "throw">;
}) {
  const calls: Array<{ argv: string[]; cwd: string }> = [];
  const run: CommandRun = async (argv, { cwd }) => {
    calls.push({ argv, cwd });
    if (argv[0] === "git") {
      const folder = state.folders[cwd];
      if (!folder) return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
      return { code: 0, stdout: argv[1] === "branch" ? `${folder[2]}\n` : `${folder[0]}\n${folder[1]}\n`, stderr: "" };
    }
    const answer = state.prs[cwd];
    if (answer === "hang") return new Promise(() => {});
    if (answer === "throw") throw new Error("spawn gh ENOENT");
    if (!answer) return { code: 1, stdout: "", stderr: "no remote" };
    if (!Array.isArray(answer)) return { code: answer.code, stdout: "", stderr: answer.stderr };
    return { code: 0, stdout: JSON.stringify(answer), stderr: "" };
  };
  return { run, calls };
}

function registry(run: CommandRun, clock = { t: 1_000_000 }, timeouts = { gh: 15_000, git: 3_000 }) {
  const events: LiveEvent[] = [];
  const logs: string[] = [];
  const prs = new PullRequestRegistry({ run, now: () => clock.t, live: { publish: (event) => events.push(event) }, log: (m) => logs.push(m), timeouts });
  return { prs, events, logs, clock };
}

describe("parsing", () => {
  test("summarizes check runs and commit statuses", () => {
    expect(summarizeChecks([])).toBeUndefined();
    expect(summarizeChecks([
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" },
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "SKIPPED" },
      { __typename: "CheckRun", status: "COMPLETED", conclusion: "FAILURE" },
      { __typename: "CheckRun", status: "IN_PROGRESS", conclusion: "" },
      { __typename: "StatusContext", state: "SUCCESS" },
      { __typename: "StatusContext", state: "PENDING" },
      { __typename: "StatusContext", state: "ERROR" },
    ])).toEqual({ passed: 3, failed: 2, pending: 2 });
  });

  test("reads gh's rows and drops malformed ones", () => {
    const rows = parsePullRequests(JSON.stringify([
      ghRow(7, "feat/x", { isDraft: true, reviewDecision: "APPROVED", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }),
      { number: 8, title: "no url", headRefName: "b" },
      ghRow(9, "feat/y", { url: "https://evil.example/acme/shop/pull/9" }),
    ]));
    expect(rows).toEqual([{
      repo: "acme/shop", number: 7, title: "PR 7", url: "https://github.com/acme/shop/pull/7", branch: "feat/x", base: "main", draft: true,
      review: "approved", checks: { passed: 1, failed: 0, pending: 0 }, diff: { additions: 10, deletions: 2 }, updatedAt: Date.parse("2026-10-10T10:00:00Z"),
    }]);
    expect(() => parsePullRequests("{}")).toThrow();
  });

  test("maps a worktree to its main repo and a detached HEAD to no branch", () => {
    expect(parseRepo("/r/shop/.git\n/r/shop-wt\n", "feat/x\n")).toEqual({ repo: "/r/shop", toplevel: "/r/shop-wt", branch: "feat/x" });
    expect(parseRepo("/r/bare.git\n/r/bare-wt\n", "")).toEqual({ repo: "/r/bare.git", toplevel: "/r/bare-wt", branch: "" });
    expect(parseRepo("", "main")).toBeUndefined();
  });
});

describe("registry", () => {
  const folders: Record<string, [string, string, string]> = {
    "/r/shop": ["/r/shop/.git", "/r/shop", "develop"],
    "/r/shop/src": ["/r/shop/.git", "/r/shop", "develop"],
    "/h/worktrees/shop/a": ["/r/shop/.git", "/h/worktrees/shop/a", "feat/a"],
    "/h/worktrees/shop/b": ["/r/shop/.git", "/h/worktrees/shop/b", "feat/b"],
    "/r/api": ["/r/api/.git", "/r/api", "main"],
  };

  test("runs gh once per repo, worktrees included, and maps each PR to the panes on its branch", async () => {
    const { run, calls } = fakeRun({ folders, prs: { "/r/shop": [ghRow(1, "feat/a"), ghRow(2, "feat/z")], "/r/api": [] } });
    const { prs, events } = registry(run);
    const panes = [pane("p1", "/r/shop"), pane("p2", "/h/worktrees/shop/a"), pane("p3", "/h/worktrees/shop/b"), pane("p4", "/r/shop/src"), pane("p5", "/r/api"), pane("p6", "/tmp"), pane("p7", "/h/worktrees/shop/a")];
    expect(prs.list("main", panes)).toEqual([]);
    await prs.refresh();
    const gh = calls.filter((call) => call.argv[0] === "gh");
    expect(gh.map((call) => call.cwd).sort()).toEqual(["/r/api", "/r/shop"]);
    expect(gh[0]!.argv.slice(0, 7)).toEqual(["gh", "pr", "list", "--state", "open", "--author", "@me"]);
    const list = prs.list("main", panes);
    expect(list.map((pr) => [pr.number, pr.paneIds])).toEqual([[1, ["p2", "p7"]], [2, []]]);
    expect(events).toEqual([{ session: "main", topic: "snapshot" }]);
  });

  test("caches for the TTL, then refreshes in the background on a read", async () => {
    const { run, calls } = fakeRun({ folders, prs: { "/r/shop": [ghRow(1, "feat/a")] } });
    const { prs, events, clock } = registry(run);
    const panes = [pane("p1", "/r/shop")];
    prs.list("main", panes);
    await prs.refresh();
    const after = calls.length;
    clock.t += PR_TTL_MS - 1;
    prs.list("main", panes);
    await Bun.sleep(0);
    expect(calls.length).toBe(after);
    clock.t += 1;
    prs.list("main", panes);
    // Joins the refresh the read started rather than starting another.
    await prs.refresh();
    expect(calls.length).toBe(after * 2);
    // Nothing changed after the first read, so only one event.
    expect(events.length).toBe(1);
  });

  test("a gh failure keeps the last good list and is logged once", async () => {
    const state = { folders, prs: { "/r/shop": [ghRow(1, "feat/a")] } as Parameters<typeof fakeRun>[0]["prs"] };
    const { run } = fakeRun(state);
    const { prs, logs, events } = registry(run);
    const panes = [pane("p1", "/r/shop")];
    prs.list("main", panes);
    await prs.refresh();
    state.prs["/r/shop"] = { code: 4, stderr: "gh auth login required\nmore" };
    await prs.refresh();
    await prs.refresh();
    expect(prs.list("main", panes).map((pr) => pr.number)).toEqual([1]);
    expect(logs).toEqual(["shop: gh auth login required"]);
    state.prs["/r/shop"] = "throw";
    await prs.refresh();
    expect(logs).toEqual(["shop: gh auth login required", "shop: spawn gh ENOENT"]);
    expect(prs.list("main", panes).map((pr) => pr.number)).toEqual([1]);
    expect(events.length).toBe(1);
  });

  test("a gh that never answers times out instead of hanging the refresh", async () => {
    const { run } = fakeRun({ folders, prs: { "/r/shop": "hang", "/r/api": [ghRow(5, "main")] } });
    const { prs, logs } = registry(run, undefined, { gh: 50, git: 50 });
    prs.list("main", [pane("p1", "/r/shop"), pane("p2", "/r/api")]);
    const started = Date.now();
    await prs.refresh();
    // The fake ignores the runner's kill; the guard's own timer still ends the wait.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(logs).toEqual(["shop: timed out"]);
    expect(prs.list("main", [pane("p2", "/r/api")]).map((pr) => [pr.number, pr.paneIds])).toEqual([[5, ["p2"]]]);
  });

  test("a pane in a new folder asks for a sooner refresh, but not on every read", async () => {
    const { run, calls } = fakeRun({ folders, prs: { "/r/shop": [], "/r/api": [] } });
    const { prs, clock } = registry(run);
    prs.list("main", [pane("p1", "/r/shop")]);
    await prs.refresh();
    const after = calls.length;
    clock.t += 1_000;
    prs.list("main", [pane("p1", "/r/shop"), pane("p2", "/r/api")]);
    await Promise.resolve();
    expect(calls.length).toBe(after);
    clock.t += 5_000;
    prs.list("main", [pane("p1", "/r/shop"), pane("p2", "/r/api")]);
    await prs.refresh();
    expect(calls.some((call) => call.argv[0] === "gh" && call.cwd === "/r/api")).toBe(true);
  });

  test("caps the repos it asks GitHub about", async () => {
    const many: Record<string, [string, string, string]> = {};
    for (let i = 0; i < 20; i++) many[`/r/${i}`] = [`/r/${i}/.git`, `/r/${i}`, "main"];
    const { run, calls } = fakeRun({ folders: many, prs: {} });
    const { prs } = registry(run, { t: 0 });
    prs.list("main", Object.keys(many).map((cwd, i) => pane(`p${i}`, cwd)));
    await prs.refresh();
    expect(calls.filter((call) => call.argv[0] === "gh").length).toBe(12);
  });
});
