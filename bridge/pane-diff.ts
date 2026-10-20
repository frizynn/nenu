// What a pull request changes, or what a session changed, read with git from the folder a pane sits in.
//
// The client names a pane and a PR number, or a scope, and nothing else. The folder is the pane's own, from
// Herdr's snapshot; the branches are the ones GitHub reported for that PR in that folder's repo
// (pull-requests.ts); every argument git gets is built here from those. git runs from the folder's
// real path and only reports what lies under it (`--relative`). It writes nothing
// (GIT_OPTIONAL_LOCKS=0 keeps it from refreshing the index) and runs no configured program: no
// external diff, no textconv, no fsmonitor. The read is bounded: bytes git may print, files listed,
// lines kept per file, and a timeout. What a bound cut is said in the answer, never silently dropped.
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, sep } from "node:path";

import { servicePath } from "./claude-sessions.ts";
import { isPrivateProjectPath } from "./pane-files.ts";

export interface DiffLimits {
  /** Files listed; the totals still count every file. */
  files: number;
  /** Bytes of patch read before git is stopped; files past the cut keep their counts only. */
  bytes: number;
  /** Lines kept per file; a longer file keeps its counts only. */
  fileLines: number;
  timeoutMs: number;
}

/** GitHub's own web diff stops listing at 300 files; a phone reading more than a megabyte of patch is not reading it. */
export const DIFF_LIMITS: DiffLimits = { files: 300, bytes: 1_000_000, fileLines: 1_500, timeoutMs: 8_000 };
/** `--numstat -z` prints about 60 bytes a file: room for thousands, still bounded. */
const NUMSTAT_BYTES = 512 * 1024;

/** The PR as GitHub reported it, and the branch the pane's folder has checked out (empty when detached). */
export interface DiffTarget {
  number: number;
  head: string;
  base?: string;
  checkedOut: string;
}

/** One git command: fixed argv, no shell, stdout cut at `maxBytes` (`truncated`), killed after `timeoutMs` (code 124). */
export type GitRun = (argv: string[], opts: { cwd: string; timeoutMs: number; maxBytes: number }) => Promise<{ code: number; stdout: string; truncated: boolean }>;

export interface DiffHunk {
  header: string;
  oldStart: number;
  newStart: number;
  /** Each line with its marker: " " context, "+" added, "-" removed, "\" a note such as "No newline at end of file". */
  lines: string[];
}

export interface DiffFile {
  path: string;
  /** The old path of a rename. */
  from?: string;
  status: "added" | "deleted" | "renamed" | "modified";
  additions: number;
  deletions: number;
  binary?: true;
  /** Absent when `omitted` says why the lines are not here. */
  hunks?: DiffHunk[];
  /**
   * `untracked`: a new file git does not track yet, so it has no lines to diff against. `private`: a
   * path the file preview refuses (an `.env`, a credential file), named but never shown.
   */
  omitted?: "binary" | "large" | "budget" | "untracked" | "private";
}

/** What a session's Changes compares: its branch against where it started, or only what is not committed. */
export type DiffScope = "branch" | "uncommitted";

export type PaneDiff =
  | {
    ok: true;
    /** The pull request asked for; absent for a session's scope. */
    pr?: number;
    base: string;
    /** The branch checked out, or `HEAD` when detached. */
    head: string;
    /**
     * `worktree`: the working tree against where the branch left `base`, uncommitted edits included.
     * `branch`: the PR's pushed branch. `uncommitted`: the working tree against the last commit.
     */
    source: "worktree" | "branch" | "uncommitted";
    files: DiffFile[];
    totals: { files: number; additions: number; deletions: number };
    truncated?: { files?: true; bytes?: true };
    /** The project's repository, read because the pane's own folder is not in one (`projectSessionDiff`). */
    repo?: string;
  }
  | { ok: false; reason: keyof typeof MESSAGES; message: string; repo?: string };

const MESSAGES = {
  "no-folder": "This pane's folder is not available, so there is no worktree to read.",
  "no-pr": "Nenu has not read this pull request from GitHub in this pane's repository yet.",
  "no-base": "The pull request's base branch is not in this repository.",
  "head-missing": "This pane is not on the pull request's branch, and that branch has not been fetched here.",
  failed: "git could not read this diff.",
  "no-repo": "This pane's folder is not in a git repository.",
  "no-default": "Nenu found no main or master branch, and no default branch of origin, to compare against.",
} as const;

const refuse = (reason: keyof typeof MESSAGES): PaneDiff => ({ ok: false, reason, message: MESSAGES[reason] });

/**
 * A branch name as GitHub reports it, checked before it becomes part of a ref: nothing git could take
 * for an option, a range or a revision expression. Anything else is refused, not escaped.
 */
function branchName(name: string | undefined): string | undefined {
  if (!name || name.length > 255 || !/^[A-Za-z0-9_][A-Za-z0-9._/+-]*$/.test(name)) return undefined;
  if (name.includes("..") || name.includes("//") || name.endsWith("/") || name.endsWith(".lock")) return undefined;
  return name;
}

/** The environment git runs in: none of the bridge's own GIT_* (a GIT_DIR would point it elsewhere), and no writes. */
function gitEnv(PATH: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined && !key.startsWith("GIT_")) env[key] = value;
  return { ...env, PATH, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" };
}

export function defaultGitRun(): GitRun {
  const PATH = servicePath();
  return async (argv, { cwd, timeoutMs, maxBytes }) => {
    const binary = Bun.which(argv[0]!, { PATH });
    if (!binary) return { code: 127, stdout: "", truncated: false };
    const child = Bun.spawn([binary, ...argv.slice(1)], { cwd, env: gitEnv(PATH), stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    const reader = child.stdout.getReader();
    try {
      for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) {
        if (size + chunk.value.length > maxBytes) {
          chunks.push(chunk.value.subarray(0, maxBytes - size));
          truncated = true;
          child.kill();
          break;
        }
        chunks.push(chunk.value);
        size += chunk.value.length;
      }
    } finally {
      reader.releaseLock();
    }
    const code = await child.exited;
    clearTimeout(timer);
    const stdout = new TextDecoder().decode(Buffer.concat(chunks));
    return { code: truncated ? 0 : timedOut ? 124 : code, stdout, truncated };
  };
}

interface Stat { path: string; from?: string; additions: number; deletions: number; binary: boolean }

/** `--numstat -z`: `add\tdel\tpath\0`, or `add\tdel\t\0old\0new\0` for a rename; a binary file counts `-\t-`. */
export function parseNumstat(stdout: string): Stat[] {
  const tokens = stdout.split("\0");
  const stats: Stat[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const match = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(tokens[i]!);
    if (!match) continue;
    const binary = match[1] === "-";
    const counts = { additions: binary ? 0 : Number(match[1]), deletions: binary ? 0 : Number(match[2]), binary };
    if (match[3]) stats.push({ path: match[3], ...counts });
    else if (i + 2 < tokens.length) {
      stats.push({ path: tokens[i + 2]!, from: tokens[i + 1]!, ...counts });
      i += 2;
    }
  }
  return stats;
}

interface Section { status?: DiffFile["status"]; hunks: DiffHunk[]; lines: number }

/** The patch, one section per `diff --git` header, in the order numstat lists the same files. */
export function parsePatch(stdout: string): Section[] {
  const sections: Section[] = [];
  let section: Section | undefined;
  let hunk: DiffHunk | undefined;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("diff --git ")) {
      section = { hunks: [], lines: 0 };
      sections.push(section);
      hunk = undefined;
      continue;
    }
    if (!section) continue;
    const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (header) {
      hunk = { header: line, oldStart: Number(header[1]), newStart: Number(header[2]), lines: [] };
      section.hunks.push(hunk);
    } else if (hunk) {
      // A blank context line can come without its space (diff.suppressBlankEmpty).
      if (line === "" || " +-\\".includes(line[0]!)) {
        hunk.lines.push(line || " ");
        section.lines++;
      }
    } else if (line.startsWith("new file mode")) section.status = "added";
    else if (line.startsWith("deleted file mode")) section.status = "deleted";
    else if (line.startsWith("rename from")) section.status = "renamed";
  }
  // The split leaves the newline that ends the patch as an empty last line.
  const last = hunk?.lines;
  if (last && last.at(-1) === " " && stdout.endsWith("\n")) {
    last.pop();
    section!.lines--;
  }
  return sections;
}

/**
 * The diff of PR `target` from the folder `cwd`. On the PR's branch it is the working tree against
 * where the branch left its base; elsewhere in the repo it is the pushed branch against the same.
 */
export async function paneDiff(
  cwd: string | undefined,
  target: DiffTarget | undefined,
  { run = defaultGitRun(), limits: overrides = {} }: { run?: GitRun; limits?: Partial<DiffLimits> } = {},
): Promise<PaneDiff> {
  const limits = { ...DIFF_LIMITS, ...overrides };
  const folder = await paneFolder(cwd);
  if (!folder) return refuse("no-folder");
  if (!target) return refuse("no-pr");
  const base = branchName(target.base);
  if (!base) return refuse("no-base");
  const head = branchName(target.head);
  if (!head) return refuse("head-missing");

  const git = (args: string[], maxBytes = 64 * 1024) => run(["git", ...args], { cwd: folder, timeoutMs: limits.timeoutMs, maxBytes });
  const refs = await git(["for-each-ref", "--format=%(refname)", `refs/remotes/origin/${base}`, `refs/heads/${base}`, `refs/remotes/origin/${head}`]);
  if (refs.code !== 0) return refuse("failed");
  const present = new Set(refs.stdout.split("\n"));
  const baseRef = [`refs/remotes/origin/${base}`, `refs/heads/${base}`].find((ref) => present.has(ref));
  if (!baseRef) return refuse("no-base");
  const source = target.checkedOut === head ? "worktree" : "branch";
  const headRef = source === "worktree" ? "HEAD" : `refs/remotes/origin/${head}`;
  if (source === "branch" && !present.has(headRef)) return refuse("head-missing");

  const mergeBase = await git(["merge-base", baseRef, headRef]);
  const forkPoint = mergeBase.stdout.trim();
  if (mergeBase.code !== 0 || !/^[0-9a-f]{40,64}$/.test(forkPoint)) return refuse("failed");

  // The working tree when the pane is on the branch, the pushed branch otherwise.
  const read = await readRange(git, source === "worktree" ? [forkPoint] : [forkPoint, headRef], limits, false);
  return read ? { ok: true, pr: target.number, base, head, source, ...read } : refuse("failed");
}

/**
 * What the session in `cwd` changed, with or without a pull request: `branch` is the working tree
 * against where the checked-out branch left its base, `uncommitted` the working tree against the
 * last commit. The base is the one the branch's PR names (`base`, from GitHub through the bridge),
 * else origin's default branch, else main or master. Both name the files git does not track yet.
 */
export async function sessionDiff(
  cwd: string | undefined,
  scope: DiffScope,
  { base: prBase, run = defaultGitRun(), limits: overrides = {} }: { base?: string; run?: GitRun; limits?: Partial<DiffLimits> } = {},
): Promise<PaneDiff> {
  const limits = { ...DIFF_LIMITS, ...overrides };
  const folder = await paneFolder(cwd);
  if (!folder) return refuse("no-folder");
  const git = (args: string[], maxBytes = 64 * 1024) => run(["git", ...args], { cwd: folder, timeoutMs: limits.timeoutMs, maxBytes });

  const current = await git(["branch", "--show-current"]);
  if (current.code !== 0) return refuse("no-repo");
  const head = current.stdout.trim() || "HEAD";
  if (scope === "uncommitted") {
    const read = await readRange(git, ["HEAD"], limits, true);
    return read ? { ok: true, base: head, head, source: "uncommitted", ...read } : refuse("failed");
  }

  const origin = await git(["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]);
  const originDefault = origin.code === 0 && origin.stdout.startsWith("refs/remotes/origin/")
    ? branchName(origin.stdout.trim().slice("refs/remotes/origin/".length)) : undefined;
  const names = [...new Set([branchName(prBase), originDefault, "main", "master"].filter((name): name is string => name !== undefined))];
  const refs = await git(["for-each-ref", "--format=%(refname)", ...names.flatMap((name) => [`refs/remotes/origin/${name}`, `refs/heads/${name}`])]);
  if (refs.code !== 0) return refuse("failed");
  const present = new Set(refs.stdout.split("\n"));
  const base = names.find((name) => present.has(`refs/remotes/origin/${name}`) || present.has(`refs/heads/${name}`));
  if (!base) return refuse("no-default");
  const baseRef = present.has(`refs/remotes/origin/${base}`) ? `refs/remotes/origin/${base}` : `refs/heads/${base}`;
  const mergeBase = await git(["merge-base", baseRef, "HEAD"]);
  const forkPoint = mergeBase.stdout.trim();
  if (mergeBase.code !== 0 || !/^[0-9a-f]{40,64}$/.test(forkPoint)) return refuse("failed");
  const read = await readRange(git, [forkPoint], limits, true);
  return read ? { ok: true, base, head, source: "worktree", ...read } : refuse("failed");
}

/**
 * What a session changed where its work is: its own folder, else, when that is in no repository (a
 * coordinator works in its project's folder), the first repository its project names that is one,
 * named as `repo`. `base` gives the PR's base for a folder. The client never names either folder.
 */
export async function projectSessionDiff(
  cwd: string | undefined,
  scope: DiffScope,
  repos: readonly string[],
  { base, run, limits }: { base: (folder: string) => string | undefined; run?: GitRun; limits?: Partial<DiffLimits> },
): Promise<PaneDiff> {
  const own = await sessionDiff(cwd, scope, { base: cwd ? base(cwd) : undefined, run, limits });
  if (own.ok || own.reason !== "no-repo") return own;
  // A repository in a private-named folder (a password store, a dotfile config) is never read for it.
  for (const repo of repos.filter((path) => !isPrivateProjectPath(path))) {
    const read = await sessionDiff(repo, scope, { base: base(repo), run, limits });
    // A repository that is gone, or no longer one, gives way to the next.
    if (read.ok || (read.reason !== "no-repo" && read.reason !== "no-folder")) return { ...read, repo };
  }
  // `no-repo` comes only after the folder was found, so `cwd` is a path here.
  const folder = homeLabel(cwd!);
  return { ...own, message: repos.length
    ? `This pane works in ${folder}, which is not a git repository, and no repository its project names could be read.`
    : `This pane works in ${folder}, which is not in a git repository, so there are no changes to read.` };
}

/** A path with the home folder written as `~`. */
function homeLabel(path: string, home = homedir()): string {
  return path === home ? "~" : path.startsWith(home + sep) ? `~${path.slice(home.length)}` : path;
}

/** The pane's folder as its real path, or undefined when it is not an absolute path to a directory. */
async function paneFolder(cwd: string | undefined): Promise<string | undefined> {
  if (!cwd || !isAbsolute(cwd)) return undefined;
  try {
    const folder = await realpath(cwd);
    return (await stat(folder)).isDirectory() ? folder : undefined;
  } catch {
    return undefined;
  }
}

type Git = (args: string[], maxBytes?: number) => ReturnType<GitRun>;
type RangeRead = Pick<Extract<PaneDiff, { ok: true }>, "files" | "totals" | "truncated">;

/**
 * One bounded diff of `range` (a commit against the working tree, or two commits), under the folder
 * only. With `untracked`, the files git does not track yet follow, named without lines.
 */
async function readRange(git: Git, range: string[], limits: DiffLimits, untracked: boolean): Promise<RangeRead | undefined> {
  const diff = ["-c", "core.fsmonitor=false", "-c", "core.quotepath=off", "diff", "--no-ext-diff", "--no-textconv", "--no-color", "--relative", "--find-renames"];
  const [numstat, patch, others] = await Promise.all([
    git([...diff, "--numstat", "-z", ...range, "--"], NUMSTAT_BYTES),
    git([...diff, ...range, "--"], limits.bytes),
    untracked ? git(["-c", "core.fsmonitor=false", "ls-files", "--others", "--exclude-standard", "-z", "--"], NUMSTAT_BYTES) : undefined,
  ]);
  if (numstat.code !== 0 || patch.code !== 0 || (others && others.code !== 0)) return undefined;

  const stats = parseNumstat(numstat.stdout);
  const sections = parsePatch(patch.stdout);
  // The last section a cut read may have lost its end: it counts as not read.
  const complete = patch.truncated ? sections.length - 1 : sections.length;
  // A cut list loses its last name, which may be partial.
  const newFiles = others ? others.stdout.split("\0").slice(0, others.truncated ? -2 : -1).filter(Boolean) : [];
  const files = stats.slice(0, limits.files).map((entry, index): DiffFile => {
    const section = index < complete ? sections[index] : undefined;
    const status = section?.status ?? (entry.from ? "renamed" : "modified");
    const file: DiffFile = { path: entry.path, ...(entry.from ? { from: entry.from } : {}), status, additions: entry.additions, deletions: entry.deletions };
    // The path git names under the folder, not the folder's own: a checkout inside a private-named
    // folder still shows its diff, and a renamed secret keeps its old name's privacy.
    if (isPrivateProjectPath(entry.path) || (entry.from !== undefined && isPrivateProjectPath(entry.from))) return { ...file, omitted: "private" };
    if (entry.binary) return { ...file, binary: true, omitted: "binary" };
    if (!section) return { ...file, omitted: "budget" };
    if (section.lines > limits.fileLines) return { ...file, omitted: "large" };
    return { ...file, hunks: section.hunks };
  });
  const room = Math.max(0, limits.files - files.length);
  files.push(...newFiles.slice(0, room).map((path): DiffFile => ({ path, status: "added", additions: 0, deletions: 0, omitted: "untracked" })));
  const truncated = {
    ...(stats.length + newFiles.length > limits.files || numstat.truncated || others?.truncated ? { files: true as const } : {}),
    ...(patch.truncated ? { bytes: true as const } : {}),
  };
  return {
    files,
    totals: {
      files: stats.length + newFiles.length,
      additions: stats.reduce((sum, entry) => sum + entry.additions, 0),
      deletions: stats.reduce((sum, entry) => sum + entry.deletions, 0),
    },
    ...(Object.keys(truncated).length ? { truncated } : {}),
  };
}
