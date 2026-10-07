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

export interface Launch {
  kind: LaunchAgent;
  permission: string;
}

function permissionFlags(kind: LaunchAgent, permission: unknown): readonly string[] | null {
  const table: Record<string, readonly string[]> = PERMISSION_ARGS[kind];
  return typeof permission === "string" && Object.hasOwn(table, permission) ? table[permission]! : null;
}

/** The body's agent and permission choice, or null for anything outside the table. */
export function launchAgent(value: unknown): Launch | null {
  if (typeof value !== "object" || value === null || !("agent" in value)) return null;
  const kind = value.agent;
  if (kind !== "codex" && kind !== "claude") return null;
  const permission = "permission" in value && value.permission !== undefined ? value.permission : "ask";
  return permissionFlags(kind, permission) ? { kind, permission: permission as string } : null;
}

/** Herdr checks the foreground process atomically; a shell snapshot alone cannot authorize typing. */
export async function startPaneAgent(
  pane: AgentView | undefined,
  { kind, permission }: Launch,
  herdr: Pick<HerdrClient, "startAgent">,
): Promise<void> {
  if (!pane || pane.kind !== "shell") throw new Error("Open an empty terminal before starting an agent.");
  // Shared Codex daemon hooks can inherit another pane's context. A native runtime
  // reports this terminal's identity; the web UI reads that same runtime's journal.
  const identity = kind === "claude" ? ["--session-id", crypto.randomUUID()] : ["--no-daemon"];
  const flags = permissionFlags(kind, permission);
  if (!flags) throw new Error("Choose a listed permission level.");
  await herdr.startAgent(pane.paneId, kind, [...identity, ...flags]);
}
