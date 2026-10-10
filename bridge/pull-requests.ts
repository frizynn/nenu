// The person's open pull requests in the repos their agents work in, read from GitHub with `gh`.
// Organizations records PRs only for its own threads; most agent work happens outside it, so Home's
// "Ready to review" would otherwise miss the PRs agents open on their own.
//
// Every read here runs in the background: a snapshot read gets the cached list at once and, when it
// is stale, starts one refresh. A missing or hanging `gh` costs a logged line and a timeout, never a
// blocked request, and a failed repo keeps the list it last read.
import { basename, dirname } from "node:path";

import { servicePath } from "./claude-sessions.ts";
import type { AgentView, LivePublisher, PullRequestView } from "./types.ts";

/** One external command: fixed argv, no shell, run in `cwd`, killed after `timeoutMs`. */
export type CommandRun = (argv: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The fewest milliseconds between two GitHub reads of the same repos. */
export const PR_TTL_MS = 60_000;
/** A pane in a folder never resolved asks for a sooner refresh, but not more often than this. */
const NEW_CWD_MIN_MS = 5_000;
const MAX_REPOS = 12;
const MAX_CWDS = 64;
const GH_TIMEOUT_MS = 15_000;
const GIT_TIMEOUT_MS = 3_000;
const CONCURRENCY = 4;
const PR_FIELDS = "number,title,url,headRefName,baseRefName,isDraft,reviewDecision,statusCheckRollup,additions,deletions,updatedAt";
const PR_URL_RE = /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/pull\/(\d+)$/;

/** Where a pane's folder sits: its repo (keyed by the shared git dir, so worktrees join their repo) and branch. */
interface CwdInfo {
  /** The repo's common git dir; one per repo whatever worktree the pane is in. */
  repo: string;
  /** A folder inside the repo to run `gh` from: the first worktree seen. */
  toplevel: string;
  /** Empty when detached. */
  branch: string;
}

/** A repo's last good read, without the panes (those are matched per snapshot read). */
type RepoPr = Omit<PullRequestView, "paneIds">;

export interface PullRequestRegistryOptions {
  run?: CommandRun;
  now?: () => number;
  live?: LivePublisher;
  log?: (message: string) => void;
  /** Per-command budgets; tests shorten them. */
  timeouts?: { gh: number; git: number };
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

/** `gh pr list --json` output to rows; a malformed row is dropped, never guessed at. */
export function parsePullRequests(stdout: string): RepoPr[] {
  const value: unknown = JSON.parse(stdout);
  if (!Array.isArray(value)) throw new Error("gh pr list did not return a list");
  return value.flatMap((raw): RepoPr[] => {
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
  });
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
  return { repo, toplevel, branch: branch.trim() };
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
async function attempt(run: CommandRun, argv: string[], cwd: string, timeoutMs: number): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    // The runner kills on its own timer; this one guards a runner that never settles.
    timer = setTimeout(() => resolve({ code: 124, stdout: "", stderr: "" }), timeoutMs + Math.min(timeoutMs, 1_000));
  });
  try {
    const result = await Promise.race([run(argv, { cwd, timeoutMs }), timeout]);
    if (result.code === 0) return { ok: true, stdout: result.stdout };
    const reason = result.code === 124 ? "timed out" : result.stderr.trim().split("\n")[0] || `exit ${result.code}`;
    return { ok: false, reason };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
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
  /** Each session's panes as of its last snapshot read; their folders are what gets resolved. */
  private readonly panes = new Map<string, readonly AgentView[]>();
  private cwds = new Map<string, CwdInfo | null>();
  private repos = new Map<string, RepoPr[]>();
  /** The failure last logged per repo, so a repeating one is logged once. */
  private readonly failures = new Map<string, string>();
  private lastRefresh = -Infinity;
  private inFlight: Promise<void> | undefined;

  constructor(options: PullRequestRegistryOptions = {}) {
    this.run = options.run ?? defaultCommandRun();
    this.now = options.now ?? Date.now;
    this.live = options.live;
    this.timeouts = options.timeouts ?? { gh: GH_TIMEOUT_MS, git: GIT_TIMEOUT_MS };
    this.log = options.log ?? ((message) => console.warn(`[bridge] pull requests: ${message}`));
  }

  /**
   * The open PRs across every resolved repo, each with the panes of this session sitting on its
   * branch. Answers from the cache at once; a stale cache or a folder never seen starts a refresh.
   */
  list(session: string, panes: readonly AgentView[]): PullRequestView[] {
    this.panes.set(session, panes);
    const age = this.now() - this.lastRefresh;
    const unseen = panes.some((pane) => pane.cwd && !this.cwds.has(pane.cwd));
    if (age >= PR_TTL_MS || (unseen && age >= NEW_CWD_MIN_MS)) void this.refresh();

    const onBranch = new Map<string, string[]>();
    for (const pane of panes) {
      const info = this.cwds.get(pane.cwd);
      if (!info?.branch) continue;
      const key = `${info.repo}\0${info.branch}`;
      onBranch.set(key, [...(onBranch.get(key) ?? []), pane.paneId]);
    }
    return [...this.repos].flatMap(([repo, prs]) => prs.map((pr) => ({ ...pr, paneIds: onBranch.get(`${repo}\0${pr.branch}`) ?? [] })));
  }

  /** One refresh at a time; a call while one runs joins it. */
  refresh(): Promise<void> {
    this.inFlight ??= this.read().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  private async read(): Promise<void> {
    this.lastRefresh = this.now();
    const before = JSON.stringify([...this.repos, ...this.cwds]);
    const folders = [...new Set([...this.panes.values()].flatMap((panes) => panes.map((pane) => pane.cwd)).filter(Boolean))].slice(0, MAX_CWDS);

    const cwds = new Map<string, CwdInfo | null>();
    await pool(folders, CONCURRENCY, async (cwd) => {
      const repo = await attempt(this.run, ["git", "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], cwd, this.timeouts.git);
      const branch = repo.ok ? await attempt(this.run, ["git", "branch", "--show-current"], cwd, this.timeouts.git) : undefined;
      // A folder outside any repo is remembered as such, so it does not ask for a refresh again.
      cwds.set(cwd, repo.ok ? parseRepo(repo.stdout, branch?.ok ? branch.stdout : "") ?? null : null);
    });
    this.cwds = cwds;

    // One `gh` per repo, run from the first worktree seen; pane order is the herd's triage order.
    const where = new Map<string, string>();
    for (const info of cwds.values()) if (info && !where.has(info.repo)) where.set(info.repo, info.toplevel);
    const targets = [...where].slice(0, MAX_REPOS);

    const repos = new Map<string, RepoPr[]>();
    await pool(targets, CONCURRENCY, async ([repo, cwd]) => {
      const result = await attempt(this.run, ["gh", "pr", "list", "--state", "open", "--author", "@me", "--limit", "50", "--json", PR_FIELDS], cwd, this.timeouts.gh);
      let prs: RepoPr[] | undefined;
      let reason = result.ok ? "" : result.reason;
      if (result.ok) {
        try {
          prs = parsePullRequests(result.stdout);
        } catch (error) {
          reason = error instanceof Error ? error.message : String(error);
        }
      }
      if (prs) {
        this.failures.delete(repo);
        repos.set(repo, prs);
        return;
      }
      if (this.failures.get(repo) !== reason) this.log(`${basename(repo)}: ${reason}`);
      this.failures.set(repo, reason);
      const last = this.repos.get(repo);
      if (last) repos.set(repo, last);
    });
    this.repos = repos;

    if (JSON.stringify([...this.repos, ...this.cwds]) !== before) {
      for (const session of this.panes.keys()) this.live?.publish({ session, topic: "snapshot" });
    }
  }
}
