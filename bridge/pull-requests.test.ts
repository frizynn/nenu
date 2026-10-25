import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseRepo, parseViewer, PR_TTL_MS, PullRequestRegistry, remoteName, remoteRepos, summarizeChecks, viewerArgv, type CommandRun } from "./pull-requests.ts";
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
 * the GraphQL request answers `viewer` (rows, a raw answer, or a hang or a throw), and a git command
 * named in `hang` as "<folder> <subcommand>" never answers. Every call is recorded.
 */
function fakeRun(state: {
  folders: Record<string, [string, string, string, string?]>;
  viewer: ReturnType<typeof ghRow>[] | { code: number; stdout: string; stderr: string } | "hang" | "throw";
  hang?: Set<string>;
}) {
  const calls: Array<{ argv: string[]; cwd: string }> = [];
  const run: CommandRun = async (argv, { cwd }) => {
    calls.push({ argv, cwd });
    if (argv[0] === "git") {
      if (state.hang?.has(`${cwd} ${argv[1]}`)) return new Promise(() => {});
      const folder = state.folders[cwd];
      if (!folder) return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
      if (argv[1] === "config") return folder[3] ? { code: 0, stdout: folder[3], stderr: "" } : { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: argv[1] === "branch" ? `${folder[2]}\n` : `${folder[0]}\n${folder[1]}\n`, stderr: "" };
    }
    if (state.viewer === "hang") return new Promise(() => {});
    if (state.viewer === "throw") throw new Error("spawn gh ENOENT");
    if (!Array.isArray(state.viewer)) return state.viewer;
    return { code: 0, stdout: JSON.stringify(viewerAnswer(state.viewer)), stderr: "" };
  };
  return { run, calls };
}

/** Each repo's `config` file is as old as `mtimes` says, else unchanged since the epoch. */
function registry(run: CommandRun, clock = { t: 1_000_000 }, timeouts = { gh: 15_000, git: 3_000 }, file?: string, mtimes: Record<string, number> = {}) {
  const events: LiveEvent[] = [];
  const logs: string[] = [];
  const prs = new PullRequestRegistry({
    run, now: () => clock.t, live: { publish: (event) => events.push(event) }, log: (m) => logs.push(m), timeouts, file, mtime: (path) => mtimes[path] ?? 0,
  });
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

  test("reads GitHub's rows and drops malformed ones", () => {
    const answer = viewerAnswer([
      ghRow(7, "feat/x", { isDraft: true, reviewDecision: "APPROVED", statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] }),
      ghRow(9, "feat/y", { url: "https://evil.example/acme/shop/pull/9" }),
    ]);
    (answer.data.viewer.pullRequests.nodes as unknown[]).push({ number: 8, title: "no url", headRefName: "b" }, {});
    const rows = parseViewer(JSON.stringify(answer));
    expect(rows).toEqual([{
      repo: "acme/shop", number: 7, title: "PR 7", url: "https://github.com/acme/shop/pull/7", branch: "feat/x", base: "main", draft: true,
      review: "approved", checks: { passed: 1, failed: 0, pending: 0 }, diff: { additions: 10, deletions: 2 }, updatedAt: Date.parse("2026-10-10T10:00:00Z"),
    }]);
  });

  test("reads the repo a remote names, in every shape gh accepts, an ssh alias's included", () => {
    expect(remoteName("https://github.com/acme/shop.git")).toBe("acme/shop");
    expect(remoteName("https://www.github.com/acme/shop/")).toBe("acme/shop");
    expect(remoteName("git@github.com:acme/shop.git")).toBe("acme/shop");
    expect(remoteName("ssh://git@ssh.github.com:443/acme/shop")).toBe("acme/shop");
    expect(remoteName("git+ssh://git@github.com/acme/shop")).toBe("acme/shop");
    expect(remoteName("git@github-work:acme/shop.git")).toBe("acme/shop");
    // A remote on this machine, a deeper path or a name GitHub cannot have names no repo.
    expect(remoteName("/srv/git/shop.git")).toBeUndefined();
    expect(remoteName("../shop")).toBeUndefined();
    expect(remoteName("file:///srv/git/shop.git")).toBeUndefined();
    expect(remoteName("https://github.com/acme/shop/tree")).toBeUndefined();
    expect(remoteName("https://github.com/acme/%E0%A4%A")).toBeUndefined();
    expect(remoteName("https://github.com/acme/shop%20is:closed")).toBeUndefined();
  });

  test("names every repo a checkout's remotes name, so a fork's PRs to its upstream count too", () => {
    expect(remoteRepos("remote.origin.url https://github.com/me/shop\nremote.origin.fetch +refs/heads/*:refs/remotes/origin/*\n")).toEqual(["me/shop"]);
    expect(remoteRepos("remote.origin.url https://github.com/me/shop\nremote.upstream.url git@github.com:acme/shop.git\n")).toEqual(["me/shop", "acme/shop"]);
    expect(remoteRepos("remote.origin.url https://github.com/me/shop\nremote.origin.gh-resolved acme/other\nremote.origin.gh-resolved base\n")).toEqual(["me/shop", "acme/other"]);
    expect(remoteRepos("remote.my.fork.pushurl https://github.com/me/fork\nremote.work.url git@github-work:acme/shop\n")).toEqual(["me/fork", "acme/shop"]);
    // Another host's remote names its own repo, which a GitHub PR of the other remote never displaces.
    expect(remoteRepos("remote.upstream.url https://gitlab.com/acme/mirror\nremote.origin.url https://github.com/me/shop\n")).toEqual(["acme/mirror", "me/shop"]);
    expect(remoteRepos("remote.origin.url /home/me/shop\nremote.zz.url https://github.com/me/shop/tree\n")).toEqual([]);
    expect(remoteRepos("")).toEqual([]);
    // GitHub ignores case; so does the match.
    expect(remoteRepos("remote.origin.url git@github.com:AltanS/Collie.git\n")).toEqual(["altans/collie"]);
  });

  test("reads the viewer's open PRs, as gh pr list would have printed them", () => {
    const argv = viewerArgv();
    expect(argv.slice(0, 6)).toEqual(["gh", "api", "--hostname", "github.com", "graphql", "-f"]);
    expect(argv[6]).toContain("viewer{pullRequests(states:OPEN,first:100,orderBy:{field:UPDATED_AT,direction:DESC})");
    const row = ghRow(7, "feat/x", { reviewDecision: "APPROVED", statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "StatusContext", state: "PENDING" }] });
    const rows = parseViewer(JSON.stringify(viewerAnswer([row])));
    expect(rows).toMatchObject([{ number: 7, review: "approved", checks: { passed: 1, failed: 0, pending: 1 } }]);
    expect(() => parseViewer(JSON.stringify({ errors: [{ message: "Bad credentials" }] }))).toThrow("Bad credentials");
    expect(() => parseViewer(JSON.stringify({ message: "Bad credentials" }))).toThrow("GitHub gave no pull requests");
    expect(() => parseViewer("")).toThrow();
  });

  test("maps a worktree to its main repo and a detached HEAD to no branch", () => {
    expect(parseRepo("/r/shop/.git\n/r/shop-wt\n", "feat/x\n")).toEqual({ repo: "/r/shop", gitDir: "/r/shop/.git", toplevel: "/r/shop-wt", branch: "feat/x" });
    expect(parseRepo("/r/bare.git\n/r/bare-wt\n", "")).toEqual({ repo: "/r/bare.git", gitDir: "/r/bare.git", toplevel: "/r/bare-wt", branch: "" });
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

  test("a folder read before costs one git call a refresh, its branch; one outside a repo is looked at again", async () => {
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
    expect(calls.slice(before).filter((call) => call.argv[0] === "git").map((call) => [call.cwd, call.argv[1]])).toEqual([["/h/worktrees/shop/a", "branch"], ["/tmp", "rev-parse"]]);
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

  test("names a repo by its ssh alias's path, and runs gh only for GitHub's list", async () => {
    const { run, calls } = fakeRun({
      folders: {
        "/r/alias": ["/r/alias/.git", "/r/alias", "feat/x", "remote.origin.url git@github-work:acme/alias.git\n"],
        "/r/home": ["/r/home/.git", "/r/home", "main", "remote.origin.url /r/upstream-home\n"],
        "/r/scratch": ["/r/scratch/.git", "/r/scratch", "main"],
      },
      viewer: [inRepo("acme/alias", 9, "feat/x")],
    });
    const { prs } = registry(run);
    const panes = [pane("p1", "/r/alias"), pane("p2", "/r/home"), pane("p3", "/r/scratch")];
    prs.list("main", panes);
    await prs.refresh();
    expect(calls.filter((call) => call.argv[0] === "gh").map((call) => call.argv[1])).toEqual(["api"]);
    expect(prs.list("main", panes).map((pr) => [pr.number, pr.paneIds])).toEqual([[9, ["p1"]]]);
  });

  test("reads remotes every refresh when the config file's date cannot be read", async () => {
    const { run, calls } = fakeRun({ folders, viewer: [] });
    const prs = new PullRequestRegistry({ run, now: () => 0, log: () => {}, mtime: () => undefined });
    prs.list("main", [pane("p1", "/r/shop")]);
    await prs.refresh();
    await prs.refresh();
    expect(calls.filter((call) => call.argv[1] === "config").length).toBe(2);
  });

  test("reads a repo's remotes again only when its config file changes", async () => {
    const local: Record<string, [string, string, string, string?]> = { "/r/new": ["/r/new/.git", "/r/new", "feat/x"] };
    const mtimes: Record<string, number> = { "/r/new/.git/config": 1 };
    const { run, calls } = fakeRun({ folders: local, viewer: [inRepo("acme/new", 5, "feat/x")] });
    const { prs, clock, events } = registry(run, undefined, undefined, undefined, mtimes);
    const panes = [pane("p1", "/r/new")];
    prs.list("main", panes);
    await prs.refresh();
    // `git init` and no remote yet: the PR is listed, on no pane.
    expect(prs.list("main", panes).map((pr) => pr.paneIds)).toEqual([[]]);
    clock.t += PR_TTL_MS;
    await prs.refresh();
    expect(calls.filter((call) => call.argv[1] === "config").length).toBe(1);
    // `gh repo create --source . --push` adds the remote: the config file changes, and the PR finds its pane.
    local["/r/new"]![3] = remote("acme/new");
    mtimes["/r/new/.git/config"] = 2;
    clock.t += PR_TTL_MS;
    await prs.refresh();
    expect(calls.filter((call) => call.argv[1] === "config").length).toBe(2);
    expect(prs.list("main", panes).map((pr) => pr.paneIds)).toEqual([["p1"]]);
    expect(prs.onBranch("/r/new")).toMatchObject({ number: 5 });
    expect(events.length).toBe(2);
  });

  test("a git that never answers keeps what the folder and its remotes said, and is asked again", async () => {
    const state: Parameters<typeof fakeRun>[0] = { folders, viewer: [inRepo("acme/shop", 1, "feat/a")] };
    const { run, calls } = fakeRun(state);
    const mtimes: Record<string, number> = {};
    const { prs, clock, events } = registry(run, undefined, { gh: 50, git: 50 }, undefined, mtimes);
    const panes = [pane("p2", "/h/worktrees/shop/a")];
    prs.list("main", panes);
    await prs.refresh();
    expect(prs.list("main", panes).map((pr) => pr.paneIds)).toEqual([["p2"]]);
    state.hang = new Set(["/h/worktrees/shop/a branch", "/h/worktrees/shop/a config"]);
    mtimes["/r/shop/.git/config"] = 7;
    clock.t += PR_TTL_MS;
    await prs.refresh();
    expect(prs.list("main", panes).map((pr) => pr.paneIds)).toEqual([["p2"]]);
    expect(events.length).toBe(1);
    state.hang = undefined;
    clock.t += PR_TTL_MS;
    const before = calls.length;
    await prs.refresh();
    expect(calls.slice(before).filter((call) => call.argv[0] === "git").map((call) => call.argv[1])).toEqual(["branch", "config"]);
  });

  test("a fork's checkout finds its PR to the upstream repo, and its own, whatever the case its remotes use", async () => {
    const { run } = fakeRun({
      folders: { "/r/fork": ["/r/fork/.git", "/r/fork", "fix/y", "remote.origin.url https://github.com/Me/Shop\nremote.upstream.url https://github.com/acme/shop\n"] },
      viewer: [inRepo("acme/shop", 8, "fix/y"), inRepo("me/shop", 2, "fix/y"), inRepo("acme/api", 3, "fix/y"), inRepo("me/shop", 8, "other")],
    });
    const { prs } = registry(run);
    const panes = [pane("p1", "/r/fork")];
    prs.list("main", panes);
    await prs.refresh();
    expect(prs.list("main", panes).map((pr) => [pr.repo, pr.number, pr.paneIds])).toEqual([["acme/shop", 8, ["p1"]], ["me/shop", 2, ["p1"]], ["acme/api", 3, []], ["me/shop", 8, []]]);
    // Two repos, one number: the repo says which.
    expect(prs.locate("/r/fork", 8, "Me/Shop")).toMatchObject({ pr: { repo: "me/shop", branch: "other" } });
    expect(prs.locate("/r/fork", 8, "acme/shop")).toMatchObject({ pr: { repo: "acme/shop", branch: "fix/y" } });
    expect(prs.locate("/r/fork", 3)).toBeUndefined();
    expect(prs.locate("/r/fork", 2, "acme/shop")).toBeUndefined();
  });

  test("tells the pages only when what they read changed", async () => {
    const moving = structuredClone(folders);
    const { run } = fakeRun({ folders: moving, viewer: [inRepo("acme/shop", 1, "feat/a")] });
    const { prs, clock, events } = registry(run);
    const panes = [pane("p1", "/r/shop"), pane("p2", "/h/worktrees/shop/a")];
    prs.list("main", panes);
    await prs.refresh();
    expect(events.length).toBe(1);
    // A branch no PR is opened from moves: nothing a page reads changed.
    moving["/r/shop"]![2] = "develop-2";
    clock.t += PR_TTL_MS;
    await prs.refresh();
    expect(events.length).toBe(1);
    // The PR's branch leaves its pane: that is news.
    moving["/h/worktrees/shop/a"]![2] = "feat/other";
    clock.t += PR_TTL_MS;
    await prs.refresh();
    expect(events.length).toBe(2);
  });

  test("keeps the last list on disk, so a restart shows it before GitHub answers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nenu-prs-"));
    dirs.push(dir);
    const file = join(dir, "pull-requests.json");
    const clock = { t: 1_000_000 };
    const first = registry(fakeRun({ folders, viewer: [ghRow(1, "feat/a")] }).run, clock, undefined, file);
    first.prs.list("main", [pane("p1", "/r/shop")]);
    await first.prs.refresh();
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ at: 1_000_000, prs: [{ number: 1 }] });
    const restarted = registry(fakeRun({ folders, viewer: "hang" }).run, clock, { gh: 50, git: 50 }, file);
    expect(restarted.prs.list("main", [pane("p2", "/h/worktrees/shop/a")]).map((pr) => [pr.number, pr.paneIds])).toEqual([[1, []]]);
    await restarted.prs.refresh();
    // Matched to its pane once the folders are read, though GitHub never answered.
    expect(restarted.prs.list("main", [pane("p2", "/h/worktrees/shop/a")]).map((pr) => [pr.number, pr.paneIds])).toEqual([[1, ["p2"]]]);
    // An unchanged list is written again only once its date is an hour old.
    const writes = () => JSON.parse(readFileSync(file, "utf8")).at as number;
    clock.t += PR_TTL_MS;
    await first.prs.refresh();
    expect(writes()).toBe(1_000_000);
    clock.t += 60 * 60_000;
    await first.prs.refresh();
    expect(writes()).toBe(clock.t);
    clock.t = 1_000_000;
    // A day later those PRs may long be merged: a restart shows none until GitHub answers.
    expect(registry(fakeRun({ folders, viewer: [] }).run, { t: writes() + 24 * 60 * 60_000 }, undefined, file).prs.list("main", [])).toEqual([]);
    writeFileSync(file, JSON.stringify({ at: 1_000_000, prs: [{ number: 2 }] }));
    expect(registry(fakeRun({ folders, viewer: [] }).run, clock, undefined, file).prs.list("main", [])).toEqual([]);
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
