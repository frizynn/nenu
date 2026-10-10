import { servicePath } from "./claude-sessions.ts";
import type { TemplateView } from "./types.ts";

export type OrgRun = (
  argv: string[],
  opts: { stdin?: string; env?: Record<string, string>; timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const NODE_ID_RE = /^t-\d{4,}$/;
/** Organizations' profile names: letters, digits, `.`, `_` and `-`, at most 40, not led by `-` or `.`. */
export const PROFILE_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,39}$/;
export const NODE_ROLES = ["worker", "coordinator"] as const;
export type NodeRole = typeof NODE_ROLES[number];

export class OrgValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgValidationError";
  }
}

export class OrgCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OrgCliError";
  }
}

export function validateProjectSlug(value: unknown): string {
  return validateSlug(value, "Project");
}

export function validateTemplateName(value: unknown): string {
  return validateSlug(value, "Template");
}

export function validateNodeId(value: unknown): string {
  if (typeof value !== "string" || !NODE_ID_RE.test(value)) {
    throw new OrgValidationError("Node ID must look like t-1234.");
  }
  return value;
}

export function validateParent(value: unknown): string {
  if (value === "root") return value;
  return validateNodeId(value);
}

export function validateRole(value: unknown): NodeRole {
  if (value === undefined) return "worker";
  const role = NODE_ROLES.find((candidate) => candidate === value);
  if (!role) throw new OrgValidationError("Role must be worker or coordinator.");
  return role;
}

/** A profile name, or "" for the project's default. */
export function validateProfile(value: unknown): string {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || !PROFILE_RE.test(value)) throw new OrgValidationError("Profile must be a profile name.");
  return value;
}

export function validateTitle(value: unknown): string {
  if (typeof value !== "string") throw new OrgValidationError("Title must be text.");
  const title = value.trim();
  if (!title) throw new OrgValidationError("Title is required.");
  if (Array.from(title).length > 120) throw new OrgValidationError("Title must be 120 characters or fewer.");
  if (/[\r\n]/.test(title)) throw new OrgValidationError("Title cannot contain line breaks.");
  return title;
}

export function validateTask(value: unknown): string {
  if (typeof value !== "string") throw new OrgValidationError("Task must be text.");
  const task = value.trim();
  const bytes = Buffer.byteLength(task, "utf8");
  if (!task) throw new OrgValidationError("Task is required.");
  if (bytes > 16_384) throw new OrgValidationError("Task must be 16,384 bytes or fewer.");
  return task;
}

/**
 * The CLI's environment. The bridge is the person's own hand, never an agent's: a pane or workspace
 * id inherited from a Herdr pane would make Organizations refuse `thread merge` as coming from an
 * agent pane, and make `overview` narrow itself to that workspace's project.
 */
export function orgEnv(base: Record<string, string | undefined>, PATH: string, extra: Record<string, string> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...base, PATH, ...extra };
  for (const key of ["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"]) delete env[key];
  return env;
}

/**
 * The Organizations CLI, or the upstream herdr-projects it forked from. Most hosts still run upstream,
 * which has `thread resolve` but no `node` commands, `--json` contract or PR actions.
 */
function orgBinary(PATH: string): string | null {
  return Bun.which("herdr-organizations", { PATH }) ?? Bun.which("herdr-projects", { PATH });
}

/** True when only upstream herdr-projects is available, so node-level commands do not exist. */
export function upstreamOnly(PATH = servicePath()): boolean {
  if (process.env.COLLIE_HERDR_ORGANIZATIONS_BIN?.trim()) return false;
  return !Bun.which("herdr-organizations", { PATH }) && !!Bun.which("herdr-projects", { PATH });
}

export function defaultOrgRun(): OrgRun {
  return async (argv, opts) => {
    const configured = process.env.COLLIE_HERDR_ORGANIZATIONS_BIN?.trim();
    const PATH = servicePath();
    const binary = configured || orgBinary(PATH);
    if (!binary) throw new OrgCliError("Neither herdr-organizations nor herdr-projects is installed.");

    const child = Bun.spawn([binary, ...argv], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: orgEnv(process.env, PATH, opts.env),
    });
    if (opts.stdin !== undefined) child.stdin.write(opts.stdin);
    child.stdin.end();

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, opts.timeoutMs);
    const exit = child.exited.finally(() => clearTimeout(timer));
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      exit,
    ]);
    return { code: timedOut ? 124 : code, stdout, stderr };
  };
}

export async function listTemplates(run: OrgRun, project: string): Promise<TemplateView[]> {
  const slug = validateProjectSlug(project);
  const result = await run(["template", "list", "--project", slug, "--json"], { timeoutMs: 10_000 });
  if (result.code !== 0) {
    if (result.stderr.toLowerCase().includes("unrecognized subcommand")) return [];
    throw commandError(result);
  }

  const value = parseJson(result.stdout, "template list");
  if (!Array.isArray(value)) throw new OrgCliError("herdr-organizations returned an invalid template list.");
  return value.flatMap((item) => {
    const template = parseTemplate(item);
    return template ? [template] : [];
  });
}

/** The profiles this host can launch, by name (`profile list --names`); none when the CLI cannot say. */
export async function listProfiles(run: OrgRun): Promise<string[]> {
  const result = await run(["profile", "list", "--names"], { timeoutMs: 10_000 });
  if (result.code !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter((name) => PROFILE_RE.test(name));
}

/** What the start form offers for a project: its templates and the profiles a node can run. */
export async function startOptions(run: OrgRun, project: string): Promise<{ templates: TemplateView[]; profiles: string[] }> {
  const [templates, profiles] = await Promise.all([listTemplates(run, project), listProfiles(run)]);
  return { templates, profiles };
}

/**
 * Start a worker or a coordinator under the project root or an open coordinator, from a template
 * (which carries its role and profile) or from a role and an optional profile. Upstream
 * herdr-projects has no nodes: it starts a top-level thread with `thread start`, and refuses the rest.
 */
export async function startNode(
  run: OrgRun,
  socketPath: string,
  input: { project: unknown; title: unknown; parent: unknown; task: unknown; role?: unknown; profile?: unknown; template?: unknown },
  upstream: () => boolean = upstreamOnly,
): Promise<{ id: string }> {
  const project = validateProjectSlug(input.project);
  const title = validateTitle(input.title);
  const parent = validateParent(input.parent);
  const task = validateTask(input.task);
  const role = validateRole(input.role);
  const profile = validateProfile(input.profile);
  const template = input.template === undefined || input.template === "" ? "" : validateTemplateName(input.template);
  if (template && profile) throw new OrgValidationError("A template carries its own profile.");
  const nodes = !upstream();
  if (!nodes && (template || role !== "worker" || parent !== "root")) {
    throw new OrgValidationError("herdr-projects starts only top-level threads; coordinators, nesting and templates need Herdr Organizations.");
  }
  // `--flag=value` keeps a title that starts with a hyphen from reading as a flag.
  const fields = [`--title=${title}`, ...(profile ? [`--profile=${profile}`] : [])];
  const argv = nodes
    ? ["node", "start", project, ...(template ? [`--template=${template}`] : [`--role=${role}`]), `--parent=${parent}`, ...fields, "--task-file", "-"]
    : ["thread", "start", project, ...fields, "--task-file", "-"];
  const result = await run(argv, { stdin: task, env: { HERDR_SOCKET_PATH: socketPath }, timeoutMs: 30_000 });
  if (result.code !== 0) throw commandError(result);

  const value = parseJson(result.stdout, argv.slice(0, 2).join(" "));
  if (!isRecord(value) || typeof value.id !== "string" || !NODE_ID_RE.test(value.id)) {
    throw new OrgCliError("herdr-organizations returned an invalid start response.");
  }
  return { id: value.id };
}

/**
 * `open`: start the project's coordinator in the project's workspace of this Herdr session, or focus
 * it when one already runs. The bridge has no terminal, so it never starts in the bridge's own pane.
 */
export async function openProject(run: OrgRun, socketPath: string, input: { project: unknown }): Promise<void> {
  const project = validateProjectSlug(input.project);
  const result = await run(["open", project], { env: { HERDR_SOCKET_PATH: socketPath }, timeoutMs: 60_000 });
  if (result.code !== 0) throw commandError(result);
}

export async function resolveNode(
  run: OrgRun,
  socketPath: string,
  input: { project: unknown; id: unknown },
  upstream: () => boolean = upstreamOnly,
): Promise<void> {
  const project = validateProjectSlug(input.project);
  const id = validateNodeId(input.id);
  // Upstream closes a thread with `thread resolve`; --keep-worktree keeps the branch and worktree
  // the close dialog promises to keep.
  const argv = upstream() ? ["thread", "resolve", project, id, "--keep-worktree"] : ["node", "resolve", project, id, "--close-view"];
  const result = await run(argv, {
    env: { HERDR_SOCKET_PATH: socketPath },
    timeoutMs: 30_000,
  });
  if (result.code !== 0) throw commandError(result);
}

// ── The `--json` contract (Organizations docs/json.md, schema_version 1) ─────────────────────────

const SCHEMA_VERSION = 1;

export interface OrgOverviewPullRequest {
  url: string;
  state: string;
  review: string;
  checks: { passed: number; pending: number; failed: number } | null;
  additions: number | null;
  deletions: number | null;
  failing: string[];
  comment_count: number | null;
  draft: boolean | null;
  mergeable: string | null;
  merge_blocker: string | null;
}

export interface OrgOverviewThread {
  id: string;
  title: string;
  parent_id: string;
  role: "worker" | "coordinator";
  status: string;
  group: string;
  group_label: string;
  note: string;
  branch: string;
  workspace_id: string;
  tab_id: string;
  pane_id: string;
  cwd: string;
  updated: string;
  report_unacked: boolean;
  /** Present only when Organizations has PR actions (`thread merge`, `thread set`). */
  auto_fix_ci?: boolean;
  auto_merge?: boolean;
  pr: OrgOverviewPullRequest | null;
}

export interface OrgOverviewProject {
  slug: string;
  name: string;
  goal: string;
  status: "active" | "paused" | "archived";
  threads: OrgOverviewThread[];
}

/**
 * Every non-archived project with its threads, from `overview --json`. Undefined when this
 * Organizations has no contract (missing binary, no `--json`, another schema version): the caller
 * then falls back to the files and shows no numbers.
 */
export async function readOverview(run: OrgRun, root: string): Promise<OrgOverviewProject[] | undefined> {
  const result = await run(["overview", "--json"], { env: { HERDR_PROJECTS_ROOT: root }, timeoutMs: 10_000 });
  if (result.code !== 0) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    return undefined;
  }
  if (!isRecord(value) || value.schema_version !== SCHEMA_VERSION || !Array.isArray(value.projects)) return undefined;
  return value.projects.flatMap((item) => {
    const project = parseProject(item);
    return project ? [project] : [];
  });
}

function parseProject(value: unknown): OrgOverviewProject | undefined {
  if (
    !isRecord(value) || typeof value.slug !== "string" || !SLUG_RE.test(value.slug) ||
    typeof value.name !== "string" || typeof value.goal !== "string" ||
    (value.status !== "active" && value.status !== "paused" && value.status !== "archived") ||
    !Array.isArray(value.threads)
  ) return undefined;
  return {
    slug: value.slug,
    name: value.name,
    goal: value.goal,
    status: value.status,
    threads: value.threads.flatMap((item) => {
      const thread = parseThread(item);
      return thread ? [thread] : [];
    }),
  };
}

function parseThread(value: unknown): OrgOverviewThread | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || !NODE_ID_RE.test(value.id)) return undefined;
  const text = (key: string) => typeof value[key] === "string" ? value[key] : "";
  const pr = value.pr === null || value.pr === undefined ? null : parsePullRequest(value.pr);
  if (pr === undefined) return undefined;
  return {
    id: value.id,
    title: text("title"),
    parent_id: text("parent_id"),
    role: value.role === "coordinator" ? "coordinator" : "worker",
    status: text("status"),
    group: text("group"),
    group_label: text("group_label"),
    note: text("note"),
    branch: text("branch"),
    workspace_id: text("workspace_id"),
    tab_id: text("tab_id"),
    pane_id: text("pane_id"),
    cwd: text("cwd"),
    updated: text("updated"),
    report_unacked: value.report_unacked === true,
    ...(typeof value.auto_fix_ci === "boolean" ? { auto_fix_ci: value.auto_fix_ci } : {}),
    ...(typeof value.auto_merge === "boolean" ? { auto_merge: value.auto_merge } : {}),
    pr,
  };
}

/** A malformed PR drops the whole thread rather than showing a half-read one. */
function parsePullRequest(value: unknown): OrgOverviewPullRequest | undefined {
  if (!isRecord(value) || typeof value.url !== "string") return undefined;
  const count = (key: string) => isCharCount(value[key]) ? value[key] : null;
  const checks = value.checks;
  return {
    url: value.url,
    state: typeof value.state === "string" ? value.state : "",
    review: typeof value.review === "string" ? value.review : "",
    checks: isRecord(checks) && isCharCount(checks.passed) && isCharCount(checks.pending) && isCharCount(checks.failed)
      ? { passed: checks.passed, pending: checks.pending, failed: checks.failed }
      : null,
    additions: count("additions"),
    deletions: count("deletions"),
    failing: Array.isArray(value.failing) ? value.failing.filter((name): name is string => typeof name === "string") : [],
    comment_count: count("comment_count"),
    draft: typeof value.draft === "boolean" ? value.draft : null,
    mergeable: typeof value.mergeable === "string" ? value.mergeable : null,
    merge_blocker: typeof value.merge_blocker === "string" ? value.merge_blocker : null,
  };
}

// ── Writes. Each argv is built only from validated values; the client never supplies a flag. ──

export const MERGE_METHODS = ["squash", "merge", "rebase"] as const;
export type MergeMethod = typeof MERGE_METHODS[number];

export function validateGoal(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new OrgValidationError("Goal must be text.");
  const goal = value.trim();
  if (Array.from(goal).length > 500) throw new OrgValidationError("Goal must be 500 characters or fewer.");
  if (/[\r\n]/.test(goal)) throw new OrgValidationError("Goal cannot contain line breaks.");
  return goal;
}

/** A local repository folder. A remote `PATH@MACHINE` is left to the terminal. */
export function validateRepo(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new OrgValidationError("Repository must be a path.");
  const repo = value.trim();
  if (!repo) return "";
  if (!repo.startsWith("/") || /[\r\n\0@]/.test(repo) || repo.length > 1024) {
    throw new OrgValidationError("Repository must be an absolute local path.");
  }
  return repo;
}

export function validateMergeMethod(value: unknown): MergeMethod {
  if (value === undefined) return "squash";
  const method = MERGE_METHODS.find((candidate) => candidate === value);
  if (!method) throw new OrgValidationError("Merge method must be squash, merge or rebase.");
  return method;
}

export async function createProject(
  run: OrgRun,
  input: { name: unknown; goal?: unknown; repo?: unknown },
): Promise<{ slug: string; name: string }> {
  const name = validateTitle(input.name);
  const goal = validateGoal(input.goal);
  const repo = validateRepo(input.repo);
  // `--flag=value` and the `--` before the name keep a leading hyphen from reading as a flag.
  const argv = ["new", ...(goal ? [`--goal=${goal}`] : []), ...(repo ? [`--repo=${repo}`] : []), "--json", "--", name];
  const result = await run(argv, { timeoutMs: 30_000 });
  if (result.code !== 0) throw commandError(result);
  const value = parseJson(result.stdout, "new");
  const project = isRecord(value) && value.schema_version === SCHEMA_VERSION ? value.project : undefined;
  if (!isRecord(project) || typeof project.slug !== "string" || !SLUG_RE.test(project.slug) || typeof project.name !== "string") {
    throw new OrgCliError("herdr-organizations returned an invalid new project response.");
  }
  return { slug: project.slug, name: project.name };
}

/** `thread merge`: Organizations re-reads the PR and refuses unless approved with every check green. */
export async function mergeThread(
  run: OrgRun,
  input: { project: unknown; id: unknown; method?: unknown },
): Promise<{ id: string; pr: string }> {
  const project = validateProjectSlug(input.project);
  const id = validateNodeId(input.id);
  const method = validateMergeMethod(input.method);
  const result = await run(["thread", "merge", project, id, `--method=${method}`, "--json"], { timeoutMs: 90_000 });
  if (result.code !== 0) throw commandError(result);
  const value = parseJson(result.stdout, "thread merge");
  if (!isRecord(value) || value.schema_version !== SCHEMA_VERSION || value.id !== id || value.merged !== true || typeof value.pr !== "string") {
    throw new OrgCliError("herdr-organizations returned an invalid merge response.");
  }
  return { id, pr: value.pr };
}

/** `thread set`: turn Auto-fix CI or Auto-merge on or off. At least one flag is required. */
export async function setThreadFlags(
  run: OrgRun,
  input: { project: unknown; id: unknown; autoFixCi?: unknown; autoMerge?: unknown },
): Promise<{ id: string; autoFixCi: boolean; autoMerge: boolean }> {
  const project = validateProjectSlug(input.project);
  const id = validateNodeId(input.id);
  const flags: string[] = [];
  for (const [flag, value] of [["--auto-fix-ci", input.autoFixCi], ["--auto-merge", input.autoMerge]] as const) {
    if (value === undefined) continue;
    if (typeof value !== "boolean") throw new OrgValidationError("Automation flags must be true or false.");
    flags.push(`${flag}=${value ? "on" : "off"}`);
  }
  if (!flags.length) throw new OrgValidationError("Name at least one automation flag.");
  const result = await run(["thread", "set", project, id, ...flags, "--json"], { timeoutMs: 15_000 });
  if (result.code !== 0) throw commandError(result);
  const value = parseJson(result.stdout, "thread set");
  if (!isRecord(value) || value.schema_version !== SCHEMA_VERSION || value.id !== id ||
      typeof value.auto_fix_ci !== "boolean" || typeof value.auto_merge !== "boolean") {
    throw new OrgCliError("herdr-organizations returned an invalid thread set response.");
  }
  return { id, autoFixCi: value.auto_fix_ci, autoMerge: value.auto_merge };
}

function validateSlug(value: unknown, label: string): string {
  if (typeof value !== "string" || !SLUG_RE.test(value)) {
    throw new OrgValidationError(`${label} must use lowercase letters, numbers, and hyphens.`);
  }
  return value;
}

function parseTemplate(value: unknown): TemplateView | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.name !== "string" || !SLUG_RE.test(value.name) ||
    (value.scope !== "global" && value.scope !== "project") ||
    (typeof value.project !== "string" && value.project !== null) ||
    typeof value.description !== "string" ||
    (value.role !== "worker" && value.role !== "coordinator") ||
    typeof value.can_spawn !== "boolean" ||
    typeof value.harness !== "string" ||
    typeof value.model !== "string" ||
    typeof value.reasoning_effort !== "string" ||
    !isCharCount(value.rules_chars) ||
    !isCharCount(value.memory_chars) ||
    typeof value.permission_profile !== "string" ||
    typeof value.updated !== "string" ||
    typeof value.dir !== "string"
  ) return undefined;

  return {
    name: value.name,
    scope: value.scope,
    description: value.description,
    role: value.role,
    canSpawn: value.can_spawn,
    harness: value.harness,
    model: value.model,
    reasoningEffort: value.reasoning_effort,
    rulesChars: value.rules_chars,
    memoryChars: value.memory_chars,
    updated: value.updated,
  };
}

function isCharCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string, action: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new OrgCliError(`herdr-organizations returned invalid JSON for ${action}.`);
  }
}

function commandError(result: { code: number; stderr: string }): OrgCliError {
  const detail = result.stderr.trim().slice(0, 300);
  return new OrgCliError(`herdr-organizations failed (${result.code})${detail ? `: ${detail}` : "."}`);
}
