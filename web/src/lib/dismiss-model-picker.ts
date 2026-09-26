import { fetchPane } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines } from "./blocks";
import type { MenuModel } from "./blocks";
import { adapterFor } from "./harness/registry";
import { defaultSleep, POLL_ATTEMPTS, POLL_DELAY_MS } from "./harness/poll";
import type { Sleep } from "./harness/poll";
import { submitMenuKeys } from "./menu-action";
import { parseNativeModelMenu } from "./native-model-menu";
import type { PaneReadResponse } from "./types";

export interface DismissModelPickerArgs {
  paneId: string;
  session?: string;
  agent?: string;
  requestedLines: number;
  signal?: AbortSignal;
  canWrite?: () => boolean;
  sleep?: Sleep;
}
export type DismissModelPickerResult = { ok: true } | {
  ok: false;
  reason: "aborted" | "not-writable" | "unsupported" | "different-dialog" | "changed" | "timeout" | "error";
  error: string;
};
type FailureReason = Extract<DismissModelPickerResult, { ok: false }>["reason"];
const failure = (reason: FailureReason, error: string): DismissModelPickerResult => ({ ok: false, reason, error });

/** Close only the actual model/effort menus, never an arbitrary dialog or a hidden input prompt.
 * Each advertised Escape uses the existing full signature + bridge prompt-binding guard. A sent
 * Escape is not completion: wait for a changed menu before unwinding another level, and only report
 * success when this harness positively recognizes its composer again. No Enter and no forced keys.
 */
export async function dismissModelPicker(args: DismissModelPickerArgs): Promise<DismissModelPickerResult> {
  const adapter = adapterFor(args.agent);
  if (!adapter?.composerReady) return failure("unsupported", "This agent cannot verify that its model picker closed.");
  const stopped = (): DismissModelPickerResult | null => args.signal?.aborted
    ? failure("aborted", "Closing the model picker was cancelled.")
    : args.canWrite?.() === false ? failure("not-writable", "The pane is no longer writable.") : null;
  const sleep = args.sleep ?? defaultSleep;
  const read = () => args.signal
    ? fetchPane(args.paneId, args.requestedLines, args.session, args.signal)
    : fetchPane(args.paneId, args.requestedLines, args.session);
  function classify(fresh: PaneReadResponse): { kind: "composer" | "unknown" | "different-dialog" } | { kind: "menu"; menu: MenuModel } {
    const lines = splitLines(parseAnsi(fresh.text));
    const dialogs = adapter!.buildBlocks(lines).filter((block) => block.kind !== "raw");
    if (dialogs.length === 0) return { kind: adapter!.composerReady!(lines) ? "composer" : "unknown" };
    const block = dialogs[0];
    if (dialogs.length === 1 && block?.kind === "menu" && parseNativeModelMenu(block.menu, block.lines)) {
      return { kind: "menu", menu: block.menu };
    }
    return { kind: "different-dialog" };
  }
  try {
    const initialStop = stopped();
    if (initialStop) return initialStop;
    let fresh = await read();
    // Model → reasoning → expanded reasoning is at most three recognized cancellation levels.
    for (let level = 0; level < 3; level++) {
      const stop = stopped();
      if (stop) return stop;
      const screen = classify(fresh);
      if (screen.kind === "composer") return { ok: true };
      if (screen.kind !== "menu") return failure("different-dialog", "The pane is not showing a recognized model picker. Nothing was cancelled.");
      const cancel = screen.menu.actions.find((action) => action.cancel && action.keys.length === 1 && action.keys[0] === "Escape");
      if (!cancel) return failure("different-dialog", "This model picker does not advertise a supported cancel key.");
      const sent = await submitMenuKeys({
        paneId: args.paneId, session: args.session, agent: args.agent,
        requestedLines: args.requestedLines, detectedRevision: fresh.revision,
        menu: screen.menu, keys: cancel.keys, signal: args.signal, canWrite: args.canWrite,
      });
      const afterSendStop = stopped();
      if (afterSendStop) return afterSendStop;
      if (sent.status === "changed") return failure("changed", "The model picker changed before it could be cancelled. Try again.");
      if (sent.status === "error") return failure("error", sent.error);
      let changed = false;
      for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
        // The key RPC may already have waited through the repaint. Observe it immediately;
        // only unchanged/transient output needs another paced poll, never a second blind Escape.
        if (attempt > 0) await sleep(POLL_DELAY_MS);
        const beforeReadStop = stopped();
        if (beforeReadStop) return beforeReadStop;
        fresh = await read();
        const afterReadStop = stopped();
        if (afterReadStop) return afterReadStop;
        const next = classify(fresh);
        if (next.kind === "composer") return { ok: true };
        if (next.kind === "different-dialog") return failure("different-dialog", "Another dialog replaced the model picker. It was left untouched.");
        if (next.kind === "menu" && next.menu.signature !== screen.menu.signature) { changed = true; break; }
        // Same signature or a transient blank redraw: do not send Escape again into lagging output.
      }
      if (!changed) return failure("timeout", "The model picker has not finished closing. No further keys were sent.");
    }
    return failure("timeout", "The model picker did not return to the input within the cancellation limit.");
  } catch (error) {
    return stopped() ?? failure("error", error instanceof Error ? error.message : String(error));
  }
}
