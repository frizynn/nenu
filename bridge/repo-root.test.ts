import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { projectOf } from "./pane-project.ts";
import { diskFs, repoRoot } from "./repo-root.ts";
import { repoOf } from "./usage/repos.ts";

// Real folders laid out as git leaves them, so the walk is tested against the disk it reads.
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "repo-root-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(path: string, text: string) {
  mkdirSync(join(dir, path, ".."), { recursive: true });
  writeFileSync(join(dir, path), text);
}

/** A worktree at `at` of the repo whose shared git dir is `common`. */
function worktree(at: string, common: string, name: string) {
  write(`${at}/.git`, `gitdir: ${join(dir, common, "worktrees", name)}\n`);
  write(`${common}/worktrees/${name}/commondir`, "../..\n");
}

describe("repoRoot", () => {
  it("names a bare repo kept as .bare beside its worktrees by the folder holding it, in the sidebar and Usage alike", () => {
    write("proj/.bare/HEAD", "ref: refs/heads/main\n");
    write("proj/.git", "gitdir: ./.bare\n");
    worktree("proj/main", "proj/.bare", "main");
    expect(repoRoot(join(dir, "proj/main"), "/nowhere")).toMatchObject({ root: join(dir, "proj"), name: "proj" });
    expect(projectOf(join(dir, "proj/main"), "/nowhere")).toBe("proj");
    expect(repoOf(join(dir, "proj/main"), "/nowhere").label).toBe("proj");
  });

  it("names a plain bare repo without its .git, in the sidebar and Usage alike", () => {
    write("shop.git/HEAD", "ref: refs/heads/main\n");
    worktree("pool/feature", "shop.git", "feature");
    expect(projectOf(join(dir, "pool/feature"), "/nowhere")).toBe("shop");
    expect(repoOf(join(dir, "pool/feature"), "/nowhere").label).toBe("shop");
    expect(repoOf(join(dir, "pool/feature"), "/nowhere").key).toMatch(/^shop~/);
  });

  it("names a bare repo kept under another hidden name by the repo itself, never by the folder holding it", () => {
    write(".cfg/HEAD", "ref: refs/heads/main\n");
    worktree("dots", ".cfg", "dots");
    expect(repoRoot(join(dir, "dots"), "/nowhere")?.root).toBe(join(dir, ".cfg"));
  });

  it("reads only small regular files: a folder, a FIFO or a huge file where a file should be reads as nothing", () => {
    writeFileSync(join(dir, "huge"), "x".repeat(65 * 1024));
    expect(diskFs.read(join(dir, "huge"))).toBeUndefined();
    mkdirSync(join(dir, "config"));
    expect(diskFs.read(join(dir, "config"))).toBeUndefined();
    Bun.spawnSync(["mkfifo", join(dir, "fifo")]);
    expect(diskFs.read(join(dir, "fifo"))).toBeUndefined();
  });
});
