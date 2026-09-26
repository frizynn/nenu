import type { HerdrClient } from "./herdr-client.ts";
import type { AgentView } from "./types.ts";

export type LaunchAgent = "codex" | "claude";

export function launchAgent(value: unknown): LaunchAgent | null {
  if (typeof value !== "object" || value === null || !("agent" in value)) return null;
  return value.agent === "codex" || value.agent === "claude" ? value.agent : null;
}

/** Herdr checks the foreground process atomically; a shell snapshot alone cannot authorize typing. */
export async function startPaneAgent(
  pane: AgentView | undefined,
  kind: LaunchAgent,
  herdr: Pick<HerdrClient, "startAgent">,
): Promise<void> {
  if (!pane || pane.kind !== "shell") throw new Error("Open an empty terminal before starting an agent.");
  // Shared Codex daemon hooks can inherit another pane's context. A native runtime
  // reports this terminal's identity; the web UI reads that same runtime's journal.
  const args = kind === "claude" ? ["--session-id", crypto.randomUUID()] : ["--no-daemon"];
  await herdr.startAgent(pane.paneId, kind, args);
}
