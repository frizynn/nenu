import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/**
 * The project a pane works in, as the sidebar groups chats by it: the repository its folder sits in,
 * named by the repo its `origin` remote names (else its first remote, else the checkout's folder), so
 * a repo's clones and worktrees join under one name; a folder in no repo is named by itself. Read from
 * the filesystem without running git: walk up from the cwd to the first `.git`, a directory in a main
 * checkout and a file (`gitdir: <main>/.git/worktrees/<name>`) in a worktree. The walk stops below the
 * home folder, whose `.git` is usually a dotfiles repo rather than the project. Only the last segment
 * of a remote's path comes out, never its host or any credential in it.
 */
export function projectOf(cwd: string, fs: ProjectFs = realFs, home = homedir()): string | undefined {
  if (!cwd || !isAbsolute(cwd)) return undefined;
  for (let dir = cwd, i = 0; i < 64 && dir !== home; i++) {
    const git = join(dir, ".git");
    const kind = fs.kind(git);
    if (kind === "dir") return remoteName(fs.read(join(git, "config"))) ?? (basename(dir) || undefined);
    if (kind === "file") {
      const target = /^gitdir:\s*(.+)$/m.exec(fs.read(git) ?? "")?.[1]?.trim();
      if (!target) return basename(dir) || undefined;
      const gitDir = isAbsolute(target) ? target : resolve(dir, target);
      // <main>/.git/worktrees/<name> → <main>/.git, which holds the repo's config.
      const marker = gitDir.lastIndexOf("/.git/worktrees/");
      const common = marker > 0 ? gitDir.slice(0, marker + "/.git".length) : gitDir;
      return remoteName(fs.read(join(common, "config"))) ?? (basename(marker > 0 ? dirname(common) : dir) || undefined);
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return basename(cwd) || undefined;
}

/** The repo name a git config's remotes give: `origin`'s URL first, else the first remote's. */
export function remoteName(config: string | undefined): string | undefined {
  if (!config) return undefined;
  const urls = new Map<string, string>();
  let remote: string | undefined;
  for (const line of config.split("\n")) {
    const section = /^\s*\[\s*remote\s+"([^"]*)"\s*\]/.exec(line);
    if (section) { remote = section[1]; continue; }
    if (/^\s*\[/.test(line)) { remote = undefined; continue; }
    const url = remote !== undefined && !urls.has(remote) ? /^\s*url\s*=\s*(.+?)\s*$/.exec(line)?.[1] : undefined;
    if (url) urls.set(remote!, url);
  }
  const url = urls.get("origin") ?? urls.values().next().value;
  // The path's last segment: `git@host:o/name.git`, `https://…/o/name`, `/srv/name/.git` all give `name`.
  const name = url?.replace(/[?#].*$/, "").replace(/\/+$/, "").replace(/\/\.git$/, "").split(/[/:\\]/).pop()?.replace(/\.git$/, "");
  return name || undefined;
}

export interface ProjectFs {
  kind(path: string): "dir" | "file" | undefined;
  read(path: string): string | undefined;
}

const realFs: ProjectFs = {
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

/** How long a folder's project is kept before it is read again: long enough that a poll reads no disk. */
const PROJECT_TTL_MS = 60_000;

/** `projectOf` per folder, read again once a minute and forgotten once no pane is in it. */
export class ProjectCache {
  private entries = new Map<string, { project: string | undefined; at: number }>();

  constructor(private readonly now: () => number = Date.now, private readonly read: (cwd: string) => string | undefined = projectOf) {}

  get(cwd: string): string | undefined {
    const found = this.entries.get(cwd);
    if (found && this.now() - found.at < PROJECT_TTL_MS) return found.project;
    const project = this.read(cwd);
    this.entries.set(cwd, { project, at: this.now() });
    return project;
  }

  /** Forget the folders no pane is in now. */
  keep(cwds: ReadonlySet<string>): void {
    for (const cwd of this.entries.keys()) if (!cwds.has(cwd)) this.entries.delete(cwd);
  }
}
