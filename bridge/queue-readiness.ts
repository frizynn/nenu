import { hasCodexInterruptCue } from "../web/src/lib/harness/codex/interrupt.ts";
import type { AgentView, DeliveryMode, QueueWaitReason } from "./types.ts";
import type { HerdrClient } from "./herdr-client.ts";
import { adapterFor } from "../web/src/lib/harness/index.ts";
import { parseAnsi } from "../web/src/lib/ansi.ts";
import { splitLines } from "../web/src/lib/blocks.ts";
import { hasNativeNextTurnQueue } from "./queue-native.ts";

/** Ready to type now, and whether a turn is running (it picks Codex's next-turn key). */
export type Readiness = { ready: true; busy: boolean } | { ready: false; reason: QueueWaitReason };

/**
 * Whether a row in `mode` may be typed into the pane now (ADR 0056). Every mode needs the input box
 * on screen, free of dialogs and of a draft the operator is typing at the terminal; that is read
 * from the screen whatever Herdr's status says. Only `afterTurn` also waits for the turn to end,
 * unless the CLI keeps a next-turn queue of its own.
 */
export async function queueReadiness(
  pane: Pick<AgentView, "paneId" | "agent" | "status">,
  herdr: Pick<HerdrClient, "readPane">,
  mode: DeliveryMode,
): Promise<Readiness> {
  const adapter = adapterFor(pane.agent);
  if (!adapter?.composerReady) return { ready: false, reason: "disconnected" };
  if (!["idle", "done", "working", "blocked"].includes(pane.status)) return { ready: false, reason: "disconnected" };
  const holdsForTurn = mode === "afterTurn" && !hasNativeNextTurnQueue(pane.agent);
  if (holdsForTurn && pane.status === "working") return { ready: false, reason: "working" };
  const { text } = await herdr.readPane(pane.paneId, "visible", 100, "ansi");
  // Codex reports `blocked` while it repaints a running turn; its interrupt cue says the turn runs.
  const busy = pane.status === "working" || (pane.agent === "codex" && hasCodexInterruptCue(text));
  if (holdsForTurn && busy) return { ready: false, reason: "working" };
  const lines = splitLines(parseAnsi(text));
  if (!adapter.composerReady(lines)) return { ready: false, reason: "dialog" };
  if (adapter.extractInputDraft(lines)?.trim()) return { ready: false, reason: "draft" };
  return { ready: true, busy };
}
