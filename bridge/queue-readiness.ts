import type { AgentView, DeliveryMode, QueueWaitReason } from "./types.ts";
import type { HerdrApi } from "./herdr-client.ts";
import { adapterFor } from "../web/src/lib/harness/index.ts";
import { parseAnsi } from "../web/src/lib/ansi.ts";
import { splitLines } from "../web/src/lib/blocks.ts";
import { hasNativeNextTurnQueue } from "./queue-native.ts";
import { turnRunning } from "../web/src/lib/turn.ts";

/** Ready to type now, and whether a turn is running (it picks Codex's next-turn key). */
export type Readiness = { ready: true; busy: boolean } | { ready: false; reason: QueueWaitReason };

/**
 * Whether a row in `mode` may be typed into the pane now (ADR 0056). Every mode needs the input box
 * on screen, free of dialogs and of a draft the operator is typing at the terminal; that is read
 * from the screen whatever Herdr's status says, except a dialog the CLI's own state reports. Only `afterTurn` also waits for the turn to end,
 * unless the CLI keeps a next-turn queue of its own. Whether a turn runs is the composer's rule
 * (`turnRunning`): background work alone holds nothing.
 */
export async function queueReadiness(
  pane: Pick<AgentView, "paneId" | "agent" | "status" | "turn">,
  herdr: Pick<HerdrApi, "readPane">,
  mode: DeliveryMode,
): Promise<Readiness> {
  const adapter = adapterFor(pane.agent);
  if (!adapter?.composerReady) return { ready: false, reason: "disconnected" };
  if (!["idle", "done", "working", "blocked"].includes(pane.status)) return { ready: false, reason: "disconnected" };
  const holdsForTurn = mode === "afterTurn" && !hasNativeNextTurnQueue(pane.agent);
  // What the CLI's state (or, without it, Herdr's status) says before the screen is read.
  if (holdsForTurn && turnRunning(pane, "")) return { ready: false, reason: "working" };
  // A dialog the CLI itself reports (Claude's `waiting`) owns the keyboard whatever the screen shows.
  if (pane.turn?.waiting) return { ready: false, reason: "dialog" };
  const { text } = await herdr.readPane(pane.paneId, "visible", 100, "ansi");
  // Codex reports `blocked` while it repaints a running turn; without its rollout the painted cue says so.
  const busy = turnRunning(pane, text);
  if (holdsForTurn && busy) return { ready: false, reason: "working" };
  const lines = splitLines(parseAnsi(text));
  if (!adapter.composerReady(lines)) return { ready: false, reason: "dialog" };
  if (adapter.extractInputDraft(lines)?.trim()) return { ready: false, reason: "draft" };
  return { ready: true, busy };
}
