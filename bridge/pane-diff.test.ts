import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { paneDiff, projectSessionDiff, sessionDiff, type DiffTarget, type GitRun } from "./pane-diff.ts";

// Real git in a temporary repo: the parser's job is to agree with git, so git writes the fixtures.
const cleanEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, env: cleanEnv });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}
const lines = (count: number, label = "line") => Array.from({ length: count }, (_, i) => `${label} ${i + 1}`).join("\n") + "\n";

let repo = "";
const target = (extra: Partial<DiffTarget> = {}): DiffTarget => ({ number: 7, head: "feat/x", base: "main", checkedOut: "feat/x", ...extra });

beforeAll(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "nenu-diff-")));
  git(repo, "init", "-q", "-b", "main");
  mkdirSync(join(repo, "src"));
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "src/a.ts"), lines(10));
  writeFileSync(join(repo, "src/b.ts"), lines(4, "b"));
  writeFileSync(join(repo, "docs/old.md"), lines(20, "doc"));
  writeFileSync(join(repo, "gone.txt"), lines(2, "gone"));
  writeFileSync(join(repo, "logo.bin"), new Uint8Array([0, 1, 2, 3, 0, 255]));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "base");
  git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");

  // A pushed branch the pane is not on: one changed line in b.ts.
  git(repo, "checkout", "-q", "-b", "feat/y");
  writeFileSync(join(repo, "src/b.ts"), lines(4, "b").replace("b 2", "b two"));
  git(repo, "commit", "-q", "-am", "y");
  git(repo, "update-ref", "refs/remotes/origin/feat/y", "HEAD");

  git(repo, "checkout", "-q", "main");
  git(repo, "checkout", "-q", "-b", "feat/x");
  writeFileSync(join(repo, "src/a.ts"), lines(10).replace("line 3\n", "line three\n") + "line 11\n");
  writeFileSync(join(repo, "src/new.ts"), lines(3, "new"));
  git(repo, "rm", "-q", "gone.txt");
  git(repo, "mv", "docs/old.md", "docs/new.md");
  writeFileSync(join(repo, "logo.bin"), new Uint8Array([0, 1, 2, 3, 0, 254, 9]));
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "x");
  // Uncommitted, and an untracked file that a diff of tracked files leaves out.
  writeFileSync(join(repo, "src/b.ts"), lines(4, "b") + "b 5\n");
  writeFileSync(join(repo, "scratch.txt"), "not added\n");
});

afterAll(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

describe("the pull request checked out in the pane", () => {
  test("lists every changed file against the merge base, uncommitted edits included", async () => {
    const diff = await paneDiff(repo, target());
    if (!diff.ok) throw new Error(diff.message);
    expect(diff.source).toBe("worktree");
    expect({ pr: diff.pr, base: diff.base, head: diff.head }).toEqual({ pr: 7, base: "main", head: "feat/x" });
    expect(diff.files.map((file) => [file.path, file.status, file.additions, file.deletions])).toEqual([
      ["docs/new.md", "renamed", 0, 0],
      ["gone.txt", "deleted", 0, 2],
      ["logo.bin", "modified", 0, 0],
      ["src/a.ts", "modified", 2, 1],
      ["src/b.ts", "modified", 1, 0],
      ["src/new.ts", "added", 3, 0],
    ]);
    expect(diff.files[0]!.from).toBe("docs/old.md");
    expect(diff.files[2]).toMatchObject({ binary: true, omitted: "binary" });
    expect(diff.files[2]!.hunks).toBeUndefined();
    expect(diff.totals).toEqual({ files: 6, additions: 6, deletions: 3 });
    expect(diff.truncated).toBeUndefined();
  });

  test("keeps each hunk's start lines and its lines with their markers", async () => {
    const diff = await paneDiff(repo, target());
    if (!diff.ok) throw new Error(diff.message);
    const a = diff.files.find((file) => file.path === "src/a.ts")!;
    // Line 3 and the new line 11 sit more than six lines apart: git draws two hunks.
    expect(a.hunks).toHaveLength(2);
    const [first, second] = a.hunks!;
    expect([first!.oldStart, first!.newStart]).toEqual([1, 1]);
    expect(first!.header).toBe("@@ -1,6 +1,6 @@");
    expect(first!.lines).toEqual([" line 1", " line 2", "-line 3", "+line three", " line 4", " line 5", " line 6"]);
    expect([second!.oldStart, second!.newStart]).toEqual([8, 8]);
    expect(second!.lines).toEqual([" line 8", " line 9", " line 10", "+line 11"]);
    expect(diff.files.find((file) => file.path === "src/new.ts")!.hunks![0]!.lines).toEqual(["+new 1", "+new 2", "+new 3"]);
  });

  test("a folder inside the repo sees only the changes under it", async () => {
    const diff = await paneDiff(join(repo, "src"), target());
    if (!diff.ok) throw new Error(diff.message);
    expect(diff.files.map((file) => file.path)).toEqual(["a.ts", "b.ts", "new.ts"]);
    expect(diff.totals).toEqual({ files: 3, additions: 6, deletions: 1 });
  });

  test("reads without writing: the index is left as it was", async () => {
    // A touched file is stat-dirty: a refreshing command would rewrite the index.
    utimesSync(join(repo, "src/a.ts"), new Date(), new Date(Date.now() + 5_000));
    const before = statSync(join(repo, ".git/index"));
    await paneDiff(repo, target());
    const after = statSync(join(repo, ".git/index"));
    expect([after.mtimeMs, after.size, after.ino]).toEqual([before.mtimeMs, before.size, before.ino]);
  });

  test("a GIT_DIR in the bridge's environment does not redirect the read", async () => {
    const saved = process.env.GIT_DIR;
    process.env.GIT_DIR = join(tmpdir(), "nowhere");
    try {
      const diff = await paneDiff(repo, target());
      expect(diff.ok).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = saved;
    }
  });
});

describe("a pull request on another branch of the same repo", () => {
  test("diffs the pushed branch, without the pane's own edits", async () => {
    const diff = await paneDiff(repo, target({ head: "feat/y" }));
    if (!diff.ok) throw new Error(diff.message);
    expect(diff.source).toBe("branch");
    expect(diff.files.map((file) => [file.path, file.additions, file.deletions])).toEqual([["src/b.ts", 1, 1]]);
  });

  test("a branch this repo has never fetched is said so, not guessed at", async () => {
    const diff = await paneDiff(repo, target({ head: "feat/missing" }));
    expect(diff).toMatchObject({ ok: false, reason: "head-missing" });
  });
});

describe("limits", () => {
  test("lists at most `files` files and says how many there are", async () => {
    const diff = await paneDiff(repo, target(), { limits: { files: 2 } });
    if (!diff.ok) throw new Error(diff.message);
    expect(diff.files.map((file) => file.path)).toEqual(["docs/new.md", "gone.txt"]);
    expect(diff.totals).toEqual({ files: 6, additions: 6, deletions: 3 });
    expect(diff.truncated).toEqual({ files: true });
  });

  test("a file longer than `fileLines` keeps its counts and loses its lines", async () => {
    const diff = await paneDiff(repo, target(), { limits: { fileLines: 4 } });
    if (!diff.ok) throw new Error(diff.message);
    const a = diff.files.find((file) => file.path === "src/a.ts")!;
    expect(a).toMatchObject({ additions: 2, deletions: 1, omitted: "large" });
    expect(a.hunks).toBeUndefined();
    expect(diff.files.find((file) => file.path === "src/new.ts")!.hunks).toHaveLength(1);
  });

  test("past `bytes` the read stops, and the files it did not reach keep only their counts", async () => {
    const diff = await paneDiff(repo, target(), { limits: { bytes: 700 } });
    if (!diff.ok) throw new Error(diff.message);
    expect(diff.truncated).toEqual({ bytes: true });
    expect(diff.files).toHaveLength(6);
    expect(diff.files.at(-1)).toMatchObject({ path: "src/new.ts", additions: 3, omitted: "budget" });
    expect(diff.files.at(-1)!.hunks).toBeUndefined();
    expect(diff.files[0]!.omitted).toBeUndefined();
  });
});

describe("refusals", () => {
  const never: GitRun = async () => {
    throw new Error("git must not run");
  };

  test("no pull request read from GitHub for this repo", async () => {
    expect(await paneDiff(repo, undefined, { run: never })).toMatchObject({ ok: false, reason: "no-pr" });
  });

  test("a folder that is not absolute, or is gone", async () => {
    expect(await paneDiff("relative/dir", target(), { run: never })).toMatchObject({ ok: false, reason: "no-folder" });
    expect(await paneDiff(undefined, target(), { run: never })).toMatchObject({ ok: false, reason: "no-folder" });
    expect(await paneDiff(join(repo, "missing"), target(), { run: never })).toMatchObject({ ok: false, reason: "no-folder" });
  });

  test("a branch name git could read as an option or a range never reaches git", async () => {
    for (const base of ["-x", "--output=/tmp/x", "a..b", "main\n", "", "a b"]) {
      expect(await paneDiff(repo, target({ base }), { run: never })).toMatchObject({ ok: false, reason: "no-base" });
    }
    expect(await paneDiff(repo, target({ base: undefined }), { run: never })).toMatchObject({ ok: false, reason: "no-base" });
    expect(await paneDiff(repo, target({ head: "-p" }), { run: never })).toMatchObject({ ok: false, reason: "head-missing" });
  });

  test("a base branch this repo does not have", async () => {
    expect(await paneDiff(repo, target({ base: "release" }))).toMatchObject({ ok: false, reason: "no-base" });
  });

  test("git runs with fixed arguments, from the pane's real folder", async () => {
    const calls: Array<{ argv: string[]; cwd: string }> = [];
    const spy: GitRun = async (argv, opts) => {
      calls.push({ argv, cwd: opts.cwd });
      return { code: 1, stdout: "", truncated: false };
    };
    await paneDiff(repo, target(), { run: spy });
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.cwd).toBe(repo);
      expect(call.argv[0]).toBe("git");
    }
  });
});

describe("a session's changes, with or without a pull request", () => {
  test("Branch: the working tree against where the branch left the default branch, untracked files named", async () => {
    const diff = await sessionDiff(repo, "branch");
    if (!diff.ok) throw new Error(diff.message);
    expect(diff).toMatchObject({ base: "main", head: "feat/x", source: "worktree" });
    expect(diff.pr).toBeUndefined();
    expect(diff.files.map((file) => file.path).sort()).toEqual(["docs/new.md", "gone.txt", "logo.bin", "scratch.txt", "src/a.ts", "src/b.ts", "src/new.ts"]);
    expect(diff.files.find((file) => file.path === "scratch.txt")).toEqual({ path: "scratch.txt", status: "added", additions: 0, deletions: 0, omitted: "untracked" });
    expect(diff.totals.files).toBe(7);
  });

  test("Uncommitted: the working tree against the last commit", async () => {
    const diff = await sessionDiff(repo, "uncommitted");
    if (!diff.ok) throw new Error(diff.message);
    expect(diff).toMatchObject({ head: "feat/x", source: "uncommitted" });
    expect(diff.files.map((file) => file.path)).toEqual(["src/b.ts", "scratch.txt"]);
    expect(diff.files[0]).toMatchObject({ status: "modified", additions: 1, deletions: 0 });
    expect(diff.totals).toEqual({ files: 2, additions: 1, deletions: 0 });
  });

  test("the base of the branch's pull request wins, and origin's default comes before main", async () => {
    const fromPr = await sessionDiff(repo, "branch", { base: "feat/y" });
    expect(fromPr).toMatchObject({ ok: true, base: "feat/y" });
    git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/feat/y");
    try {
      expect(await sessionDiff(repo, "branch")).toMatchObject({ ok: true, base: "feat/y" });
    } finally {
      git(repo, "symbolic-ref", "--delete", "refs/remotes/origin/HEAD");
    }
    // A base GitHub reported that git could take for an option is dropped, not escaped.
    expect(await sessionDiff(repo, "branch", { base: "--output=/tmp/x" })).toMatchObject({ ok: true, base: "main" });
  });

  test("a folder inside the repo sees only the changes under it", async () => {
    const diff = await sessionDiff(join(repo, "src"), "branch");
    if (!diff.ok) throw new Error(diff.message);
    expect(diff.files.map((file) => file.path).sort()).toEqual(["a.ts", "b.ts", "new.ts"]);
  });

  test("a folder outside any repository, or with no branch to compare against", async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "nenu-plain-")));
    const lone = realpathSync(mkdtempSync(join(tmpdir(), "nenu-lone-")));
    try {
      expect(await sessionDiff(plain, "branch")).toMatchObject({ ok: false, reason: "no-repo" });
      git(lone, "init", "-q", "-b", "trunk");
      writeFileSync(join(lone, "a.txt"), "a\n");
      git(lone, "add", "-A");
      git(lone, "commit", "-q", "-m", "a");
      expect(await sessionDiff(lone, "branch")).toMatchObject({ ok: false, reason: "no-default" });
      expect(await sessionDiff(lone, "uncommitted")).toMatchObject({ ok: true, files: [] });
    } finally {
      rmSync(plain, { recursive: true, force: true });
      rmSync(lone, { recursive: true, force: true });
    }
  });

  test("a folder in no repository reads its project's repository, and says which", async () => {
    const coordinator = realpathSync(mkdtempSync(join(tmpdir(), "nenu-coordinator-")));
    const missing = join(coordinator, "gone");
    const bases: string[] = [];
    const base = (folder: string) => {
      bases.push(folder);
      return undefined;
    };
    try {
      const diff = await projectSessionDiff(coordinator, "branch", [missing, coordinator, repo], { base });
      if (!diff.ok) throw new Error(diff.message);
      expect(diff.repo).toBe(repo);
      expect(diff.base).toBe("main");
      expect(diff.files.map((file) => file.path)).toContain("src/a.ts");
      // Each folder's PR base is asked of that folder, the pane's own first.
      expect(bases).toEqual([coordinator, missing, coordinator, repo]);
      // A worktree is read as itself: its project's repository is never asked.
      expect(await projectSessionDiff(repo, "branch", [coordinator], { base: () => undefined })).not.toHaveProperty("repo");
    } finally {
      rmSync(coordinator, { recursive: true, force: true });
    }
  });

  test("a folder in no repository, with none to read instead, says where it is", async () => {
    const plain = realpathSync(mkdtempSync(join(tmpdir(), "nenu-plain-")));
    try {
      const alone = await projectSessionDiff(plain, "branch", [], { base: () => undefined });
      expect(alone).toMatchObject({ ok: false, reason: "no-repo" });
      expect(alone.ok ? "" : alone.message).toBe(`This pane works in ${plain}, which is not in a git repository, so there are no changes to read.`);
      const named = await projectSessionDiff(plain, "branch", [join(plain, "gone")], { base: () => undefined });
      expect(named.ok ? "" : named.message).toContain("no repository its project names could be read");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });

  test("reads without writing, with fixed arguments from the pane's real folder", async () => {
    const index = statSync(join(repo, ".git/index")).mtimeMs;
    const calls: Array<{ argv: string[]; cwd: string }> = [];
    const spy: GitRun = async (argv, opts) => {
      calls.push({ argv, cwd: opts.cwd });
      return { code: 1, stdout: "", truncated: false };
    };
    await sessionDiff(repo, "branch", { run: spy });
    await sessionDiff(repo, "uncommitted");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatchObject({ cwd: repo, argv: expect.arrayContaining(["git"]) });
    expect(statSync(join(repo, ".git/index")).mtimeMs).toBe(index);
    expect(await sessionDiff(undefined, "branch", { run: spy })).toMatchObject({ ok: false, reason: "no-folder" });
  });
});

describe("a private file in the diff", () => {
  test("is listed as changed with its lines withheld, by its name or the name it was renamed from", async () => {
    const secrets = realpathSync(mkdtempSync(join(tmpdir(), "nenu-diff-private-")));
    try {
      git(secrets, "init", "-q", "-b", "main");
      mkdirSync(join(secrets, "src"));
      mkdirSync(join(secrets, "config"));
      writeFileSync(join(secrets, ".env"), "TOKEN=old-token\n");
      writeFileSync(join(secrets, "config/.mcp.json"), '{"env":{"API_KEY":"old-key"}}\n');
      writeFileSync(join(secrets, ".pgpass"), "db:5432:app:admin:old-pass\n" + lines(10, "replica"));
      writeFileSync(join(secrets, "src/app.ts"), lines(3));
      git(secrets, "add", "-A");
      git(secrets, "commit", "-q", "-m", "base");
      git(secrets, "update-ref", "refs/remotes/origin/main", "HEAD");
      git(secrets, "checkout", "-q", "-b", "feat/s");
      writeFileSync(join(secrets, ".env"), "TOKEN=new-token\n");
      git(secrets, "mv", ".pgpass", "pgpass.txt");
      writeFileSync(join(secrets, "pgpass.txt"), "db:5432:app:admin:new-pass\n" + lines(10, "replica"));
      writeFileSync(join(secrets, "src/app.ts"), lines(3).replace("line 2", "line two"));
      git(secrets, "add", "-A");
      git(secrets, "commit", "-q", "-m", "s");
      writeFileSync(join(secrets, "config/.mcp.json"), '{"env":{"API_KEY":"new-key"}}\n');

      for (const diff of [await paneDiff(secrets, { number: 9, head: "feat/s", base: "main", checkedOut: "feat/s" }), await sessionDiff(secrets, "branch")]) {
        if (!diff.ok) throw new Error(diff.message);
        expect(JSON.stringify(diff)).not.toMatch(/(?:old|new)-(?:token|key|pass)/);
        const byPath = Object.fromEntries(diff.files.map((file) => [file.path, file]));
        expect(byPath[".env"]).toEqual({ path: ".env", status: "modified", additions: 1, deletions: 1, omitted: "private" });
        expect(byPath["config/.mcp.json"]).toEqual({ path: "config/.mcp.json", status: "modified", additions: 1, deletions: 1, omitted: "private" });
        expect(byPath["pgpass.txt"]).toEqual({ path: "pgpass.txt", from: ".pgpass", status: "renamed", additions: 1, deletions: 1, omitted: "private" });
        expect(byPath["src/app.ts"]?.hunks?.[0]?.lines).toContain("+line two");
      }
    } finally {
      rmSync(secrets, { recursive: true, force: true });
    }
  });
});
