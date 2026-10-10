// How a queued row meets each CLI, as the P0 probes measured it (ADR 0056,
// web/src/lib/grammar/PROBES_2026_10_NOTES.md), and what the CLI's own queue did with it afterwards.
//
//   Claude 2.1.296  Enter while working   → its native queue; read after the running tool call
//                   Ctrl+Enter            → "send now": backgrounds the running tool, reads it now
//   Codex 0.160.1   Enter while working   → steer; read after the running tool call, same turn
//                   Tab while working     → its native queue; read as a new turn
//
// So Claude's Enter and Codex's Enter mean the same thing, `asap` and `steer` are one behaviour, and
// only Codex has a next-turn queue of its own. Claude's `afterTurn` is Nenu holding the row.

import type { NativeQueueEvent } from "./journal/types.ts";
import type { DeliveryMode, NativeQueueState } from "./types.ts";

export const DELIVERY_MODES: ReadonlySet<DeliveryMode> = new Set(["asap", "afterTurn", "steer"]);

/** The mode a row is stored with. `asap` and `steer` are one key per CLI, named the CLI's way. */
export function normalizeMode(agent: string, mode: DeliveryMode | undefined): DeliveryMode {
  // Without a choice, each CLI keeps what the queue did before ADR 0056: Claude waits for the turn
  // to end, Codex is typed straight in.
  if (mode === undefined) return agent === "codex" ? "steer" : "afterTurn";
  if (mode === "afterTurn") return mode;
  return agent === "codex" ? "steer" : "asap";
}

/** The mode a row is delivered with now: an operator's "Send now" lifts the wait for the turn. */
export function effectiveMode(row: { agent: string; deliveryMode?: DeliveryMode; sendNow?: boolean }): DeliveryMode {
  return row.sendNow ? normalizeMode(row.agent, "asap") : normalizeMode(row.agent, row.deliveryMode);
}

/** Whether the CLI keeps a next-turn queue of its own that a key can put a message into. */
export function hasNativeNextTurnQueue(agent: string): boolean {
  return agent === "codex";
}

/** The submit key for a delivery: Codex's Tab queues for the next turn while a turn runs. */
export function submitKind(agent: string, mode: DeliveryMode, busy: boolean): "enter" | "tab" {
  return mode === "afterTurn" && busy && hasNativeNextTurnQueue(agent) ? "tab" : "enter";
}

/**
 * Keys that make Claude read its queued messages now (measured: `ctrl+enter` through
 * `pane.send_keys`, backgrounding the running tool ~1.6 s later). Codex has no equivalent that keeps
 * the turn: its Esc interrupts the model, so none is offered.
 */
export function sendNowKeys(agent: string): string[] | null {
  return agent === "claude" ? ["ctrl+enter"] : null;
}

// Journal timestamps and the bridge clock are the same host's, but a row's `sentAt` is taken after
// Enter returned while Claude stamps the enqueue at the keypress.
const CLOCK_SLACK_MS = 5_000;

/**
 * What Claude's own queue did with a message, from its `queue-operation` rows: replay them as the
 * FIFO Claude keeps (enqueue pushes, dequeue shifts the head, remove takes the named one, popAll
 * recalls everything into the input box) and report the fate of the newest enqueue of `text` at or
 * after `since`. Undefined when no such enqueue exists, which is also what a message submitted to an
 * idle Claude usually leaves.
 *
 * Content is matched exactly, because enqueue rows also carry task and background-agent
 * notifications. The facts window holds the newest events only, so a dequeue whose item was enqueued
 * before the window is credited to the oldest item the replay knows; that misreads "read" a little
 * early at worst, never "recalled".
 */
export function nativeState(events: readonly NativeQueueEvent[], text: string, since: number): NativeQueueState | undefined {
  const want = text.trim();
  const fifo: { content: string; mine: boolean }[] = [];
  let fate: NativeQueueState | undefined;
  for (const event of events) {
    const content = event.content?.trim() ?? "";
    switch (event.kind) {
      case "enqueue": {
        const mine = content === want && Date.parse(event.ts) >= since - CLOCK_SLACK_MS;
        if (mine) fate = "enqueued";
        fifo.push({ content, mine });
        break;
      }
      case "dequeue": {
        if (fifo.shift()?.mine) fate = "absorbed";
        break;
      }
      case "remove":
      case "queued_command": {
        const at = fifo.findIndex((item) => item.content === content);
        if (at < 0) break;
        if (fifo[at]!.mine) fate = "absorbed";
        fifo.splice(at, 1);
        break;
      }
      case "popAll": {
        if (fifo.some((item) => item.mine)) fate = "recalled";
        fifo.length = 0;
        break;
      }
    }
  }
  return fate;
}

/** A native state no later journal row changes: the CLI read it, or the operator took it back. */
export function nativeSettled(native: NativeQueueState | undefined): boolean {
  return native === "absorbed" || native === "recalled";
}
