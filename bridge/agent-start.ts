import type { HerdrClient } from "./herdr-client.ts";
import type { AgentView } from "./types.ts";

export type LaunchAgent = "codex" | "claude";

// How much the new agent may do without asking. The client names a choice; only this table turns it
// into argv, so nothing the client sends ever reaches the command line. Flags as printed by
// `claude --help` (2.1) and `codex --help` (0.160); "ask" adds nothing and leaves each CLI's own
// configured default in charge.
const PERMISSION_ARGS = {
  claude: {
    ask: [],
    auto: ["--permission-mode", "auto"],
    acceptEdits: ["--permission-mode", "acceptEdits"],
    plan: ["--permission-mode", "plan"],
    bypass: ["--dangerously-skip-permissions"],
  },
  codex: {
    ask: [],
    auto: ["--sandbox", "workspace-write", "--ask-for-approval", "never"],
    full: ["--dangerously-bypass-approvals-and-sandbox"],
  },
} as const satisfies Record<LaunchAgent, Record<string, readonly string[]>>;

/** A model a new agent may start on: `id` is what `--model` receives, "default" adds nothing. */
export interface StartModel {
  id: string;
  label: string;
  hint: string;
}
export type StartModels = Record<LaunchAgent, readonly StartModel[]>;

const DEFAULT_MODEL: StartModel = { id: "default", label: "Default", hint: "The agent's own default for your account" };

// Claude Code's `--model` aliases, as its model configuration page lists them (checked 2026-10-27
// against Claude Code 2.1.311). Aliases follow the newest model of each family, so the table ages
// only when the CLI adds or drops an alias.
export const CLAUDE_MODELS: readonly StartModel[] = [
  DEFAULT_MODEL,
  { id: "best", label: "Best", hint: "Fable where your account has it, else Opus" },
  { id: "fable", label: "Fable", hint: "For the hardest and longest-running tasks" },
  { id: "opus", label: "Opus", hint: "The latest Opus, for complex reasoning" },
  { id: "sonnet", label: "Sonnet", hint: "The latest Sonnet, for daily coding" },
  { id: "haiku", label: "Haiku", hint: "Fast and efficient, for simple tasks" },
  { id: "opusplan", label: "Opus Plan", hint: "Opus while planning, Sonnet to carry it out" },
  { id: "opus[1m]", label: "Opus 1M", hint: "Opus with a 1 million token context window" },
  { id: "sonnet[1m]", label: "Sonnet 1M", hint: "Sonnet with a 1 million token context window" },
];

// Codex names models by slug and its list changes often: Codex's own `models_cache.json` is read
// first (models.ts), and these slugs, from the Codex models page on 2026-10-27, stand in where Codex
// has not written one yet.
export const CODEX_DOC_MODELS: readonly StartModel[] = [
  { id: "gpt-6-astra", label: "gpt-6-astra", hint: "For the most demanding workflows" },
  { id: "gpt-6.1-sol", label: "gpt-6.1-sol", hint: "" },
  { id: "gpt-6.1-terra", label: "gpt-6.1-terra", hint: "Needs Codex CLI 0.159.0 or later" },
  { id: "gpt-6-luna", label: "gpt-6-luna", hint: "" },
];

/** The models a start may name: each agent's default first, then its list. */
export function startModels(codex: ReadonlyArray<{ name: string; description: string }>): StartModels {
  const listed = codex.length ? codex.map((m) => ({ id: m.name, label: m.name, hint: m.description })) : CODEX_DOC_MODELS;
  return { claude: CLAUDE_MODELS, codex: [DEFAULT_MODEL, ...listed] };
}

export interface Launch {
  kind: LaunchAgent;
  permission: string;
  /** A {@link StartModels} id for this agent, already checked against the list. */
  model: string;
}

function permissionFlags(kind: LaunchAgent, permission: unknown): readonly string[] | null {
  const table: Record<string, readonly string[]> = PERMISSION_ARGS[kind];
  return typeof permission === "string" && Object.hasOwn(table, permission) ? table[permission]! : null;
}

function modelFlags(kind: LaunchAgent, model: string, models: StartModels): readonly string[] | null {
  if (!models[kind].some((m) => m.id === model)) return null;
  return model === DEFAULT_MODEL.id ? [] : ["--model", model];
}

/** The body's agent, permission and model, or null for anything outside the tables. */
export function launchAgent(value: unknown, models: StartModels): Launch | null {
  if (typeof value !== "object" || value === null || !("agent" in value)) return null;
  const kind = value.agent;
  if (kind !== "codex" && kind !== "claude") return null;
  const permission = "permission" in value && value.permission !== undefined ? value.permission : "ask";
  const model = "model" in value && value.model !== undefined ? value.model : DEFAULT_MODEL.id;
  if (!permissionFlags(kind, permission) || typeof model !== "string" || !modelFlags(kind, model, models)) return null;
  return { kind, permission: permission as string, model };
}

/** Herdr checks the foreground process atomically; a shell snapshot alone cannot authorize typing. */
export async function startPaneAgent(
  pane: AgentView | undefined,
  { kind, permission, model }: Launch,
  models: StartModels,
  herdr: Pick<HerdrClient, "startAgent">,
): Promise<void> {
  if (!pane || pane.kind !== "shell") throw new Error("Open an empty terminal before starting an agent.");
  // Shared Codex daemon hooks can inherit another pane's context. A native runtime
  // reports this terminal's identity; the web UI reads that same runtime's journal.
  const identity = kind === "claude" ? ["--session-id", crypto.randomUUID()] : ["--no-daemon"];
  const flags = permissionFlags(kind, permission);
  if (!flags) throw new Error("Choose a listed permission level.");
  const named = modelFlags(kind, model, models);
  if (!named) throw new Error("Choose a listed model.");
  await herdr.startAgent(pane.paneId, kind, [...identity, ...flags, ...named]);
}
