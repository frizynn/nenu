import { fetchPane } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines, type MenuModel } from "./blocks";
import { adapterFor } from "./harness/registry";
import { defaultSleep, POLL_ATTEMPTS, POLL_DELAY_MS } from "./harness/poll";
import { parseNativeModelMenu } from "./native-model-menu";
import type { WaitForNativeModelMenuArgs, WaitForNativeModelMenuResult } from "./wait-for-native-model-menu";
import type { PaneReadResponse } from "./types";

export type ModelActionObservation =
  | (Extract<WaitForNativeModelMenuResult, { ok: true }> & { kind: "menu" })
  | { ok: true; kind: "closed"; pane: PaneReadResponse }
  | Extract<WaitForNativeModelMenuResult, { ok: false }>;

/** A key acknowledgement is not a TUI acknowledgement. Wait for a changed picker or a
 * positively recognized composer; never send a second key into an unchanged repaint. */
export async function waitForModelAction(args: WaitForNativeModelMenuArgs & { previous: MenuModel }): Promise<ModelActionObservation> {
  const aborted = (): ModelActionObservation => ({ ok: false, reason: "aborted", error: "Model change cancelled." });
  const adapter = adapterFor(args.agent);
  if (!adapter?.composerReady) return { ok: false, reason: "unsupported", error: "This agent cannot verify model changes." };
  const sleep = args.sleep ?? defaultSleep;
  try {
    for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
      if (attempt) await sleep(POLL_DELAY_MS);
      if (args.signal?.aborted) return aborted();
      const pane = await fetchPane(args.paneId, args.requestedLines, args.session, args.signal);
      if (args.signal?.aborted) return aborted();
      if (pane.paneId !== args.paneId) return { ok: false, reason: "error", error: "The response belongs to another pane." };
      const lines = splitLines(parseAnsi(pane.text));
      const dialogs = adapter.buildBlocks(lines).filter((block) => block.kind !== "raw");
      if (dialogs.length === 0) {
        if (adapter.composerReady(lines)) return { ok: true, kind: "closed", pane };
        continue;
      }
      const block = dialogs[0];
      const menu = dialogs.length === 1 && block?.kind === "menu" ? parseNativeModelMenu(block.menu, block.lines) : null;
      if (block?.kind !== "menu" || !menu) return { ok: false, reason: "different-dialog", error: "Another agent dialog is waiting. It was left untouched." };
      if (block.menu.signature !== args.previous.signature) return { ok: true, kind: "menu", pane, block, menu };
    }
    return { ok: false, reason: "timeout", error: "The agent has not confirmed the change. Check the terminal before trying again." };
  } catch (error) {
    return args.signal?.aborted ? aborted() : { ok: false, reason: "error", error: error instanceof Error ? error.message : String(error) };
  }
}
