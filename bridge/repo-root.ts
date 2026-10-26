import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** What the walk reads: whether a path is a folder or a file, and a file's text. Tests fake it. */
export interface RepoFs {
  kind(path: string): "dir" | "file" | undefined;
  read(path: string): string | undefined;
}

export const diskFs: RepoFs = {
  kind(path) {
    try {
      const stat = statSync(path);
      return stat.isDirectory() ? "dir" : stat.isFile() ? "file" : undefined;
    } catch {
      return undefined;
    }
  },
  read(path) {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
};

/**
 * The repository `cwd` sits in, read from the filesystem without running git: walk up to the first
 * `.git`. A directory means a main checkout; a file (`gitdir: …`) means a worktree, whose git dir names
 * the one every worktree of the repo shares in its `commondir` file, bare repos included. `root` is the
 * checkout holding that shared dir (the bare repo itself when there is none). The walk stops below the
 * home folder, whose `.git` is usually a dotfiles repo rather than the project. Undefined outside a repo.
 */
export function repoRoot(cwd: string, home = homedir(), fs: RepoFs = diskFs): { root: string; commonDir: string } | undefined {
  for (let dir = cwd, i = 0; i < 64 && dir !== home; i++) {
    const git = join(dir, ".git");
    const kind = fs.kind(git);
    if (kind === "dir") return { root: dir, commonDir: git };
    if (kind === "file") {
      const target = /^gitdir:\s*(.+)$/m.exec(fs.read(git) ?? "")?.[1]?.trim();
      if (!target) return { root: dir, commonDir: git };
      const gitDir = isAbsolute(target) ? target : resolve(dir, target);
      // Without `commondir`, a git dir under `<repo>/.git/worktrees/` still names its repo by its path.
      const common = fs.read(join(gitDir, "commondir"))?.trim();
      const marker = gitDir.lastIndexOf("/.git/worktrees/");
      const commonDir = common ? resolve(gitDir, common) : marker > 0 ? gitDir.slice(0, marker + "/.git".length) : gitDir;
      return { root: basename(commonDir) === ".git" ? dirname(commonDir) : commonDir, commonDir };
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}
