import type { TemplateView } from "./types.ts";

export type OrgRun = (
  argv: string[],
  opts: { stdin?: string; env?: Record<string, string>; timeoutMs: number },
) => Promise<{ code: number; stdout: string; stderr: string }>;

export const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const NODE_ID_RE = /^t-\d{4,}$/;

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

export function defaultOrgRun(): OrgRun {
  return async (argv, opts) => {
    const configured = process.env.COLLIE_HERDR_ORGANIZATIONS_BIN?.trim();
    const binary = configured || Bun.which("herdr-organizations");
    if (!binary) throw new OrgCliError("herdr-organizations not found");

    const child = Bun.spawn([binary, ...argv], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...opts.env },
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

export async function startFromTemplate(
  run: OrgRun,
  socketPath: string,
  input: { project: string; template: string; title: string; parent: string; task: string },
): Promise<{ id: string; parentId: string; role: string; template: string }> {
  const project = validateProjectSlug(input.project);
  const template = validateTemplateName(input.template);
  const title = validateTitle(input.title);
  const parent = validateParent(input.parent);
  const task = validateTask(input.task);
  const result = await run(
    ["node", "start", project, "--template", template, "--title", title, "--parent", parent, "--task-file", "-"],
    { stdin: task, env: { HERDR_SOCKET_PATH: socketPath }, timeoutMs: 30_000 },
  );
  if (result.code !== 0) throw commandError(result);

  const value = parseJson(result.stdout, "node start");
  if (!isRecord(value) || !isNodeStartResult(value)) {
    throw new OrgCliError("herdr-organizations returned an invalid node start response.");
  }
  return { id: value.id, parentId: value.parent_id, role: value.role, template: value.template };
}

export async function resolveNode(
  run: OrgRun,
  socketPath: string,
  input: { project: string; id: string },
): Promise<void> {
  const project = validateProjectSlug(input.project);
  const id = validateNodeId(input.id);
  const result = await run(["node", "resolve", project, id, "--close-view"], {
    env: { HERDR_SOCKET_PATH: socketPath },
    timeoutMs: 30_000,
  });
  if (result.code !== 0) throw commandError(result);
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

function isNodeStartResult(value: Record<string, unknown>): value is Record<"id" | "parent_id" | "role" | "template", string> {
  return typeof value.id === "string" && NODE_ID_RE.test(value.id) &&
    typeof value.parent_id === "string" &&
    typeof value.role === "string" &&
    typeof value.template === "string";
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
