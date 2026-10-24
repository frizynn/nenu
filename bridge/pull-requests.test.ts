import { describe, expect, test } from "bun:test";

import { githubRepo, parsePullRequests, parseRepo, parseSearch, PR_TTL_MS, PullRequestRegistry, remoteRepo, searchArgv, summarizeChecks, type CommandRun } from "./pull-requests.ts";
import type { AgentView, LiveEvent } from "./types.ts";

function pane(paneId: string, cwd: string): AgentView {
  return { paneId, workspaceId: "w1", workspaceLabel: "W", workspaceNumber: 1, tabId: "t1", agent: "claude", status: "idle", cwd, focused: false };
}

const ghRow = (number: number, branch: string, extra: Record<string, unknown> = {}) => ({
  number, title: `PR ${number}`, url: `https://github.com/acme/shop/pull/${number}`, headRefName: branch, baseRefName: "main",
  isDraft: false, reviewDecision: "", statusCheckRollup: [], additions: 10, deletions: 2, updatedAt: "2026-10-10T10:00:00Z", ...extra,
});

/** The PR rows GitHub's GraphQL search returns for `ghRow`s, with the checks under the last commit. */
const searchNode = (row: ReturnType<typeof ghRow>) => {
  const { statusCheckRollup, ...rest } = row;
  return { ...rest, commits: { nodes: [{ commit: { statusCheckRollup: (statusCheckRollup as unknown[]).length ? { contexts: { nodes: statusCheckRollup } } : null } }] } };
};

/**
 * A fake git + gh. Folders map to (common dir, toplevel, branch, and the remotes `git config` prints);
 * `gh pr list` answers from `prs` by toplevel, and the GraphQL search from `prs` by `owner/name` (a
 * "hang" there hangs the request), or with `graphql`. Every call is recorded.
 */
function fakeRun(state: {
  folders: Record<string, [string, string, string, string?]>;
  prs: Record<string, unknown[] | { code: number; stderr: string } | "hang" | "throw">;
  graphql?: { code: number; stdout: string; stderr: string } | "hang" | "throw";
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
      if (state.graphql === "hang") return new Promise(() => {});
      if (state.graphql === "throw") throw new Error("spawn gh ENOENT");
      if (state.graphql) return state.graphql;
      const data: Record<string, unknown> = {};
      if (argv.some((arg) => state.prs[/ repo:(\S+) /.exec(arg)?.[1] ?? ""] === "hang")) return new Promise(() => {});
      for (const arg of argv) {
        const query = /^q(\d+)=author:@me repo:(\S+) state:open type:pr$/.exec(arg);
        const rows = query && state.prs[query[2]!];
        // GitHub answers a repo it does not know with no rows, never an error.
        if (query) data[`r${query[1]}`] = { nodes: Array.isArray(rows) ? rows.map((row) => searchNode(row as ReturnType<typeof ghRow>)) : [] };
      }
      return { code: 0, stdout: JSON.stringify({ data }), stderr: "" };
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

  test("reads the search answer per repo, as gh pr list would have printed it", () => {
    const argv = searchArgv(["acme/shop", "acme/api"]);
    expect(argv.slice(0, 6)).toEqual(["gh", "api", "--hostname", "github.com", "graphql", "-f"]);
    expect(argv.slice(7)).toEqual(["-f", "q0=author:@me repo:acme/shop state:open type:pr", "-f", "q1=author:@me repo:acme/api state:open type:pr"]);
    expect(argv[6]).toContain("r1:search(query:$q1,type:ISSUE_ADVANCED,first:50)");
    const row = ghRow(7, "feat/x", { reviewDecision: "APPROVED", statusCheckRollup: [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "StatusContext", state: "PENDING" }] });
    const answers = parseSearch(JSON.stringify({
      data: { r0: { nodes: [searchNode(row), {}] }, r1: null },
      errors: [{ path: ["r1"], message: "The listed users and repositories cannot be searched" }],
    }), 2);
    expect(answers).toEqual([parsePullRequests(JSON.stringify([row])), "The listed users and repositories cannot be searched"]);
    expect(answers[0]).toMatchObject([{ number: 7, review: "approved", checks: { passed: 1, failed: 0, pending: 1 } }]);
    expect(parseSearch(JSON.stringify({ data: { r0: { nodes: [searchNode(ghRow(8, "b"))] } } }), 1)[0]).toMatchObject([{ number: 8 }]);
    expect(parseSearch(JSON.stringify({ errors: [{ message: "Bad credentials" }] }), 2)).toEqual(["Bad credentials", "Bad credentials"]);
    // A REST-style error body says nothing per repo; the caller keeps gh's own reason.
    expect(parseSearch(JSON.stringify({ message: "Bad credentials" }), 1)).toEqual([undefined]);
    expect(() => parseSearch("", 1)).toThrow();
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

  test("asks GitHub once for every repo a remote names, and runs gh pr list only where gh alone can name it", async () => {
    const remote = (name: string) => `remote.origin.url https://github.com/${name}.git\n`;
    const { run, calls } = fakeRun({
      folders: {
        "/r/shop": ["/r/shop/.git", "/r/shop", "develop", remote("acme/shop")],
        "/h/worktrees/shop/a": ["/r/shop/.git", "/h/worktrees/shop/a", "feat/a", remote("acme/shop")],
        "/r/shop-clone": ["/r/shop-clone/.git", "/r/shop-clone", "main", remote("acme/shop")],
        "/r/api": ["/r/api/.git", "/r/api", "main", remote("acme/api")],
        "/r/local": ["/r/local/.git", "/r/local", "main"],
        "/r/home": ["/r/home/.git", "/r/home", "main", "remote.origin.url /r/upstream-home\n"],
      },
      prs: { "acme/shop": [ghRow(1, "feat/a"), ghRow(2, "feat/z")], "acme/api": [], "/r/local": [ghRow(3, "main", { url: "https://github.com/acme/local/pull/3" })] },
    });
    const { prs, events, logs } = registry(run);
    const panes = [pane("p1", "/r/shop"), pane("p2", "/h/worktrees/shop/a"), pane("p3", "/r/shop-clone"), pane("p4", "/r/api"), pane("p5", "/r/local"), pane("p6", "/r/home")];
    prs.list("main", panes);
    await prs.refresh();
    const gh = calls.filter((call) => call.argv[0] === "gh");
    expect(gh.map((call) => call.argv[1])).toEqual(["api", "pr"]);
    // The two clones of acme/shop share one search.
    expect(gh[0]!.argv.filter((arg) => /^q\d/.test(arg))).toEqual(["q0=author:@me repo:acme/shop state:open type:pr", "q1=author:@me repo:acme/api state:open type:pr"]);
    expect(gh[1]!.cwd).toBe("/r/local");
    expect(prs.list("main", panes).map((pr) => [pr.repo, pr.number, pr.paneIds])).toEqual([
      ["acme/shop", 1, ["p2"]], ["acme/shop", 2, []], ["acme/shop", 1, []], ["acme/shop", 2, []], ["acme/local", 3, ["p5"]],
    ]);
    expect(events).toEqual([{ session: "main", topic: "snapshot" }]);
    // A repo whose only remote is on this machine asks nobody: gh would fail there.
    expect(logs).toEqual(["home: none of the git remotes point to GitHub"]);
  });

  test("asks GitHub four repos per request, so a slow repo fails only its own batch", async () => {
    const folders: Record<string, [string, string, string, string]> = {};
    for (let i = 0; i < 6; i++) folders[`/r/${i}`] = [`/r/${i}/.git`, `/r/${i}`, "main", `remote.origin.url https://github.com/acme/r${i}\n`];
    const state: Parameters<typeof fakeRun>[0] = { folders, prs: { "acme/r0": [ghRow(1, "a")], "acme/r5": [ghRow(2, "b")] } };
    const { run, calls } = fakeRun(state);
    const { prs, logs } = registry(run, undefined, { gh: 50, git: 50 });
    const panes = Object.keys(folders).map((cwd, i) => pane(`p${i}`, cwd));
    prs.list("main", panes);
    await prs.refresh();
    const api = calls.filter((call) => call.argv[1] === "api");
    expect(api.map((call) => call.argv.filter((arg) => /^q\d/.test(arg)).length)).toEqual([4, 2]);
    expect(prs.list("main", panes).map((pr) => pr.number)).toEqual([1, 2]);
    // r4 hangs its batch: r5 beside it keeps its list, r0 in the other batch takes its new one.
    state.prs = { "acme/r0": [ghRow(3, "c")], "acme/r4": "hang", "acme/r5": [] };
    await prs.refresh();
    expect(prs.list("main", panes).map((pr) => pr.number)).toEqual([3, 2]);
    expect(logs).toEqual(["4: timed out", "5: timed out"]);
  });

  test("a search that hangs or throws times out or fails like gh pr list did, keeping the last list", async () => {
    const state: Parameters<typeof fakeRun>[0] = {
      folders: { "/r/shop": ["/r/shop/.git", "/r/shop", "feat/a", "remote.origin.url https://github.com/acme/shop\n"] },
      prs: { "acme/shop": [ghRow(1, "feat/a")] },
    };
    const { run } = fakeRun(state);
    const { prs, logs } = registry(run, undefined, { gh: 50, git: 50 });
    prs.list("main", [pane("p1", "/r/shop")]);
    await prs.refresh();
    state.graphql = "hang";
    const started = Date.now();
    await prs.refresh();
    expect(Date.now() - started).toBeLessThan(1_000);
    state.graphql = "throw";
    await prs.refresh();
    // A 401 answers with a REST-style body: gh's stderr is the reason.
    state.graphql = { code: 1, stdout: JSON.stringify({ message: "Bad credentials" }), stderr: "gh: Bad credentials (HTTP 401)" };
    await prs.refresh();
    expect(logs).toEqual(["shop: timed out", "shop: spawn gh ENOENT", "shop: gh: Bad credentials (HTTP 401)"]);
    expect(prs.list("main", [pane("p1", "/r/shop")]).map((pr) => pr.number)).toEqual([1]);
  });

  test("a repo GitHub could not answer keeps its last list, and the others take theirs", async () => {
    const remote = (name: string) => `remote.origin.url https://github.com/${name}.git\n`;
    const state: Parameters<typeof fakeRun>[0] = {
      folders: { "/r/shop": ["/r/shop/.git", "/r/shop", "feat/a", remote("acme/shop")], "/r/api": ["/r/api/.git", "/r/api", "main", remote("acme/api")] },
      prs: { "acme/shop": [ghRow(1, "feat/a")], "acme/api": [ghRow(5, "main")] },
    };
    const { run } = fakeRun(state);
    const { prs, logs } = registry(run);
    const panes = [pane("p1", "/r/shop"), pane("p2", "/r/api")];
    prs.list("main", panes);
    await prs.refresh();
    // A partial answer: gh exits 1 and still prints what GitHub answered.
    state.graphql = {
      code: 1,
      stdout: JSON.stringify({ data: { r0: null, r1: { nodes: [searchNode(ghRow(5, "main")), searchNode(ghRow(6, "fix"))] } }, errors: [{ path: ["r0"], message: "Something went wrong" }] }),
      stderr: "gh: Something went wrong",
    };
    await prs.refresh();
    expect(prs.list("main", panes).map((pr) => pr.number)).toEqual([1, 5, 6]);
    expect(logs).toEqual(["shop: Something went wrong"]);
    // No answer at all: every repo keeps its list, each logged once.
    state.graphql = { code: 4, stdout: "", stderr: "gh auth login required\nmore" };
    await prs.refresh();
    await prs.refresh();
    expect(prs.list("main", panes).map((pr) => pr.number)).toEqual([1, 5, 6]);
    expect(logs).toEqual(["shop: Something went wrong", "shop: gh auth login required", "api: gh auth login required"]);
  });

  test("finds a PR by number in the repo a folder sits in, with the branch that folder is on", async () => {
    const { run, calls } = fakeRun({ folders, prs: { "/r/shop": [ghRow(1, "feat/a"), ghRow(2, "feat/z")], "/r/api": [ghRow(1, "fix/api")] } });
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
    const { run, calls } = fakeRun({ folders, prs: { "/r/shop": [ghRow(1, "feat/a"), ghRow(2, "feat/z")] } });
    const { prs } = registry(run);
    expect(prs.onBranch("/h/worktrees/shop/a")).toBeUndefined();
    prs.list("main", [pane("p1", "/r/shop"), pane("p2", "/h/worktrees/shop/a")]);
    await prs.refresh();
    const before = calls.length;
    expect(prs.onBranch("/h/worktrees/shop/a")).toMatchObject({ number: 1, branch: "feat/a", base: "main" });
    // On `develop`, which no PR is opened from.
    expect(prs.onBranch("/r/shop")).toBeUndefined();
    expect(prs.onBranch("/tmp")).toBeUndefined();
    expect(calls.length).toBe(before);
  });
});
