import { homedir } from "node:os";
import { basename } from "node:path";
import { diskFs, repoRoot, type RepoFs } from "../repo-root.ts";
import { accountHash } from "./accounts.ts";

/**
 * The repository a session ran in, so a repo's worktrees count as one project (`repoRoot`). A cwd in no
 * repo, or one that no longer exists (a removed worktree), falls back to its own folder name. The key
 * carries a hash of the root so two repos with one name stay apart, and never the path itself.
 */
export function repoOf(cwd: string, home = homedir(), fs: RepoFs = diskFs): { key: string; label: string } {
  return named(repoRoot(cwd, home, fs)?.root ?? cwd);
}

const named = (root: string) => ({ key: `${basename(root) || "/"}~${accountHash(root).slice(0, 6)}`, label: basename(root) || "/" });
