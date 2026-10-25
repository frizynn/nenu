// The person's open pull requests, read from GitHub with `gh`, so Home's PRs tab shows every PR they
// have open, the ones agents open on their own included, and each chat finds the PR on its branch.
//
// Every read here runs in the background: a snapshot read gets the cached list at once and, when it
// is stale, starts one refresh. A missing or hanging `gh` costs a logged line and a timeout, never a
// blocked request, and a failed read keeps the list it last read. The list is also kept in the state
// dir, so a restarted bridge shows it before its first read comes back.
//
// A refresh asks GitHub once, for the viewer's own open pull requests (`viewer.pullRequests`, not the
// search index: a PR opened a second ago is there, and searches have their own, tighter rate limit),
// so a PR in a repo no pane sits in is listed too (ADR 0127). The panes' folders resolve alongside, to
// match each PR to the panes on its branch by the `owner/name` their remotes name, and to mark the PRs
// of a repo some pane's folder names as in use, which is what Home shows unless asked for all (ADR 0128).
import { statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import { servicePath } from "./claude-sessions.ts";
import { PrefsFile } from "./prefs-file.ts";
import type { AgentView, LivePublisher, PullRequestView } from "./types.ts";

/** One external command: fixed argv, no shell, run in `cwd`, killed after `timeoutMs`. */
export type CommandRun = (argv: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The fewest milliseconds between two reads of the list. */
export const PR_TTL_MS = 60_000;
/** A pane in a folder never resolved asks for a sooner refresh, but not more often than this. */
const NEW_CWD_MIN_MS = 5_000;
const MAX_CWDS = 64;
/** The newest open PRs one refresh reads; GitHub's page size. */
const MAX_PRS = 100;
/** A list kept on disk longer than this is not shown after a restart: those PRs may long be merged. */
const SAVED_MAX_AGE_MS = 24 * 60 * 60_000;
const GH_TIMEOUT_MS = 15_000;
const GIT_TIMEOUT_MS = 3_000;
const CONCURRENCY = 4;
/** The fields `gh pr list --json` names, in GraphQL, with the check contexts it flattens into `statusCheckRollup`. */
const GRAPHQL_FIELDS = "number title url headRefName baseRefName isDraft reviewDecision additions deletions updatedAt"
  + " commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{...on StatusContext{state} ...on CheckRun{status conclusion}}}}}}}";
const SCP_RE = /^([^@]+@)?([^:]+):(\/?.+)$/;
const REPO_NAME_RE = /^[\w.-]+\/[\w.-]+$/;
/** How often a list that has not changed is written again, so its date stays near its last read. */
const RESAVE_MS = 60 * 60_000;
const PR_URL_RE = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)$/;

/** Where a pane's folder sits: its repo (keyed by the shared git dir, so worktrees join their repo) and branch. */
interface CwdInfo {
  /** The repo, by its common git dir; one per repo whatever worktree the pane is in. */
  repo: string;
  /** The common git dir itself, which holds the repo's `config`. */
  gitDir: string;
  /** A folder inside the repo to read its remotes from: the first worktree seen. */
  toplevel: string;
  /** Empty when detached. */
  branch: string;
}

/** A PR as GitHub last reported it, without the panes (those are matched per snapshot read). */
type RepoPr = Omit<PullRequestView, "paneIds" | "inUse">;

export interface PullRequestRegistryOptions {
  run?: CommandRun;
  now?: () => number;
  live?: LivePublisher;
  log?: (message: string) => void;
  /** Per-command budgets; tests shorten them. */
  timeouts?: { gh: number; git: number };
  /** A JSON file that keeps the last list across restarts. */
  file?: string;
  /** When a file last changed (ms), undefined when it cannot be read; tests fake it. */
  mtime?: (path: string) => number | undefined;
}

const REVIEWS: Record<string, PullRequestView["review"]> = {
  APPROVED: "approved",
  CHANGES_REQUESTED: "changes_requested",
  REVIEW_REQUIRED: "review_required",
};
const PASSED = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const PENDING_STATES = new Set(["PENDING", "EXPECTED"]);

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/**
 * Check counts from `statusCheckRollup`, which mixes check runs (`status` + `conclusion`) and commit
 * statuses (`state`). A run that has not completed is pending whatever its conclusion says.
 */
export function summarizeChecks(rollup: unknown): PullRequestView["checks"] {
  if (!Array.isArray(rollup) || rollup.length === 0) return undefined;
  const checks = { passed: 0, failed: 0, pending: 0 };
  for (const raw of rollup) {
    const item = record(raw);
    if (typeof item.state === "string") {
      if (item.state === "SUCCESS") checks.passed++;
      else if (PENDING_STATES.has(item.state)) checks.pending++;
      else checks.failed++;
    } else if (item.status !== "COMPLETED") checks.pending++;
    else if (PASSED.has(String(item.conclusion))) checks.passed++;
    else checks.failed++;
  }
  return checks;
}

/** A row shaped as `gh pr list --json` prints it; a malformed row is dropped, never guessed at. */
function parseRow(raw: unknown): RepoPr[] {
  const row = record(raw);
  const url = typeof row.url === "string" ? row.url : "";
  const match = PR_URL_RE.exec(url);
  if (!match || typeof row.number !== "number" || typeof row.title !== "string" || typeof row.headRefName !== "string") return [];
  const review = REVIEWS[String(row.reviewDecision)];
  const checks = summarizeChecks(row.statusCheckRollup);
  const updatedAt = typeof row.updatedAt === "string" ? Date.parse(row.updatedAt) : NaN;
  return [{
    repo: match[1]!,
    number: row.number,
    title: row.title,
    url,
    branch: row.headRefName,
    ...(typeof row.baseRefName === "string" ? { base: row.baseRefName } : {}),
    draft: row.isDraft === true,
    ...(review ? { review } : {}),
    ...(checks ? { checks } : {}),
    ...(typeof row.additions === "number" && typeof row.deletions === "number" ? { diff: { additions: row.additions, deletions: row.deletions } } : {}),
    ...(Number.isFinite(updatedAt) ? { updatedAt } : {}),
  }];
}

/**
 * The repo a remote URL names, `owner/name` from its path as gh reads one: `git@host:o/n` is ssh and
 * the path is exactly two parts. Any host counts: an ssh alias (`git@github-work:o/n`) names a
 * github.com repo, and the list it is matched against is github.com's alone. Undefined for a remote on
 * this machine (a path or `file:`) and for any other shape.
 */
export function remoteName(url: string): string | undefined {
  const scp = url.includes("://") ? undefined : SCP_RE.exec(url);
  if (url.startsWith("file:") || (!scp && !url.includes("://"))) return undefined;
  let parts: string[];
  try {
    const parsed = new URL(scp ? `ssh://${scp[1] ?? ""}${scp[2]}/${scp[3]!.replace(/^\//, "")}` : url);
    parts = decodeURIComponent(parsed.pathname).replace(/^\/+|\/+$/g, "").split("/");
  } catch {
    return undefined;
  }
  const repo = `${parts[0]}/${parts[1]?.replace(/\.git$/, "")}`;
  return parts.length === 2 && REPO_NAME_RE.test(repo) ? repo : undefined;
}

/**
 * Every repo a checkout's remotes name, lower-cased as GitHub ignores case, from `git config
 * --get-regexp ^remote\.`: each remote's fetch and push URL, and the repo `gh repo set-default` marked.
 * A PR opened against any of them is this checkout's, so a fork's PRs to its upstream count as well as
 * its own, and a remote on another host matches nothing on GitHub's list.
 */
export function remoteRepos(config: string): string[] {
  const repos = new Set<string>();
  for (const line of config.split("\n")) {
    const match = /^remote\..+\.(url|pushurl|gh-resolved) (.*)$/.exec(line.trim());
    if (!match) continue;
    const repo = match[1] === "gh-resolved" ? match[2]! : remoteName(match[2]!);
    if (repo && REPO_NAME_RE.test(repo)) repos.add(repo.toLowerCase());
  }
  return [...repos];
}

/** The one GraphQL request a refresh sends: the viewer's open pull requests, newest first. */
export function viewerArgv(): string[] {
  // gh api would follow GH_HOST; the list is github.com's.
  return ["gh", "api", "--hostname", "github.com", "graphql", "-f",
    `query=query{viewer{pullRequests(states:OPEN,first:${MAX_PRS},orderBy:{field:UPDATED_AT,direction:DESC}){nodes{${GRAPHQL_FIELDS}}}}}`];
}

/**
 * That request's answer as rows shaped like `gh pr list --json` prints them. Throws with GitHub's own
 * message when the answer holds no list.
 */
export function parseViewer(stdout: string): RepoPr[] {
  const answer = record(JSON.parse(stdout));
  const nodes = record(record(record(answer.data).viewer).pullRequests).nodes;
  if (!Array.isArray(nodes)) {
    const error = Array.isArray(answer.errors) ? record(answer.errors[0]).message : undefined;
    throw new Error(typeof error === "string" ? error : "GitHub gave no pull requests");
  }
  return nodes.flatMap((node) => {
    const pr = record(node);
    const commits = record(pr.commits).nodes;
    const commit = record(record(Array.isArray(commits) ? commits[0] : undefined).commit);
    return parseRow({ ...pr, statusCheckRollup: record(record(commit.statusCheckRollup).contexts).nodes });
  });
}

/**
 * The list as kept on disk, with when it was read (epoch ms) and, per session, the repos its panes'
 * folders named then (lower-cased `owner/name`), which mark PRs in use until a folder answers again.
 * A session the record does not name marks every PR in use meanwhile, never none.
 */
interface SavedList { at: number; prs: RepoPr[]; inUse?: Readonly<Record<string, readonly string[]>> }

/** A saved list back from disk: the rows the last refresh kept, any other shape read as none. */
function savedList(raw: unknown): SavedList {
  const { at, prs, inUse } = record(raw);
  if (typeof at !== "number" || !Array.isArray(prs)) return { at: 0, prs: [] };
  return {
    at,
    ...(inUse && typeof inUse === "object" && !Array.isArray(inUse) ? {
      inUse: Object.fromEntries(Object.entries(inUse).map(([session, repos]) =>
        [session, Array.isArray(repos) ? repos.filter((repo): repo is string => typeof repo === "string") : []])),
    } : {}),
    prs: prs.filter((row): row is RepoPr => {
      const pr = record(row);
      return typeof pr.repo === "string" && typeof pr.number === "number" && typeof pr.title === "string"
        && typeof pr.url === "string" && PR_URL_RE.test(pr.url) && typeof pr.branch === "string" && typeof pr.draft === "boolean";
    }),
  };
}

/**
 * Where a folder sits, from `rev-parse --git-common-dir --show-toplevel` and `branch --show-current`
 * (which also names an unborn branch, and prints nothing when detached).
 */
export function parseRepo(revParse: string, branch: string): CwdInfo | undefined {
  const [commonDir, toplevel] = revParse.split("\n").map((line) => line.trim());
  if (!commonDir || !toplevel) return undefined;
  // A worktree's common dir is the main repo's `.git`; the repo is the folder holding it.
  const repo = basename(commonDir) === ".git" ? dirname(commonDir) : commonDir;
  return { repo, gitDir: commonDir, toplevel, branch: branch.trim() };
}

async function pool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await task(item);
  }));
}

export function defaultCommandRun(): CommandRun {
  const PATH = servicePath();
  return async (argv, { cwd, timeoutMs }) => {
    const binary = Bun.which(argv[0]!, { PATH });
    if (!binary) return { code: 127, stdout: "", stderr: `${argv[0]} not found` };
    const child = Bun.spawn([binary, ...argv.slice(1)], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      // Never wait on a prompt: there is nobody to answer it.
      env: { ...process.env, PATH, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited.finally(() => clearTimeout(timer)),
    ]);
    return { code: timedOut ? 124 : code, stdout, stderr };
  };
}

/** A command that fails, throws or outlives its budget all read as a failure with a reason. */
async function attempt(run: CommandRun, argv: string[], cwd: string, timeoutMs: number): Promise<{ ok: true; stdout: string } | { ok: false; code: number; reason: string; stdout: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    // The runner kills on its own timer; this one guards a runner that never settles.
    timer = setTimeout(() => resolve({ code: 124, stdout: "", stderr: "" }), timeoutMs + Math.min(timeoutMs, 1_000));
  });
  try {
    const result = await Promise.race([run(argv, { cwd, timeoutMs }), timeout]);
    if (result.code === 0) return { ok: true, stdout: result.stdout };
    const reason = result.code === 124 ? "timed out" : result.stderr.trim().split("\n")[0] || `exit ${result.code}`;
    return { ok: false, code: result.code, reason, stdout: result.stdout };
  } catch (error) {
    return { ok: false, code: -1, reason: error instanceof Error ? error.message : String(error), stdout: "" };
  } finally {
    clearTimeout(timer);
  }
}

export class PullRequestRegistry {
  private readonly run: CommandRun;
  private readonly now: () => number;
  private readonly live?: LivePublisher;
  private readonly log: (message: string) => void;
  private readonly timeouts: { gh: number; git: number };
  private readonly saved?: PrefsFile<SavedList>;
  /** Each session's panes as of its last snapshot read; their folders are what gets resolved. */
  private readonly panes = new Map<string, readonly AgentView[]>();
  private cwds = new Map<string, CwdInfo | null>();
  /** The repos (`owner/name`) each repo's remotes name, as of its `config` file's `stamp`. */
  private names = new Map<string, { stamp: number; repos: readonly string[] }>();
  private readonly mtime: (path: string) => number | undefined;
  /** When the saved list was last written, and what it held. */
  private savedAt = 0;
  private savedJson = "";
  /** Each session's repos in use as last known, kept on disk; read for a session until one of its folders answers. */
  private savedInUse: Readonly<Record<string, readonly string[]>> = {};
  /** Folders git answered for: in a repo, or in none. A git that failed or timed out says neither. */
  private readonly answered = new Set<string>();
  /** The last good read, newest first. */
  private prs: RepoPr[] = [];
  /** The failure last logged, so a repeating one is logged once. */
  private failure = "";
  private lastRefresh = -Infinity;
  private inFlight: Promise<void> | undefined;

  constructor(options: PullRequestRegistryOptions = {}) {
    this.run = options.run ?? defaultCommandRun();
    this.now = options.now ?? Date.now;
    this.live = options.live;
    this.timeouts = options.timeouts ?? { gh: GH_TIMEOUT_MS, git: GIT_TIMEOUT_MS };
    this.log = options.log ?? ((message) => console.warn(`[bridge] pull requests: ${message}`));
    this.mtime = options.mtime ?? ((path) => {
      try {
        return statSync(path).mtimeMs;
      } catch {
        return undefined;
      }
    });
    if (options.file) {
      this.saved = new PrefsFile(options.file, savedList);
      this.saved.loadSync();
      const kept = this.saved.current();
      if (this.now() - kept.at < SAVED_MAX_AGE_MS) {
        this.prs = kept.prs;
        this.savedInUse = kept.inUse ?? {};
      }
      this.savedAt = kept.at;
      this.savedJson = JSON.stringify([kept.prs, kept.inUse]);
    }
  }

  /**
   * Every open PR, each with the panes of this session sitting on its branch. Answers from the cache
   * at once; a stale cache or a folder never seen starts a refresh.
   */
  list(session: string, panes: readonly AgentView[]): PullRequestView[] {
    this.panes.set(session, panes);
    const age = this.now() - this.lastRefresh;
    const unseen = panes.some((pane) => pane.cwd && !this.cwds.has(pane.cwd));
    if (age >= PR_TTL_MS || (unseen && age >= NEW_CWD_MIN_MS)) void this.refresh();

    return this.rows(session, panes);
  }

  /**
   * Every PR the last refresh read, each with those of `panes` that sit on its branch, and whether its
   * repo is one their folders name, on any branch.
   */
  private rows(session: string, panes: readonly AgentView[]): PullRequestView[] {
    const onBranch = new Map<string, string[]>();
    for (const pane of panes) {
      const info = this.cwds.get(pane.cwd);
      if (!info?.branch) continue;
      for (const name of this.names.get(info.repo)?.repos ?? []) {
        const key = `${name}\0${info.branch}`;
        onBranch.set(key, [...(onBranch.get(key) ?? []), pane.paneId]);
      }
    }
    const known = this.settled(panes) ? this.inUse(panes) : this.savedInUse[session];
    const inUse = known && new Set(known);
    return this.prs.map((pr) => ({
      ...pr, paneIds: onBranch.get(`${pr.repo.toLowerCase()}\0${pr.branch}`) ?? [], inUse: inUse?.has(pr.repo.toLowerCase()) ?? true,
    }));
  }

  /**
   * Whether git has answered for a folder of `panes`, so their repos in use are read, not recalled. No
   * folder at all says nothing either: a herd not read yet looks the same as an empty one.
   */
  private settled(panes: readonly AgentView[]): boolean {
    return panes.some((pane) => pane.cwd && this.answered.has(pane.cwd));
  }

  /** The repos (lower-cased `owner/name`) the folders of `panes` name through their remotes. */
  private inUse(panes: readonly AgentView[]): string[] {
    const repos = new Set<string>();
    for (const pane of panes) {
      const info = this.cwds.get(pane.cwd);
      for (const name of (info && this.names.get(info.repo)?.repos) ?? []) repos.add(name);
    }
    return [...repos].sort();
  }

  /** The open PRs of the GitHub repos `cwd`'s remotes name, and that folder's place, as the last refresh read them. */
  private inRepo(cwd: string): { info: CwdInfo; prs: RepoPr[] } | undefined {
    const info = this.cwds.get(cwd);
    const repos = info && this.names.get(info.repo)?.repos;
    return info && repos ? { info, prs: this.prs.filter((pr) => repos.includes(pr.repo.toLowerCase())) } : undefined;
  }

  /**
   * Open PR `number` of `repo` (`owner/name`, any case), one of the repos `cwd`'s remotes name, and the
   * branch `cwd` has checked out, as the last refresh read them. Without `repo`, the newest PR of that
   * number among them: a fork's checkout can see `me/shop#5` and `acme/shop#5`. Runs nothing: a folder
   * or PR not read yet is undefined.
   */
  locate(cwd: string, number: number, repo?: string): { pr: RepoPr; checkedOut: string } | undefined {
    const place = this.inRepo(cwd);
    const pr = place?.prs.find((candidate) => candidate.number === number && (!repo || candidate.repo.toLowerCase() === repo.toLowerCase()));
    return place && pr ? { pr, checkedOut: place.info.branch } : undefined;
  }

  /** The open PR of the branch `cwd` has checked out, as the last refresh read it. Runs nothing. */
  onBranch(cwd: string): RepoPr | undefined {
    const repo = this.inRepo(cwd);
    return repo?.info.branch ? repo.prs.find((candidate) => candidate.branch === repo.info.branch) : undefined;
  }

  /** One refresh at a time; a call while one runs joins it. */
  refresh(): Promise<void> {
    this.inFlight ??= this.read().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  /** The viewer's open PRs, or why GitHub gave none. */
  private async readMine(): Promise<RepoPr[] | string> {
    // gh api needs no repo; the home folder is one every account has.
    const result = await attempt(this.run, viewerArgv(), homedir(), this.timeouts.gh);
    try {
      // A partial answer exits 1 with its JSON on stdout: what it holds still counts.
      return parseViewer(result.stdout);
    } catch (error) {
      return result.ok ? (error instanceof Error ? error.message : String(error)) : result.reason;
    }
  }

  /** Where each pane's folder sits, and the GitHub repo each of those repos names. */
  private async resolveFolders(): Promise<void> {
    const folders = [...new Set([...this.panes.values()].flatMap((panes) => panes.map((pane) => pane.cwd)).filter(Boolean))].slice(0, MAX_CWDS);
    const cwds = new Map<string, CwdInfo | null>();
    const answered: string[] = [];
    await pool(folders, CONCURRENCY, async (cwd) => {
      // A folder stays in its repo; only its branch moves, so a folder read before costs one git call.
      const known = this.cwds.get(cwd);
      const repo = known ? undefined : await attempt(this.run, ["git", "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], cwd, this.timeouts.git);
      const branch = known || repo?.ok ? await attempt(this.run, ["git", "branch", "--show-current"], cwd, this.timeouts.git) : undefined;
      if (known) {
        // A folder gone since is resolved afresh by the next refresh; a slow git keeps what it said.
        if (branch?.ok) cwds.set(cwd, { ...known, branch: branch.stdout.trim() });
        else if (branch?.code === 124) cwds.set(cwd, known);
        return;
      }
      // A folder outside any repo is remembered as such, so it does not ask for a refresh again.
      const info = repo?.ok ? parseRepo(repo.stdout, branch?.ok ? branch.stdout : "") ?? null : null;
      cwds.set(cwd, info);
      // 128 is git's own "not a git repository"; anything else is a git that could not say.
      if (info || (repo && !repo.ok && repo.code === 128)) answered.push(cwd);
    });

    // A repo's remotes are read from the first worktree seen, again only when its config file changes.
    const where = new Map<string, CwdInfo>();
    for (const info of cwds.values()) if (info && !where.has(info.repo)) where.set(info.repo, info);
    const names = new Map<string, { stamp: number; repos: readonly string[] }>();
    await pool([...where], CONCURRENCY, async ([repo, info]) => {
      const stamp = this.mtime(join(info.gitDir, "config"));
      const last = this.names.get(repo);
      if (last && stamp !== undefined && last.stamp === stamp) return void names.set(repo, last);
      const remotes = await attempt(this.run, ["git", "config", "--get-regexp", "^remote\\."], info.toplevel, this.timeouts.git);
      // git config exits 1 when there is no remote at all; any other failure keeps what it last said.
      if (remotes.ok || remotes.code === 1) names.set(repo, { stamp: stamp ?? NaN, repos: remoteRepos(remotes.ok ? remotes.stdout : "") });
      else if (last) names.set(repo, last);
    });
    this.cwds = cwds;
    this.names = names;
    // Only now: a read while this ran must not take a folder as answered before its repos are in.
    for (const cwd of answered) this.answered.add(cwd);
  }

  /** What each session's page would read, to tell whether a refresh changed it. */
  private shown(): string {
    return JSON.stringify([...this.panes].map(([session, panes]) => [session, this.rows(session, panes)]));
  }

  private async read(): Promise<void> {
    this.lastRefresh = this.now();
    const before = this.shown();
    // GitHub's answer does not depend on the folders, so the two run side by side.
    const [mine] = await Promise.all([this.readMine(), this.resolveFolders()]);
    if (typeof mine === "string") {
      if (this.failure !== mine) this.log(mine);
      this.failure = mine;
    } else {
      this.failure = "";
      this.prs = mine;
      // What each session's folders said, else what was kept for it: a failed read never overwrites it.
      const inUse = { ...this.savedInUse };
      for (const [session, panes] of this.panes) if (this.settled(panes)) inUse[session] = this.inUse(panes);
      this.savedInUse = inUse;
      const json = JSON.stringify([mine, inUse]);
      if (this.saved && (json !== this.savedJson || this.now() - this.savedAt >= RESAVE_MS)) {
        const at = this.now();
        // A write that fails is tried again on the next refresh.
        await this.saved.set({ at, prs: mine, inUse }).then(() => {
          this.savedJson = json;
          this.savedAt = at;
        }, () => {});
      }
    }

    if (this.shown() !== before) {
      for (const session of this.panes.keys()) this.live?.publish({ session, topic: "snapshot" });
    }
  }
}
