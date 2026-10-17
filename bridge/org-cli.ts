import { servicePath } from "./claude-sessions.ts";
import { parseReport, parseStatusFile, parseUsage, type OrgReport, type OrgStatusFile } from "./org-report.ts";
import type { TokenUsage } from "./org-types.ts";
import { PR_ASKS, type PrAsk, type RoutineList, type RoutineView, type TemplateView } from "./types.ts";

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

/**
 * One model name, never a flag: `opus`, `gpt-5.5`, `anthropic/claude-sonnet-5`, `claude-opus-5-5[1m]`.
 * Narrower than Organizations' own check (it must start with a letter or digit), which runs after it.
 */
export const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@+[\]-]{0,127}$/;
/** A reasoning-effort level as Organizations lists them (`low`, `xhigh`, `off`). */
const EFFORT_RE = /^[a-z][a-z0-9-]{0,19}$/;

/** A model name, or "" for the harness's default. */
export function validateModel(value: unknown): string {
  if (value === undefined || value === "") return "";
  if (typeof value !== "string" || !MODEL_RE.test(value)) throw new OrgValidationError("Model must be one model name, like opus or gpt-5.5.");
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

/**
 * A project's routines from `routine list --json`, in Organizations' name order. An Organizations
 * that predates the document (it refuses `--json` or `routine`, or prints another schema) answers
 * `available: false`, so a client can say it cannot list them instead of that there are none.
 */
export async function listRoutines(run: OrgRun, project: string): Promise<RoutineList> {
  const slug = validateProjectSlug(project);
  const unavailable: RoutineList = { available: false, routines: [], broken: 0 };
  const result = await run(["routine", "list", slug, "--json"], { timeoutMs: 10_000 });
  if (result.code !== 0) {
    if (/unexpected argument|unrecognized subcommand/i.test(result.stderr)) return unavailable;
    throw commandError(result);
  }
  const value = parseJson(result.stdout, "routine list");
  if (!isRecord(value) || value.schema_version !== SCHEMA_VERSION || !Array.isArray(value.routines)) return unavailable;
  return {
    available: true,
    routines: value.routines.flatMap((item) => {
      const routine = parseRoutine(item);
      return routine ? [routine] : [];
    }),
    broken: Array.isArray(value.broken) ? value.broken.length : 0,
  };
}

/** The profiles this host can launch, by name (`profile list --names`); none when the CLI cannot say. */
export async function listProfiles(run: OrgRun): Promise<string[]> {
  const result = await run(["profile", "list", "--names"], { timeoutMs: 10_000 });
  if (result.code !== 0) return [];
  return result.stdout.split("\n").map((line) => line.trim()).filter((name) => PROFILE_RE.test(name));
}

/** A harness, model, effort and the profile they start from, as a coordinator was or will be launched. */
export interface CoordinatorLaunch { profile: string; harness: string; model: string; reasoningEffort: string }
export interface HarnessChoice { harness: string; profile: string; defaultModel: string; efforts: string[] }
export interface ProfileChoice { name: string; harness: string; model: string; reasoningEffort: string; description: string; builtin: boolean }

/**
 * What a project's coordinator can start on (`profile list --project <slug> --json`): the harnesses
 * installed, signed in and allowed, each with its effort levels and default model; the allowed
 * profiles; the project's default; the last launch. An Organizations that predates the document
 * offers its profile names only, `available: false`: it takes no harness, model or effort.
 */
export interface CoordinatorChoices {
  available: boolean;
  defaultProfile: string;
  last: CoordinatorLaunch | null;
  harnesses: HarnessChoice[];
  profiles: ProfileChoice[];
}

export async function coordinatorChoices(run: OrgRun, project: unknown): Promise<CoordinatorChoices> {
  const slug = validateProjectSlug(project);
  const result = await run(["profile", "list", "--project", slug, "--json"], { timeoutMs: 10_000 });
  if (result.code !== 0) {
    if (!/unexpected argument|unrecognized/i.test(result.stderr)) throw commandError(result);
    const names = await listProfiles(run);
    return {
      available: false, defaultProfile: "", last: null, harnesses: [],
      profiles: names.map((name) => ({ name, harness: "", model: "", reasoningEffort: "", description: "", builtin: false })),
    };
  }
  const value = parseJson(result.stdout, "profile list");
  const role = isRecord(value) && value.schema_version === SCHEMA_VERSION && isRecord(value.coordinator) ? value.coordinator : null;
  if (!role) throw new OrgCliError("herdr-organizations returned an invalid profile list.");
  const name = (field: unknown) => typeof field === "string" && PROFILE_RE.test(field) ? field : "";
  const model = (field: unknown) => typeof field === "string" && MODEL_RE.test(field) ? field : "";
  const effort = (field: unknown) => typeof field === "string" && EFFORT_RE.test(field) ? field : "";
  const last = isRecord(role.last) && name(role.last.harness)
    ? { profile: name(role.last.profile), harness: name(role.last.harness), model: model(role.last.model), reasoningEffort: effort(role.last.reasoning_effort) }
    : null;
  return {
    available: true,
    defaultProfile: name(role.default_profile),
    last,
    harnesses: (Array.isArray(role.harnesses) ? role.harnesses : []).flatMap((item) => {
      if (!isRecord(item) || !name(item.harness) || !name(item.profile)) return [];
      const efforts = Array.isArray(item.efforts) ? item.efforts.map(effort).filter(Boolean) : [];
      return [{ harness: name(item.harness), profile: name(item.profile), defaultModel: model(item.default_model), efforts }];
    }),
    profiles: (Array.isArray(role.profiles) ? role.profiles : []).flatMap((item) => {
      if (!isRecord(item) || !name(item.name)) return [];
      return [{
        name: name(item.name), harness: name(item.harness), model: model(item.model), reasoningEffort: effort(item.reasoning_effort),
        description: text(item.description).replace(/\s+/g, " ").trim().slice(0, 200), builtin: item.builtin === true,
      }];
    }),
  };
}

/** What a client may ask a coordinator to start on: a profile or a harness, a model and an effort. */
export interface LaunchInput { profile?: unknown; harness?: unknown; model?: unknown; effort?: unknown }

/**
 * The coordinator a person chose, as `open`'s and `coordinator replace`'s flags. The client names
 * a choice and never sends argv: each part is checked against what Organizations offers this
 * project, which checks it again. Nothing chosen is no flag, the project's default, and reads nothing.
 */
async function launchFlags(run: OrgRun, project: string, input: LaunchInput): Promise<string[]> {
  const profile = validateProfile(input.profile);
  if (input.harness !== undefined && (typeof input.harness !== "string" || input.harness.length > 40)) throw new OrgValidationError("Harness must be a harness name.");
  const harness = input.harness ?? "";
  const model = validateModel(input.model);
  const effort = input.effort ?? "";
  if (profile && harness) throw new OrgValidationError("Choose a profile or a harness, not both.");
  // A profile alone is what `open` always took; Organizations checks it against its allow-list.
  if (!harness && !model && !effort) return profile ? [`--profile=${profile}`] : [];

  const choices = await coordinatorChoices(run, project);
  const notOffered = (what: string, kind: string) => new OrgValidationError(`${what} is not a ${kind} this project's coordinator can run.`);
  if (!choices.available) throw new OrgValidationError("This Herdr Organizations cannot choose the harness, model or effort; update it, or choose a profile.");
  if (harness && !choices.harnesses.some((choice) => choice.harness === harness)) throw notOffered(harness, "harness");
  const chosen = profile || choices.defaultProfile;
  const kind = harness || (choices.profiles.find((choice) => choice.name === chosen)?.harness ?? "");
  if (profile && !choices.profiles.some((choice) => choice.name === profile)) throw notOffered(profile, "profile");
  if (effort) {
    // A saved profile may be allowed when its harness is not: its levels are not listed, so it keeps its own.
    const listed = choices.harnesses.find((choice) => choice.harness === kind);
    if (!listed) throw new OrgValidationError("Effort can be chosen only for a harness this project's coordinator can run.");
    if (listed.efforts.length === 0) throw new OrgValidationError(`${kind} takes no effort level.`);
    if (typeof effort !== "string" || !listed.efforts.includes(effort)) throw new OrgValidationError(`Effort must be one of ${listed.efforts.join(", ")} for ${kind}.`);
  }
  return [
    ...(profile ? [`--profile=${profile}`] : harness ? [`--harness=${harness}`] : []),
    ...(model ? [`--model=${model}`] : []),
    ...(effort ? [`--reasoning-effort=${String(effort)}`] : []),
  ];
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
): Promise<{ id: string; project: string; title: string; parent: string; role: NodeRole; profile: string; template: string }> {
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
  // A coordinator says what it is rather than lean on Organizations' defaults: it may start nodes of its
  // own and runs in a tab of the project's workspace, never a worktree. A template carries its own.
  const placement = template ? [`--template=${template}`] : role === "coordinator" ? [`--role=${role}`, "--can-spawn", "--kind=tab"] : [`--role=${role}`];
  const argv = nodes
    ? ["node", "start", project, ...placement, `--parent=${parent}`, ...fields, "--task-file", "-"]
    : ["thread", "start", project, ...fields, "--task-file", "-"];
  const result = await run(argv, { stdin: task, env: { HERDR_SOCKET_PATH: socketPath }, timeoutMs: 30_000 });
  if (result.code !== 0) throw commandError(result);

  const value = parseJson(result.stdout, argv.slice(0, 2).join(" "));
  if (!isRecord(value) || typeof value.id !== "string" || !NODE_ID_RE.test(value.id)) {
    throw new OrgCliError("herdr-organizations returned an invalid start response.");
  }
  return { id: value.id, project, title, parent, role, profile, template };
}

/**
 * `node move`: hang a node, with everything under it, under another parent: the project root or an
 * open coordinator. Organizations refuses a parent that may not start nodes and a move that would
 * loop the tree; the bridge only checks the shape of each id.
 */
export async function moveNode(
  run: OrgRun,
  socketPath: string,
  input: { project: unknown; id: unknown; parent: unknown },
): Promise<{ id: string; project: string; parent: string }> {
  const project = validateProjectSlug(input.project);
  const id = validateNodeId(input.id);
  const parent = validateParent(input.parent);
  if (parent === id) throw new OrgValidationError("A node cannot be its own parent.");
  const result = await run(["node", "move", project, id, `--parent=${parent}`, "--json"], { env: { HERDR_SOCKET_PATH: socketPath }, timeoutMs: 30_000 });
  if (result.code !== 0) throw commandError(result);
  const value = parseJson(result.stdout, "node move");
  if (!isRecord(value) || value.schema_version !== SCHEMA_VERSION || value.id !== id || value.parent_id !== parent) {
    throw new OrgCliError("herdr-organizations returned an invalid move response.");
  }
  return { id, project, parent };
}

/** Whether this Organizations has a command (`node move`, `asks answer`): its help exits 0, and one that predates it exits non-zero. */
export async function offers(run: OrgRun, command: readonly [string, string]): Promise<boolean> {
  const result = await run([...command, "--help"], { timeoutMs: 10_000 }).catch(() => null);
  return result?.code === 0;
}

/** An answer to an ask: the person's own words on one line, which Organizations writes after the ask. */
export function validateAnswer(value: unknown): string {
  if (typeof value !== "string") throw new OrgValidationError("The answer must be text.");
  const answer = value.trim();
  if (!answer) throw new OrgValidationError("Write an answer first.");
  if (Array.from(answer).length > 2_000) throw new OrgValidationError("The answer must be 2,000 characters or fewer.");
  if (/[\r\n]/.test(answer)) throw new OrgValidationError("The answer must be one line.");
  return answer;
}

/**
 * `asks answer`: write the person's answer to the ask on `line` of a coordinator's STATUS.md (`root`
 * for the project's own) and check the document Organizations prints. The answer goes on standard
 * input, never in the argv.
 */
export async function answerAsk(
  run: OrgRun,
  socketPath: string,
  input: { project: unknown; coordinator: unknown; line: unknown; text: unknown },
): Promise<{ project: string; coordinator: string; line: number; answeredAt: string }> {
  const project = validateProjectSlug(input.project);
  const coordinator = validateParent(input.coordinator);
  const line = input.line;
  if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1) throw new OrgValidationError("The ask's line must be a line number.");
  const text = validateAnswer(input.text);
  const result = await run(["asks", "answer", project, coordinator, `--line=${line}`, "--text-file", "-", "--json"],
    { stdin: text, env: { HERDR_SOCKET_PATH: socketPath }, timeoutMs: 30_000 });
  if (result.code !== 0) throw commandError(result);
  const value = parseJson(result.stdout, "asks answer");
  if (!isRecord(value) || value.schema_version !== SCHEMA_VERSION || value.project !== project || value.coordinator !== coordinator || value.line !== line
    || typeof value.answered_at !== "string") {
    throw new OrgCliError("herdr-organizations returned an invalid answer response.");
  }
  return { project, coordinator, line, answeredAt: value.answered_at };
}

/**
 * `open`: start the project's coordinator in the project's workspace of this Herdr session, on the
 * chosen harness, model and effort or the project's default, or focus it when one already runs. The
 * bridge has no terminal, so it never starts in the bridge's own pane. Returns the CLI's first line,
 * which says what happened ("started …", or "… is not ready yet …" when the agent waits on a
 * dialog); `open` exits 0 in both cases.
 */
export async function openProject(run: OrgRun, socketPath: string, input: { project: unknown } & LaunchInput): Promise<{ message: string }> {
  const project = validateProjectSlug(input.project);
  const flags = await launchFlags(run, project, input);
  const result = await run(["open", project, ...flags], { env: { HERDR_SOCKET_PATH: socketPath }, timeoutMs: 60_000 });
  if (result.code !== 0) throw commandError(result);
  const first = result.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  return { message: first.slice(0, 300) };
}

/**
 * `coordinator replace`: stop the project's running coordinator and start a new one on the chosen
 * profile or harness, model and effort, in the session its record names or this Herdr session.
 * Returns the CLI's line saying what it did.
 */
export async function replaceCoordinator(run: OrgRun, socketPath: string, input: { project: unknown } & LaunchInput): Promise<{ message: string }> {
  const project = validateProjectSlug(input.project);
  if (!validateProfile(input.profile) && (input.harness === undefined || input.harness === "")) {
    throw new OrgValidationError("Choose the agent the new coordinator runs on.");
  }
  const flags = await launchFlags(run, project, input);
  const result = await run(["coordinator", "replace", project, ...flags], { env: { HERDR_SOCKET_PATH: socketPath }, timeoutMs: 60_000 });
  if (result.code !== 0) throw commandError(result);
  const first = result.stdout.split("\n").map((line) => line.trim()).find(Boolean) ?? "";
  return { message: first.slice(0, 300) };
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
/** The activity an agent reports when it stops for the person (Organizations' `progress::WAITING`). */
export const WAITING_ACTIVITY = "Waiting for you";

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
  /** Absent from an Organizations that predates them. */
  actions?: string[];
}

/** A thread as `overview --json` prints it, with its report's fields (org-report.ts). */
export interface OrgOverviewThread extends OrgReport {
  id: string;
  title: string;
  parent_id: string;
  role: "worker" | "coordinator";
  status: string;
  group: string;
  group_label: string;
  note: string;
  /** The agent's own last activity (`report --activity`); empty without one. */
  activity: string;
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
  /** What a client may ask of the thread itself (`create-pr`); absent from an Organizations that predates it. */
  actions?: string[];
  usage: TokenUsage | null;
}

/** The agent states Herdr reports, as the ticker records the project coordinator's. */
const COORDINATOR_STATES = ["working", "blocked", "idle", "done"] as const;

/** The project's coordinator as the ticker last saw its pane; `state` is empty before it looked, or for a state this Nenu does not know. */
export interface OrgCoordinator {
  agent: string;
  model: string;
  state: typeof COORDINATOR_STATES[number] | "";
}

export interface OrgOverviewProject {
  slug: string;
  name: string;
  goal: string;
  status: "active" | "paused" | "archived";
  /** The glyph and colour names picked with `set <slug> icon|tone`; empty when none was, or the name is malformed. */
  icon: string;
  tone: string;
  /** The project coordinator's STATUS.md, as a thread's. */
  status_file: OrgStatusFile | null;
  /** The project coordinator's token use and how it was started; null from an Organizations that predates them, or a project never opened. */
  usage: TokenUsage | null;
  coordinator: OrgCoordinator | null;
  threads: OrgOverviewThread[];
}

/** A picked icon or tone name: Organizations validates it as it does a slug, so anything else reads as no pick. */
export function pickName(value: unknown): string {
  return typeof value === "string" && SLUG_RE.test(value) ? value : "";
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
    icon: pickName(value.icon),
    tone: pickName(value.tone),
    status_file: parseStatusFile(value.status_file),
    usage: parseUsage(value.usage),
    coordinator: parseCoordinator(value.coordinator),
    threads: value.threads.flatMap((item) => {
      const thread = parseThread(item);
      return thread ? [thread] : [];
    }),
  };
}

function parseCoordinator(value: unknown): OrgCoordinator | null {
  if (!isRecord(value)) return null;
  const { agent, model, state } = value;
  return { agent: text(agent), model: text(model), state: COORDINATOR_STATES.find((known) => known === state) ?? "" };
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
    activity: text("activity"),
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
    ...parseActions(value.actions),
    ...parseReport(value),
    usage: parseUsage(value.usage),
  };
}

function parseActions(value: unknown): { actions?: string[] } {
  return Array.isArray(value) ? { actions: value.filter((action): action is string => typeof action === "string") } : {};
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
    ...parseActions(value.actions),
  };
}

// ── Writes. Each argv is built only from validated values; the client never supplies a flag. ──

// ── The project's own documents: `task list`, `project show`, `routine list` (docs/json.md) ─────
//
// The desk's Project panel reads them, one per view and only while that view is on screen
// (`/api/org/tasks`, `/api/org/context`). Each reader answers null, never an error, when this
// Organizations has no such document (an older binary, another schema version, a failed run): the
// panel then shows what the overview already says. Only the fields the panel draws are copied.

export interface OrgTask {
  /** The `## ` heading above the task in TASKS.md, empty above the first. */
  list: string;
  title: string;
  owner: { kind: "unassigned" | "me" | "agent" | "person"; profile: string; machine: string; name: string };
  /** The thread running it, empty when none. */
  thread: string;
  description: string;
}

export interface OrgProjectDetail {
  /** PROJECT.md after its settings: what every thread is told. */
  instructions: string;
  memory: string;
  memoryFiles: Array<{ name: string; text: string }>;
  /** `machine` is empty for this machine. */
  repos: Array<{ path: string; machine: string }>;
  coordinatorProfile: string;
  threadProfile: string;
  maxParallelThreads: number;
}

export interface OrgRoutine {
  name: string;
  trigger: "schedule" | "pr";
  /** As written (`daily 03:00`); empty for `pr`. */
  schedule: string;
  /** For `pr`, the pull request events it fires on. */
  events: string[];
  enabled: boolean;
  /** RFC 3339, empty for `pr` and a disabled routine. */
  nextRun: string;
}

const OWNER_KINDS = new Set(["unassigned", "me", "agent", "person"]);

/** One `--json` document about one project, or null when this Organizations cannot give it. */
async function readProjectDocument(run: OrgRun, root: string, argv: string[]): Promise<Record<string, unknown> | null> {
  const result = await run(argv, { env: { HERDR_PROJECTS_ROOT: root }, timeoutMs: 10_000 });
  if (result.code !== 0) return null;
  try {
    const value: unknown = JSON.parse(result.stdout);
    return isRecord(value) && value.schema_version === SCHEMA_VERSION ? value : null;
  } catch {
    return null;
  }
}

/** `task list --json`: TASKS.md in file order. Only the coordinator writes it; Nenu asks it. */
export async function readTasks(run: OrgRun, root: string, project: string): Promise<OrgTask[] | null> {
  const slug = validateProjectSlug(project);
  const value = await readProjectDocument(run, root, ["task", "list", slug, "--json"]);
  if (!value || !Array.isArray(value.tasks)) return null;
  return value.tasks.flatMap((item): OrgTask[] => {
    const owner = isRecord(item) ? parseOwner(item.owner) : null;
    if (!isRecord(item) || !owner || typeof item.title !== "string") return [];
    return [{ list: text(item.list), title: item.title, thread: text(item.thread), description: text(item.description), owner }];
  });
}

/** A task's owner; null when it is not one, or of a kind this Nenu does not know. */
function parseOwner(value: unknown): OrgTask["owner"] | null {
  if (!isRecord(value) || typeof value.kind !== "string" || !OWNER_KINDS.has(value.kind)) return null;
  return { kind: value.kind as OrgTask["owner"]["kind"], profile: text(value.profile), machine: text(value.machine), name: text(value.name) };
}

/** `project show --json`: what every thread receives, and where the project's threads work. */
export async function readProjectDetail(run: OrgRun, root: string, project: string): Promise<OrgProjectDetail | null> {
  const slug = validateProjectSlug(project);
  const value = await readProjectDocument(run, root, ["project", "show", slug, "--json"]);
  const detail = value?.project;
  if (!isRecord(detail) || typeof detail.instructions !== "string") return null;
  const records = (list: unknown) => Array.isArray(list) ? list.filter(isRecord) : [];
  return {
    instructions: detail.instructions,
    memory: text(detail.memory),
    memoryFiles: records(detail.memory_files).flatMap((file) => typeof file.name === "string" && typeof file.text === "string" ? [{ name: file.name, text: file.text }] : []),
    repos: records(detail.repos).flatMap((repo) => typeof repo.path === "string" ? [{ path: repo.path, machine: text(repo.machine) }] : []),
    coordinatorProfile: text(detail.coordinator_profile),
    threadProfile: text(detail.thread_profile),
    maxParallelThreads: isCharCount(detail.max_parallel_threads) ? detail.max_parallel_threads : 0,
  };
}

/** `routine list --json`: what the coordinator does on a schedule or on a pull request's events. */
export async function readRoutines(run: OrgRun, root: string, project: string): Promise<OrgRoutine[] | null> {
  const slug = validateProjectSlug(project);
  const value = await readProjectDocument(run, root, ["routine", "list", slug, "--json"]);
  if (!value || !Array.isArray(value.routines)) return null;
  return value.routines.flatMap((item): OrgRoutine[] => {
    if (!isRecord(item) || typeof item.name !== "string" || (item.trigger !== "schedule" && item.trigger !== "pr") || typeof item.enabled !== "boolean") return [];
    const events = Array.isArray(item.events) ? item.events.filter((event): event is string => typeof event === "string") : [];
    return [{ name: item.name, trigger: item.trigger, schedule: text(item.schedule), events, enabled: item.enabled, nextRun: text(item.next_run) }];
  });
}

// ── `project status`: the project's work in one document, for Notes (docs/json.md, Project status) ──

const STATUS_STATES = ["waiting", "working", "review", "landing", "idle", "todo", "done"] as const;
export type OrgStatusState = typeof STATUS_STATES[number];

function isStatusState(value: unknown): value is OrgStatusState {
  return STATUS_STATES.some((state) => state === value);
}

export interface OrgStatusItem {
  kind: "task" | "thread";
  /** `task:<line>` (moves when lines above it do) or the thread's id. */
  id: string;
  title: string;
  state: OrgStatusState;
  /** A task's owner; null for a thread, or an owner of a kind this Nenu does not know. */
  owner: OrgTask["owner"] | null;
  /** The thread running it, empty when none. */
  thread: string;
}

/** One drift problem, as `context` lists it: `line` 0 and no `task` for the handoff. */
export interface OrgProblem {
  rule: string;
  line: number;
  task: string;
  thread: string;
  detail: string;
}

export interface OrgStatus {
  items: OrgStatusItem[];
  problems: OrgProblem[];
}

/**
 * `project status --json`. Unlike the documents above it tells "this Organizations has no such
 * command" (null, so Notes falls back to the task list without an error) from "the command failed"
 * (thrown). Items of a kind or state this Nenu does not know are skipped, as the contract asks.
 */
export async function readStatus(run: OrgRun, root: string, project: string): Promise<OrgStatus | null> {
  const slug = validateProjectSlug(project);
  const result = await run(["project", "status", slug, "--json"], { env: { HERDR_PROJECTS_ROOT: root }, timeoutMs: 10_000 });
  if (result.code !== 0) {
    if (/unexpected argument|unrecognized subcommand/i.test(result.stderr)) return null;
    throw commandError(result);
  }
  const value = parseJson(result.stdout, "project status");
  if (!isRecord(value) || value.schema_version !== SCHEMA_VERSION) return null;
  if (!Array.isArray(value.items) || !Array.isArray(value.problems)) throw new OrgCliError("herdr-organizations returned an invalid project status.");
  return {
    items: value.items.flatMap((item): OrgStatusItem[] => {
      if (!isRecord(item) || (item.kind !== "task" && item.kind !== "thread") || !isStatusState(item.state)) return [];
      if (typeof item.id !== "string" || typeof item.title !== "string") return [];
      return [{ kind: item.kind, id: item.id, title: item.title, state: item.state, owner: parseOwner(item.owner), thread: text(item.thread) }];
    }),
    problems: value.problems.flatMap((problem): OrgProblem[] => isRecord(problem) && typeof problem.rule === "string" && typeof problem.detail === "string"
      ? [{ rule: problem.rule, line: isCharCount(problem.line) ? problem.line : 0, task: text(problem.task), thread: text(problem.thread), detail: problem.detail }]
      : []),
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

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

/** Merge and Create PR have their own commands; `thread pr-action` takes only the requests. */
export function validatePrAsk(value: unknown): PrAsk {
  const action = PR_ASKS.find((candidate) => candidate === value);
  if (!action) throw new OrgValidationError("Action must be resolve-conflicts, fix-ci or address-comments.");
  return action;
}

/**
 * `thread pr-action`: Organizations reads the PR again and sends the thread's agent a message it
 * writes itself. `sent: false` means someone had already asked about this state of the PR.
 */
export async function prAction(
  run: OrgRun,
  input: { project: unknown; id: unknown; action: unknown },
): Promise<{ id: string; action: PrAsk; pr: string; sent: boolean; reason: string }> {
  const project = validateProjectSlug(input.project);
  const id = validateNodeId(input.id);
  const action = validatePrAsk(input.action);
  const value = await prCommand(run, ["thread", "pr-action", project, id, action, "--json"], "pr-action");
  if (value.id !== id || value.action !== action || typeof value.pr !== "string" || typeof value.sent !== "boolean" || typeof value.reason !== "string") {
    throw new OrgCliError("herdr-organizations returned an invalid pr-action response.");
  }
  return { id, action, pr: value.pr, sent: value.sent, reason: value.reason };
}

/** `thread pr-create`: open the PR of a thread that pushed its branch without one. */
export async function prCreate(run: OrgRun, input: { project: unknown; id: unknown }): Promise<{ id: string; pr: string }> {
  const project = validateProjectSlug(input.project);
  const id = validateNodeId(input.id);
  const value = await prCommand(run, ["thread", "pr-create", project, id, "--json"], "pr-create");
  if (value.id !== id || typeof value.pr !== "string" || !value.pr) throw new OrgCliError("herdr-organizations returned an invalid pr-create response.");
  return { id, pr: value.pr };
}

/**
 * A PR command's `ok: true` document. Its refusal prints the document with `ok: false` and exits 1;
 * the reason is then the error, word for word. Anything else that fails is the CLI's failure.
 * Both read the PR with `gh` first, as `thread merge` does, so they get its time.
 */
async function prCommand(run: OrgRun, argv: string[], name: string): Promise<Record<string, unknown>> {
  const result = await run(argv, { timeoutMs: 90_000 });
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    value = undefined;
  }
  const document = isRecord(value) && value.schema_version === SCHEMA_VERSION ? value : undefined;
  if (document?.ok === false && typeof document.reason === "string" && document.reason) throw new OrgValidationError(document.reason);
  if (result.code !== 0) throw commandError(result);
  if (document?.ok !== true) throw new OrgCliError(`herdr-organizations returned an invalid ${name} response.`);
  return document;
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

function parseRoutine(value: unknown): RoutineView | undefined {
  if (
    !isRecord(value) || typeof value.name !== "string" || (value.trigger !== "schedule" && value.trigger !== "pr") ||
    typeof value.enabled !== "boolean"
  ) return undefined;
  const text = (key: string) => typeof value[key] === "string" ? value[key] : "";
  return {
    name: value.name,
    trigger: value.trigger,
    schedule: text("schedule"),
    events: Array.isArray(value.events) ? value.events.filter((event): event is string => typeof event === "string") : [],
    enabled: value.enabled,
    lastRun: text("last_run"),
    nextRun: text("next_run"),
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
