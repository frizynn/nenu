import { homedir } from "node:os";
import { basename, isAbsolute, join } from "node:path";

import { diskFs, repoRoot, type RepoFs } from "./repo-root.ts";

/**
 * The project a pane works in, as the sidebar groups chats by it: the repository its folder sits in,
 * named by the repo its `origin` remote names (else its first remote, else the checkout's folder), so
 * a repo's clones and worktrees join under one name; a folder in no repo is named by itself. Only the
 * last segment of a remote's path comes out, never its host or any credential in it.
 */
export function projectOf(cwd: string, fs: RepoFs = diskFs, home = homedir()): string | undefined {
  if (!cwd || !isAbsolute(cwd)) return undefined;
  const repo = repoRoot(cwd, home, fs);
  if (!repo) return basename(cwd) || undefined;
  const config = join(repo.commonDir, "config");
  return configRepoName(fs.kind(config) === "file" ? fs.read(config) : undefined) ?? (basename(repo.root).replace(/\.git$/, "") || undefined);
}

/** The repo name a git config's remotes give: `origin`'s URL first, else the first remote's. */
export function configRepoName(config: string | undefined): string | undefined {
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

/** How long a folder's project is kept before it is read again: long enough that a poll reads no disk. */
const PROJECT_TTL_MS = 60_000;

/**
 * `projectOf` per folder, read again about once a minute and forgotten once no pane is in it. Each entry's
 * minute is stretched by up to half again, so folders seen in one poll are not all read again in one.
 */
export class ProjectCache {
  private entries = new Map<string, { project: string | undefined; until: number }>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly read: (cwd: string) => string | undefined = projectOf,
    private readonly jitter: () => number = Math.random,
  ) {}

  get(cwd: string): string | undefined {
    const found = this.entries.get(cwd);
    if (found && this.now() < found.until) return found.project;
    const project = this.read(cwd);
    this.entries.set(cwd, { project, until: this.now() + PROJECT_TTL_MS * (1 + this.jitter() / 2) });
    return project;
  }

  /** Forget the folders no pane is in now. */
  keep(cwds: ReadonlySet<string>): void {
    for (const cwd of this.entries.keys()) if (!cwds.has(cwd)) this.entries.delete(cwd);
  }
}
