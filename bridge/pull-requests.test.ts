import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { githubRepo, parsePullRequests, parseRepo, parseViewer, PR_TTL_MS, PullRequestRegistry, remoteRepo, summarizeChecks, viewerArgv, type CommandRun } from "./pull-requests.ts";
import type { AgentView, LiveEvent } from "./types.ts";

function pane(paneId: string, cwd: string): AgentView {
  return { paneId, workspaceId: "w1", workspaceLabel: "W", workspaceNumber: 1, tabId: "t1", agent: "claude", status: "idle", cwd, focused: false };
}

const ghRow = (number: number, branch: string, extra: Record<string, unknown> = {}) => ({
  number, title: `PR ${number}`, url: `https://github.com/acme/shop/pull/${number}`, headRefName: branch, baseRefName: "main",
  isDraft: false, reviewDecision: "", statusCheckRollup: [], additions: 10, deletions: 2, updatedAt: "2026-10-10T10:00:00Z", ...extra,
});
const inRepo = (repo: string, number: number, branch: string) => ghRow(number, branch, { url: `https://github.com/${repo}/pull/${number}` });

/** The PR rows GitHub's GraphQL answer holds for `ghRow`s, with the checks under the last commit. */
const graphqlNode = (row: ReturnType<typeof ghRow>) => {
  const { statusCheckRollup, ...rest } = row;
  return { ...rest, commits: { nodes: [{ commit: { statusCheckRollup: (statusCheckRollup as unknown[]).length ? { contexts: { nodes: statusCheckRollup } } : null } }] } };
};
const viewerAnswer = (rows: ReturnType<typeof ghRow>[]) => ({ data: { viewer: { pullRequests: { nodes: rows.map(graphqlNode) } } } });

const remote = (name: string) => `remote.origin.url https://github.com/${name}.git\n`;

/**
 * A fake git + gh. Folders map to (common dir, toplevel, branch, and the remotes `git config` prints);
 * the GraphQL request answers `viewer` (rows, a raw answer, or a hang or a throw), and `gh pr list`
 * answers from `prs` by folder. Every call is recorded.
 */
function fakeRun(state: {
  folders: Record<string, [string, string, string, string?]>;
  viewer: ReturnType<typeof ghRow>[] | { code: number; stdout: string; stderr: string } | "hang" | "throw";
  prs?: Record<string, unknown[] | { code: number; stderr: string }>;
}) {
  const calls: Array<{ argv: string[]; cwd: string }> = [];
  const run: CommandRun = async (argv, { cwd }) => {
    calls.push({ argv, cwd });
    if (argv[0] === "git") {
      const folder = state.folders[cwd];
      if (!folder) return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
      if (argv[1] === "config") return folder[3] ? { code: 0, stdout: folder[3], stderr: "" } : { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: argv[1] === "branch" ? `${folder[2]}\n` : `${folder[0]}\n${folder[1]}\n`, stderr: "" };
    }
    if (argv[1] === "api") {
      if (state.viewer === "hang") return new Promise(() => {});
      if (state.viewer === "throw") throw new Error("spawn gh ENOENT");
      if (!Array.isArray(state.viewer)) return state.viewer;
      return { code: 0, stdout: JSON.stringify(viewerAnswer(state.viewer)), stderr: "" };
    }
    const answer = state.prs?.[cwd];
    if (!answer) return { code: 1, stdout: "", stderr: "no remote" };
    if (!Array.isArray(answer)) return { code: answer.code, stdout: "", stderr: answer.stderr };
    return { code: 0, stdout: JSON.stringify(answer), stderr: "" };
  };
  return { run, calls };
}

function registry(run: CommandRun, clock = { t: 1_000_000 }, timeouts = { gh: 15_000, git: 3_000 }, file?: string) {
  const events: LiveEvent[] = [];
  const logs: string[] = [];
  const prs = new PullRequestRegistry({ run, now: () => clock.t, live: { publish: (event) => events.push(event) }, log: (m) => logs.push(m), timeouts, file });
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

  test("reads the repo a remote names on github.com, in every shape gh accepts", () => {
    expect(githubRepo("https://github.com/acme/shop.git")).toBe("acme/shop");
    expect(githubRepo("https://www.github.com/acme/shop/")).toBe("acme/shop");
    expect(githubRepo("git@github.com:acme/shop.git")).toBe("acme/shop");
    expect(githubRepo("ssh://git@ssh.github.com:443/acme/shop")).toBe("acme/shop");
    expect(githubRepo("git+ssh://git@github.com/acme/shop")).toBe("acme/shop");
    // A remote on this machine, which gh skips.
    expect(githubRepo("/srv/git/shop.git")).toBeNull();
    expect(githubRepo("../shop")).toBeNull();
    expect(githubRepo("file:///srv/git/shop.git")).toBeNull();
    // An ssh alias, another host, a deeper path or a name GitHub cannot have: only gh can say.
    expect(githubRepo("git@github-work:acme/shop.git")).toBeUndefined();
    expect(githubRepo("https://gitlab.com/acme/shop")).toBeUndefined();
    expect(githubRepo("https://github.com/acme/shop/tree")).toBeUndefined();
    expect(githubRepo("https://github.com/acme/%E0%A4%A")).toBeUndefined();
    expect(githubRepo("https://github.com/acme/shop%20is:closed")).toBeUndefined();
  });

  test("picks the remote gh picks: the one set as default, else upstream, github, origin, then by name", () => {
    expect(remoteRepo("remote.origin.url https://github.com/me/shop\nremote.origin.fetch +refs/heads/*:refs/remotes/origin/*\n")).toBe("me/shop");
    expect(remoteRepo("remote.origin.url https://github.com/me/shop\nremote.upstream.url git@github.com:acme/shop.git\n")).toBe("acme/shop");
    expect(remoteRepo("remote.zed.url https://github.com/me/shop\nremote.abc.url https://github.com/acme/shop\n")).toBe("acme/shop");
    expect(remoteRepo("remote.constructor.url https://github.com/me/shop\nremote.origin.url https://github.com/acme/shop\n")).toBe("acme/shop");
    expect(remoteRepo("remote.origin.url https://github.com/me/shop\nremote.origin.gh-resolved base\nremote.upstream.url https://github.com/acme/shop\n")).toBe("me/shop");
    expect(remoteRepo("remote.origin.url https://github.com/me/shop\nremote.origin.gh-resolved acme/other\n")).toBe("acme/other");
    expect(remoteRepo("remote.my.fork.pushurl https://github.com/me/fork\n")).toBe("me/fork");
    // gh skips remotes on this machine, even origin; with nothing else there is no GitHub repo.
    expect(remoteRepo("remote.origin.url /home/me/shop\nremote.zz.url https://github.com/acme/shop\n")).toBe("acme/shop");
    expect(remoteRepo("remote.origin.url /home/me/shop\n")).toBeNull();
    // The push URL counts only when the fetch URL names no repo: an alias still leaves it to gh.
    expect(remoteRepo("remote.origin.url /home/me/shop\nremote.origin.pushurl https://github.com/acme/shop\n")).toBe("acme/shop");
    expect(remoteRepo("remote.origin.url git@github-work:me/shop\nremote.origin.pushurl git@github.com:acme/shop\n")).toBeUndefined();
    // A remote gh alone can read, or none at all, leaves the repo to gh.
    expect(remoteRepo("remote.origin.url https://github.com/me/shop\nremote.work.url git@github-work:acme/shop\n")).toBeUndefined();
    expect(remoteRepo("")).toBeUndefined();
  });

  test("reads the viewer's open PRs, as gh pr list would have printed them", () => {
    const argv = viewerArgv();
    expect(argv.slice(0, 6)).toEqual(["gh", "api", "--hostname", "github.com", "graphql", "-f"]);
    expect(argv[6]).toContain("viewer{pullRequests(states:OPEN,first:100,orderBy:{field:UPDATED_AT,direction:DESC})");
    const row = ghRow(7, "feat/x", { reviewDecision: "APPROVED", statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "StatusContext", state: "PENDING" }] });
    const answer = viewerAnswer([row]);
    (answer.data.viewer.pullRequests.nodes as unknown[]).push({});
    const rows = parseViewer(JSON.stringify(answer));
    expect(rows).toEqual(parsePullRequests(JSON.stringify([row])));
    expect(rows).toMatchObject([{ number: 7, review: "approved", checks: { passed: 1, failed: 0, pending: 1 } }]);
    expect(() => parseViewer(JSON.stringify({ errors: [{ message: "Bad credentials" }] }))).toThrow("Bad credentials");
    expect(() => parseViewer(JSON.stringify({ message: "Bad credentials" }))).toThrow("GitHub gave no pull requests");
    expect(() => parseViewer("")).toThrow();
  });

  test("maps a worktree to its main repo and a detached HEAD to no branch", () => {
    expect(parseRepo("/r/shop/.git\n/r/shop-wt\n", "feat/x\n")).toEqual({ repo: "/r/shop", toplevel: "/r/shop-wt", branch: "feat/x" });
    expect(parseRepo("/r/bare.git\n/r/bare-wt\n", "")).toEqual({ repo: "/r/bare.git", toplevel: "/r/bare-wt", branch: "" });
    expect(parseRepo("", "main")).toBeUndefined();
  });
});

describe("registry", () => {
  const folders: Record<string, [string, string, string, string]> = {
    "/r/shop": ["/r/shop/.git", "/r/shop", "develop", remote("acme/shop")],
    "/r/shop/src": ["/r/shop/.git", "/r/shop", "develop", remote("acme/shop")],
    "/h/worktrees/shop/a": ["/r/shop/.git", "/h/worktrees/shop/a", "feat/a", remote("acme/shop")],
    "/h/worktrees/shop/b": ["/r/shop/.git", "/h/worktrees/shop/b", "feat/b", remote("acme/shop")],
    "/r/shop-clone": ["/r/shop-clone/.git", "/r/shop-clone", "feat/a", remote("acme/shop")],
    "/r/api": ["/r/api/.git", "/r/api", "main", remote("acme/api")],
  };
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test("asks GitHub once for every open PR, repos with no pane included, and maps each to the panes on its branch", async () => {
    const { run, calls } = fakeRun({ folders, viewer: [inRepo("acme/shop", 1, "feat/a"), inRepo("acme/elsewhere", 4, "feat/a"), inRepo("acme/shop", 2, "feat/z"), inRepo("acme/api", 3, "main")] });
    const { prs, events } = registry(run);
    const panes = [pane("p1", "/r/shop"), pane("p2", "/h/worktrees/shop/a"), pane("p3", "/h/worktrees/shop/b"), pane("p4", "/r/shop/src"), pane("p5", "/r/api"), pane("p6", "/tmp"), pane("p7", "/h/worktrees/shop/a"), pane("p8", "/r/shop-clone")];
    expect(prs.list("main", panes)).toEqual([]);
    await prs.refresh();
    const gh = calls.filter((call) => call.argv[0] === "gh");
    expect(gh.map((call) => call.argv[1])).toEqual(["api"]);
    // GitHub's order, each PR once, however many clones of its repo the panes sit in.
    expect(prs.list("main", panes).map((pr) => [pr.repo, pr.number, pr.paneIds])).toEqual([
      ["acme/shop", 1, ["p2", "p7", "p8"]], ["acme/elsewhere", 4, []], ["acme/shop", 2, []], ["acme/api", 3, ["p5"]],
    ]);
    expect(events).toEqual([{ session: "main", topic: "snapshot" }]);
  });

  test("caches for the TTL, then refreshes in the background on a read", async () => {
    const { run, calls } = fakeRun({ folders, viewer: [ghRow(1, "feat/a")] });
    const { prs, events, clock } = registry(run);
    const panes = [pane("p1", "/r/shop")];
    prs.list("main", panes);
    await prs.refresh();
    const gh = () => calls.filter((call) => call.argv[0] === "gh").length;
    clock.t += PR_TTL_MS - 1;
    prs.list("main", panes);
    await Bun.sleep(0);
    expect(gh()).toBe(1);
    clock.t += 1;
    prs.list("main", panes);
    // Joins the refresh the read started rather than starting another.
    await prs.refresh();
    expect(gh()).toBe(2);
    // Nothing changed after the first read, so only one event.
    expect(events.length).toBe(1);
  });

  test("a folder read before costs one git call a refresh: its branch", async () => {
    const moving = structuredClone(folders);
    const { run, calls } = fakeRun({ folders: moving, viewer: [] });
    const { prs, clock } = registry(run);
    const panes = [pane("p1", "/h/worktrees/shop/a"), pane("p2", "/tmp")];
    prs.list("main", panes);
    await prs.refresh();
    const before = calls.length;
    moving["/h/worktrees/shop/a"]![2] = "feat/a2";
    clock.t += PR_TTL_MS;
    await prs.refresh();
    expect(calls.slice(before).filter((call) => call.cwd === "/h/worktrees/shop/a").map((call) => call.argv[1])).toEqual(["branch", "config"]);
    expect(prs.onBranch("/h/worktrees/shop/a")).toBeUndefined();
  });

  test("a GitHub failure keeps the last good list and is logged once", async () => {
    const state: Parameters<typeof fakeRun>[0] = { folders, viewer: [ghRow(1, "feat/a")] };
    const { run } = fakeRun(state);
    const { prs, logs, events } = registry(run);
    const panes = [pane("p1", "/r/shop")];
    prs.list("main", panes);
    await prs.refresh();
    state.viewer = { code: 4, stdout: "", stderr: "gh auth login required\nmore" };
    await prs.refresh();
    await prs.refresh();
    expect(prs.list("main", panes).map((pr) => pr.number)).toEqual([1]);
    expect(logs).toEqual(["gh auth login required"]);
    state.viewer = "throw";
    await prs.refresh();
    // A 401 answers with a REST-style body: gh's stderr is the reason.
    state.viewer = { code: 1, stdout: JSON.stringify({ message: "Bad credentials" }), stderr: "gh: Bad credentials (HTTP 401)" };
    await prs.refresh();
    expect(logs).toEqual(["gh auth login required", "spawn gh ENOENT", "gh: Bad credentials (HTTP 401)"]);
    expect(prs.list("main", panes).map((pr) => pr.number)).toEqual([1]);
    expect(events.length).toBe(1);
    // A partial answer: gh exits 1 and still prints what GitHub answered.
    state.viewer = { code: 1, stdout: JSON.stringify(viewerAnswer([ghRow(5, "main")])), stderr: "gh: Something went wrong" };
    await prs.refresh();
    expect(prs.list("main", panes).map((pr) => pr.number)).toEqual([5]);
  });

  test("a gh that never answers times out instead of hanging the refresh", async () => {
    const { run } = fakeRun({ folders, viewer: "hang" });
    const { prs, logs } = registry(run, undefined, { gh: 50, git: 50 });
    prs.list("main", [pane("p1", "/r/shop")]);
    const started = Date.now();
    await prs.refresh();
    // The fake ignores the runner's kill; the guard's own timer still ends the wait.
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(logs).toEqual(["timed out"]);
  });

  test("a pane in a new folder asks for a sooner refresh, but not on every read", async () => {
    const { run, calls } = fakeRun({ folders, viewer: [inRepo("acme/api", 3, "main")] });
    const { prs, clock } = registry(run);
    prs.list("main", [pane("p1", "/r/shop")]);
    await prs.refresh();
    const after = calls.length;
    clock.t += 1_000;
    const panes = [pane("p1", "/r/shop"), pane("p2", "/r/api")];
    expect(prs.list("main", panes).map((pr) => pr.paneIds)).toEqual([[]]);
    await Promise.resolve();
    expect(calls.length).toBe(after);
    clock.t += 5_000;
    prs.list("main", panes);
    await prs.refresh();
    expect(prs.list("main", panes).map((pr) => pr.paneIds)).toEqual([["p2"]]);
  });

  test("names a repo only gh can name from the rows gh pr list reads there, and asks nobody about a local-only one", async () => {
    const { run, calls } = fakeRun({
      folders: {
        "/r/alias": ["/r/alias/.git", "/r/alias", "feat/x", "remote.origin.url git@github-work:acme/alias.git\n"],
        "/r/home": ["/r/home/.git", "/r/home", "main", "remote.origin.url /r/upstream-home\n"],
      },
      viewer: [inRepo("acme/alias", 9, "feat/x")],
      prs: { "/r/alias": [inRepo("acme/alias", 9, "feat/x")] },
    });
    const { prs } = registry(run);
    const panes = [pane("p1", "/r/alias"), pane("p2", "/r/home")];
    prs.list("main", panes);
    await prs.refresh();
    expect(calls.filter((call) => call.argv[1] === "pr").map((call) => call.cwd)).toEqual(["/r/alias"]);
    expect(prs.list("main", panes).map((pr) => [pr.number, pr.paneIds])).toEqual([[9, ["p1"]]]);
  });

  test("caps the repos it asks gh pr list about", async () => {
    const many: Record<string, [string, string, string]> = {};
    for (let i = 0; i < 20; i++) many[`/r/${i}`] = [`/r/${i}/.git`, `/r/${i}`, "main"];
    const { run, calls } = fakeRun({ folders: many, viewer: [] });
    const { prs } = registry(run, { t: 0 });
    prs.list("main", Object.keys(many).map((cwd, i) => pane(`p${i}`, cwd)));
    await prs.refresh();
    expect(calls.filter((call) => call.argv[1] === "pr").length).toBe(12);
  });

  test("keeps the last list on disk, so a restart shows it before GitHub answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nenu-prs-"));
    dirs.push(dir);
    const file = join(dir, "pull-requests.json");
    const first = registry(fakeRun({ folders, viewer: [ghRow(1, "feat/a")] }).run, undefined, undefined, file);
    first.prs.list("main", [pane("p1", "/r/shop")]);
    await first.prs.refresh();
    await Bun.sleep(10);
    expect(JSON.parse(readFileSync(file, "utf8")).prs).toMatchObject([{ number: 1 }]);
    const restarted = registry(fakeRun({ folders, viewer: "hang" }).run, undefined, { gh: 50, git: 50 }, file);
    expect(restarted.prs.list("main", [pane("p2", "/h/worktrees/shop/a")]).map((pr) => [pr.number, pr.paneIds])).toEqual([[1, []]]);
    await restarted.prs.refresh();
    // Matched to its pane once the folders are read, though GitHub never answered.
    expect(restarted.prs.list("main", [pane("p2", "/h/worktrees/shop/a")]).map((pr) => [pr.number, pr.paneIds])).toEqual([[1, ["p2"]]]);
    writeFileSync(file, JSON.stringify({ prs: [{ number: 2 }] }));
    expect(registry(fakeRun({ folders, viewer: [] }).run, undefined, undefined, file).prs.list("main", [])).toEqual([]);
  });

  test("finds a PR by number in the repo a folder sits in, with the branch that folder is on", async () => {
    const { run, calls } = fakeRun({ folders, viewer: [inRepo("acme/shop", 1, "feat/a"), inRepo("acme/shop", 2, "feat/z"), inRepo("acme/api", 1, "fix/api")] });
    const { prs } = registry(run);
    const panes = [pane("p1", "/r/shop"), pane("p2", "/h/worktrees/shop/a"), pane("p5", "/r/api")];
    expect(prs.locate("/h/worktrees/shop/a", 1)).toBeUndefined();
    prs.list("main", panes);
    await prs.refresh();
    const before = calls.length;
    expect(prs.locate("/h/worktrees/shop/a", 1)).toMatchObject({ checkedOut: "feat/a", pr: { number: 1, branch: "feat/a", base: "main" } });
    expect(prs.locate("/r/shop", 2)).toMatchObject({ checkedOut: "develop", pr: { number: 2, branch: "feat/z" } });
    // The same number in another repo is another PR.
    expect(prs.locate("/r/api", 1)).toMatchObject({ pr: { branch: "fix/api" } });
    expect(prs.locate("/r/api", 2)).toBeUndefined();
    expect(prs.locate("/tmp", 1)).toBeUndefined();
    // Answers from what the last refresh read; it never runs a command.
    expect(calls.length).toBe(before);
  });

  test("finds the PR of the branch a folder has checked out, with no number to go on", async () => {
    const { run, calls } = fakeRun({ folders, viewer: [inRepo("acme/shop", 1, "feat/a"), inRepo("acme/shop", 2, "feat/z"), inRepo("acme/api", 3, "develop")] });
    const { prs } = registry(run);
    expect(prs.onBranch("/h/worktrees/shop/a")).toBeUndefined();
    prs.list("main", [pane("p1", "/r/shop"), pane("p2", "/h/worktrees/shop/a")]);
    await prs.refresh();
    const before = calls.length;
    expect(prs.onBranch("/h/worktrees/shop/a")).toMatchObject({ number: 1, branch: "feat/a", base: "main" });
    // On `develop`, which no PR of this repo is opened from.
    expect(prs.onBranch("/r/shop")).toBeUndefined();
    expect(prs.onBranch("/tmp")).toBeUndefined();
    expect(calls.length).toBe(before);
  });
});
