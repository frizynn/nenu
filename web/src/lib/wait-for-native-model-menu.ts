import { fetchPane } from "./api";
import { parseAnsi } from "./ansi";
import { splitLines, type MenuBlock } from "./blocks";
import { adapterFor } from "./harness/registry";
import { defaultSleep, type Sleep } from "./harness/poll";
import { parseNativeModelMenu, type NativeModelMenu } from "./native-model-menu";
import type { PaneReadResponse } from "./types";

export interface WaitForNativeModelMenuArgs {
  paneId: string;
  session?: string;
  agent?: string;
  requestedLines: number;
  signal?: AbortSignal;
  sleep?: Sleep;
}
export type WaitForNativeModelMenuResult =
  | { ok: true; pane: PaneReadResponse; block: MenuBlock; menu: NativeModelMenu }
  | { ok: false; reason: "aborted" | "unsupported" | "different-dialog" | "timeout" | "error"; error: string };

/** Observe the result of a separately guarded /model command without waiting for route polling.
 * This is read-only: returned controls still require the normal freshness guard before any keys.
 * Raw/composer frames may be a repaint in progress; another recognized dialog must stop the wait.
 */
export async function waitForNativeModelMenu(args: WaitForNativeModelMenuArgs): Promise<WaitForNativeModelMenuResult> {
  const aborted = (): WaitForNativeModelMenuResult => ({ ok: false, reason: "aborted", error: "Opening models was cancelled." });
  if (args.signal?.aborted) return aborted();
  const adapter = adapterFor(args.agent);
  if (!adapter) return { ok: false, reason: "unsupported", error: "This agent has no supported model picker." };
  const sleep = args.sleep ?? defaultSleep;
  try {
    // First read is immediate; at most six reads and 1575 ms of backoff, plus network time.
    for (const delay of [0, 75, 150, 300, 450, 600]) {
      if (delay) await sleep(delay);
      if (args.signal?.aborted) return aborted();
      const pane = await fetchPane(args.paneId, args.requestedLines, args.session, args.signal);
      if (args.signal?.aborted) return aborted();
      if (pane.paneId !== args.paneId) return { ok: false, reason: "error", error: "The model picker response belongs to another pane." };
      const dialogs = adapter.buildBlocks(splitLines(parseAnsi(pane.text))).filter((block) => block.kind !== "raw");
      if (dialogs.length === 0) continue;
      const block = dialogs[0];
      const menu = dialogs.length === 1 && block?.kind === "menu" ? parseNativeModelMenu(block.menu, block.lines) : null;
      if (block?.kind === "menu" && menu) return { ok: true, pane, block, menu };
      return { ok: false, reason: "different-dialog", error: "Another agent dialog is waiting. It was left untouched." };
    }
    return { ok: false, reason: "timeout", error: "The model picker has not appeared yet. Check the agent before trying again." };
  } catch (error) {
    return args.signal?.aborted ? aborted() : { ok: false, reason: "error", error: error instanceof Error ? error.message : String(error) };
  }
}
