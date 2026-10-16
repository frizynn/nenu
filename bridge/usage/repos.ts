import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { accountHash } from "./accounts.ts";

/**
 * The repository a session ran in, so a repo's worktrees count as one project. Resolved from the
 * filesystem without running git: walk up from the cwd to the first `.git`; a directory means this is
 * the main checkout, a file (`gitdir: <main>/.git/worktrees/<name>`) points at it. A cwd that no
 * longer exists (a removed worktree) falls back to its own folder name, and the walk stops below the
 * home folder, whose `.git` is usually a dotfiles repo rather than the project. The key carries a hash of the
 * root so two repos with one name stay apart, and never the path itself.
 */
export function repoOf(cwd: string, home = homedir(), read: (p: string) => string = (p) => readFileSync(p, "utf8"), isDir = dirExists): { key: string; label: string } {
  let dir = cwd;
  for (let i = 0; i < 64 && dir !== home; i++) {
    const git = join(dir, ".git");
    const kind = isDir(git);
    if (kind === "dir") return named(dir);
    if (kind === "file") {
      const m = /^gitdir:\s*(.+)$/m.exec(safe(() => read(git)) ?? "");
      if (m) {
        const target = isAbsolute(m[1]!.trim()) ? m[1]!.trim() : resolve(dir, m[1]!.trim());
        // <main>/.git/worktrees/<name> → <main>
        const marker = target.lastIndexOf(`${"/"}.git/worktrees/`);
        return named(marker > 0 ? target.slice(0, marker) : dirname(target));
      }
      return named(dir);
    }
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return named(cwd);
}

const named = (root: string) => ({ key: `${basename(root) || "/"}~${accountHash(root).slice(0, 6)}`, label: basename(root) || "/" });
const safe = <T>(f: () => T): T | undefined => { try { return f(); } catch { return undefined; } };

function dirExists(p: string): "dir" | "file" | undefined {
  try {
    const s = statSync(p);
    return s.isDirectory() ? "dir" : s.isFile() ? "file" : undefined;
  } catch {
    return undefined;
  }
}
