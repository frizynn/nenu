// The person's open pull requests, read from GitHub with `gh`, so Home's PRs tab shows every PR they
// have open, the ones agents open on their own included, and each chat finds the PR on its branch.
//
// Every read here runs in the background: a snapshot read gets the cached list at once and, when it
// is stale, starts one refresh. A missing or hanging `gh` costs a logged line and a timeout, never a
// blocked request, and a failed read keeps the list it last read. The list is also kept in the state
// dir, so a restarted bridge shows it before its first read comes back.
//
// A refresh asks GitHub once, for the viewer's own open pull requests (`viewer.pullRequests`, not the
// search index: a PR opened a second ago is there, and searches have their own, tighter rate limit).
// It used to search only the repos the panes sit in, which left out every PR in a repo with no pane
// open. The panes' folders are still resolved, alongside, to match each PR to the panes on its branch:
// a folder whose remotes name a github.com repo is matched by that name, and one whose remotes only gh
// can name (an ssh alias, another host) by the rows `gh pr list` reads from it.
import { homedir } from "node:os";
import { basename, dirname } from "node:path";

import { servicePath } from "./claude-sessions.ts";
import { PrefsFile } from "./prefs-file.ts";
import type { AgentView, LivePublisher, PullRequestView } from "./types.ts";

/** One external command: fixed argv, no shell, run in `cwd`, killed after `timeoutMs`. */
export type CommandRun = (argv: string[], opts: { cwd: string; timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>;

/** The fewest milliseconds between two GitHub reads of the same repos. */
export const PR_TTL_MS = 60_000;
/** A pane in a folder never resolved asks for a sooner refresh, but not more often than this. */
const NEW_CWD_MIN_MS = 5_000;
/** Repos only gh can name, each one `gh pr list` a refresh. */
const MAX_GH_NAMED = 12;
const MAX_CWDS = 64;
/** The newest open PRs one refresh reads; GitHub's page size. */
const MAX_PRS = 100;
const GH_TIMEOUT_MS = 15_000;
const GIT_TIMEOUT_MS = 3_000;
const CONCURRENCY = 4;
const SCALAR_FIELDS = ["number", "title", "url", "headRefName", "baseRefName", "isDraft", "reviewDecision", "additions", "deletions", "updatedAt"];
const PR_FIELDS = [...SCALAR_FIELDS, "statusCheckRollup"].join(",");
/** PR_FIELDS in GraphQL, with the check contexts `gh` flattens into `statusCheckRollup`. */
const GRAPHQL_FIELDS = SCALAR_FIELDS.join(" ")
  + " commits(last:1){nodes{commit{statusCheckRollup{contexts(first:100){nodes{...on StatusContext{state} ...on CheckRun{status conclusion}}}}}}}";
const SCP_RE = /^([^@]+@)?([^:]+):(\/?.+)$/;
const REPO_NAME_RE = /^[\w.-]+\/[\w.-]+$/;
/** gh's order among remotes: upstream, then github, then origin, then the rest by name. */
const REMOTE_RANK = new Map([["upstream", 3], ["github", 2], ["origin", 1]]);
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

/** A PR as GitHub last reported it, without the panes (those are matched per snapshot read). */
type RepoPr = Omit<PullRequestView, "paneIds">;

export interface PullRequestRegistryOptions {
  run?: CommandRun;
  now?: () => number;
  live?: LivePublisher;
  log?: (message: string) => void;
  /** Per-command budgets; tests shorten them. */
  timeouts?: { gh: number; git: number };
  /** A JSON file that keeps the last list across restarts. */
  file?: string;
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
  return value.flatMap(parseRow);
}

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
 * The repo a remote URL names on github.com, as gh reads it: `git@host:o/n` is ssh, a subdomain of
 * github.com is github.com, and the path is exactly `owner/name`. Null for a remote on this machine (a
 * path or `file:`), which gh skips; undefined for any other host or shape.
 */
export function githubRepo(url: string): string | null | undefined {
  const scp = url.includes("://") ? undefined : SCP_RE.exec(url);
  if (url.startsWith("file:") || (!scp && !url.includes("://"))) return null;
  let host: string;
  let parts: string[];
  try {
    const parsed = new URL(scp ? `ssh://${scp[1] ?? ""}${scp[2]}/${scp[3]!.replace(/^\//, "")}` : url);
    host = parsed.hostname.toLowerCase();
    parts = decodeURIComponent(parsed.pathname).replace(/^\/+|\/+$/g, "").split("/");
  } catch {
    return undefined;
  }
  if (host !== "github.com" && !host.endsWith(".github.com")) return undefined;
  const repo = `${parts[0]}/${parts[1]?.replace(/\.git$/, "")}`;
  return parts.length === 2 && REPO_NAME_RE.test(repo) ? repo : undefined;
}

/**
 * The repo `gh pr list` reads in a checkout, from `git config --get-regexp ^remote\.`: the remote
 * `gh repo set-default` marked, else the first by gh's order, skipping remotes on this machine as gh
 * does (null when that leaves none). Undefined when a remote names another host or alias, which only
 * gh can resolve, and for a repo with no remote at all, so gh says so as it always has.
 */
export function remoteRepo(config: string): string | null | undefined {
  const remotes = new Map<string, { url?: string; pushurl?: string; resolved?: string }>();
  for (const line of config.split("\n")) {
    const match = /^remote\.(.+)\.(url|pushurl|gh-resolved) (.*)$/.exec(line.trim());
    if (!match) continue;
    const remote = remotes.get(match[1]!) ?? {};
    const key = match[2] === "gh-resolved" ? "resolved" : match[2] as "url" | "pushurl";
    remote[key] ??= match[3]!;
    remotes.set(match[1]!, remote);
  }
  const named = [...remotes].map(([name, remote]) => {
    // gh reads the push URL only when the fetch URL gives it no repo at all.
    const fetch = remote.url === undefined ? null : githubRepo(remote.url);
    const repo = fetch !== null ? fetch : remote.pushurl === undefined ? null : githubRepo(remote.pushurl);
    return { name, repo, resolved: remote.resolved };
  });
  if (named.length === 0 || named.some((remote) => remote.repo === undefined)) return undefined;
  const github = named.filter((remote): remote is typeof remote & { repo: string } => remote.repo !== null);
  if (github.length === 0) return null;
  const rank = (name: string) => REMOTE_RANK.get(name.toLowerCase()) ?? 0;
  github.sort((a, b) => rank(b.name) - rank(a.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const remote of github) {
    if (remote.resolved === "base") return remote.repo;
    if (remote.resolved && REPO_NAME_RE.test(remote.resolved)) return remote.resolved;
  }
  return github[0]!.repo;
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

/** A saved list back from disk: the rows the last refresh kept, any other shape read as none. */
function savedRows(raw: unknown): { prs: RepoPr[] } {
  const prs = record(raw).prs;
  if (!Array.isArray(prs)) return { prs: [] };
  return {
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
async function attempt(run: CommandRun, argv: string[], cwd: string, timeoutMs: number): Promise<{ ok: true; stdout: string } | { ok: false; reason: string; stdout: string }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    // The runner kills on its own timer; this one guards a runner that never settles.
    timer = setTimeout(() => resolve({ code: 124, stdout: "", stderr: "" }), timeoutMs + Math.min(timeoutMs, 1_000));
  });
  try {
    const result = await Promise.race([run(argv, { cwd, timeoutMs }), timeout]);
    if (result.code === 0) return { ok: true, stdout: result.stdout };
    const reason = result.code === 124 ? "timed out" : result.stderr.trim().split("\n")[0] || `exit ${result.code}`;
    return { ok: false, reason, stdout: result.stdout };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error), stdout: "" };
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
  private readonly saved?: PrefsFile<{ prs: RepoPr[] }>;
  /** Each session's panes as of its last snapshot read; their folders are what gets resolved. */
  private readonly panes = new Map<string, readonly AgentView[]>();
  private cwds = new Map<string, CwdInfo | null>();
  /** The GitHub repo (`owner/name`) each repo, by common git dir, names. */
  private names = new Map<string, string>();
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
    if (options.file) {
      this.saved = new PrefsFile(options.file, savedRows);
      this.saved.loadSync();
      this.prs = this.saved.current().prs;
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

    const onBranch = new Map<string, string[]>();
    for (const pane of panes) {
      const info = this.cwds.get(pane.cwd);
      const name = info?.branch && this.names.get(info.repo);
      if (!name) continue;
      const key = `${name}\0${info.branch}`;
      onBranch.set(key, [...(onBranch.get(key) ?? []), pane.paneId]);
    }
    return this.prs.map((pr) => ({ ...pr, paneIds: onBranch.get(`${pr.repo}\0${pr.branch}`) ?? [] }));
  }

  /** The open PRs of the GitHub repo `cwd` sits in, and that folder's place, as the last refresh read them. */
  private inRepo(cwd: string): { info: CwdInfo; prs: RepoPr[] } | undefined {
    const info = this.cwds.get(cwd);
    const name = info && this.names.get(info.repo);
    return info && name ? { info, prs: this.prs.filter((pr) => pr.repo === name) } : undefined;
  }

  /**
   * Open PR `number` of the repo `cwd` sits in, and the branch `cwd` has checked out, as the last
   * refresh read them. Runs nothing: a folder or PR not read yet is undefined.
   */
  locate(cwd: string, number: number): { pr: RepoPr; checkedOut: string } | undefined {
    const repo = this.inRepo(cwd);
    const pr = repo?.prs.find((candidate) => candidate.number === number);
    return repo && pr ? { pr, checkedOut: repo.info.branch } : undefined;
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

  /** The GitHub repo `gh pr list` reads from `cwd`, learnt from the rows it prints; undefined when it reads none. */
  private async ghName(cwd: string): Promise<string | undefined> {
    const result = await attempt(this.run, ["gh", "pr", "list", "--state", "open", "--author", "@me", "--limit", "1", "--json", PR_FIELDS], cwd, this.timeouts.gh);
    try {
      return result.ok ? parsePullRequests(result.stdout)[0]?.repo : undefined;
    } catch {
      return undefined;
    }
  }

  /** Where each pane's folder sits, and the GitHub repo each of those repos names. */
  private async resolveFolders(): Promise<void> {
    const folders = [...new Set([...this.panes.values()].flatMap((panes) => panes.map((pane) => pane.cwd)).filter(Boolean))].slice(0, MAX_CWDS);
    const cwds = new Map<string, CwdInfo | null>();
    await pool(folders, CONCURRENCY, async (cwd) => {
      // A folder stays in its repo; only its branch moves, so a folder read before costs one git call.
      const known = this.cwds.get(cwd);
      const repo = known ? undefined : await attempt(this.run, ["git", "rev-parse", "--path-format=absolute", "--git-common-dir", "--show-toplevel"], cwd, this.timeouts.git);
      const branch = known || repo?.ok ? await attempt(this.run, ["git", "branch", "--show-current"], cwd, this.timeouts.git) : undefined;
      if (known) {
        // A folder gone since is resolved afresh by the next refresh.
        if (branch?.ok) cwds.set(cwd, { ...known, branch: branch.stdout.trim() });
        return;
      }
      // A folder outside any repo is remembered as such, so it does not ask for a refresh again.
      cwds.set(cwd, repo?.ok ? parseRepo(repo.stdout, branch?.ok ? branch.stdout : "") ?? null : null);
    });

    // Each repo is read from the first worktree seen; pane order is the herd's triage order.
    const where = new Map<string, string>();
    for (const info of cwds.values()) if (info && !where.has(info.repo)) where.set(info.repo, info.toplevel);
    const names = new Map<string, string>();
    const ghNamed: Array<[string, string]> = [];
    await pool([...where], CONCURRENCY, async ([repo, cwd]) => {
      const remotes = await attempt(this.run, ["git", "config", "--get-regexp", "^remote\\."], cwd, this.timeouts.git);
      const name = remotes.ok ? remoteRepo(remotes.stdout) : undefined;
      if (name) names.set(repo, name);
      // A repo whose remotes are all on this machine has no PRs; gh says so too.
      else if (name === undefined) ghNamed.push([repo, cwd]);
    });
    await pool(ghNamed.slice(0, MAX_GH_NAMED), CONCURRENCY, async ([repo, cwd]) => {
      const name = await this.ghName(cwd) ?? this.names.get(repo);
      if (name) names.set(repo, name);
    });
    this.cwds = cwds;
    this.names = names;
  }

  private async read(): Promise<void> {
    this.lastRefresh = this.now();
    const before = JSON.stringify([this.prs, ...this.names, ...this.cwds]);
    // GitHub's answer does not depend on the folders, so the two run side by side.
    const [mine] = await Promise.all([this.readMine(), this.resolveFolders()]);
    if (typeof mine === "string") {
      if (this.failure !== mine) this.log(mine);
      this.failure = mine;
    } else {
      this.failure = "";
      if (JSON.stringify(mine) !== JSON.stringify(this.prs)) void this.saved?.set({ prs: mine }).catch(() => {});
      this.prs = mine;
    }

    if (JSON.stringify([this.prs, ...this.names, ...this.cwds]) !== before) {
      for (const session of this.panes.keys()) this.live?.publish({ session, topic: "snapshot" });
    }
  }
}
