import { defaultSleep } from "./harness/poll";
import type { MenuModel } from "./blocks";
import { menusSameIdentity, submitMenuKeys } from "./menu-action";
import { modelRowKeys } from "./native-model-menu";
import { waitForNativeModelMenu, type WaitForNativeModelMenuArgs, type WaitForNativeModelMenuResult } from "./wait-for-native-model-menu";

export interface SelectNativeModelArgs extends WaitForNativeModelMenuArgs {
  /** Exact CLI row label/slug, or a finite Claude catalogue alias. */
  name: string;
  canWrite?: () => boolean;
}
export type SelectNativeModelResult =
  | (Extract<WaitForNativeModelMenuResult, { ok: true }> & { name: string })
  | Extract<WaitForNativeModelMenuResult, { ok: false }> | {
  ok: false;
  reason: "not-writable" | "unknown-model" | "changed";
  error: string;
};

/** Move the live picker highlight, never accept it. The caller must separately guard an explicit
 * advertised confirmation against the returned fresh menu; no default-setting key is inferred.
 */
export async function selectNativeModel(args: SelectNativeModelArgs): Promise<SelectNativeModelResult> {
  const stopped = (): SelectNativeModelResult | null => args.signal?.aborted
    ? { ok: false, reason: "aborted", error: "Selecting the model was cancelled." }
    : args.canWrite?.() === false
      ? { ok: false, reason: "not-writable", error: "The pane is no longer writable." } : null;
  const changed = (): SelectNativeModelResult => ({ ok: false, reason: "changed", error: "The model picker changed. Review it before trying again." });
  try {
    const initialStop = stopped();
    if (initialStop) return initialStop;
    const initial = await waitForNativeModelMenu(args);
    const afterReadStop = stopped();
    if (afterReadStop) return afterReadStop;
    if (!initial.ok) return initial;
    if (initial.menu.kind !== "model") return { ok: false, reason: "different-dialog", error: "The model list is not open. The current dialog was left untouched." };
    const alias = args.agent === "claude"
      ? args.name === "Default (recommended)" ? /^Default(?: \(recommended\))?$/
        : ["Opus", "Sonnet", "Haiku"].includes(args.name) ? new RegExp(`^${args.name}(?: \\([^)]*\\))?$`, "i") : null
      : null;
    const matches = initial.menu.rows.map((row, index) =>
      (alias ? alias.test(row.name) : row.name === args.name) ? index : -1,
    ).filter((index) => index >= 0);
    if (matches.length !== 1) return { ok: false, reason: "unknown-model", error: "That model is not uniquely available in the current picker." };
    const targetIndex = matches[0]!;
    const keys = modelRowKeys(initial.menu.selectedIndex, targetIndex, initial.menu.rows.length);
    const name = initial.menu.rows[targetIndex]!.name;
    if (targetIndex === initial.menu.selectedIndex) return { ...initial, name };
    if (!keys.length) return changed();
    const sent = await submitMenuKeys({
      paneId: args.paneId, session: args.session, agent: args.agent,
      requestedLines: args.requestedLines, signal: args.signal, canWrite: args.canWrite,
      detectedRevision: initial.pane.revision, menu: initial.block.menu, keys, nav: false,
    });
    const afterSendStop = stopped();
    if (afterSendStop) return afterSendStop;
    if (sent.status === "changed") return changed();
    if (sent.status === "error") return { ok: false, reason: "error", error: sent.error };

    const sleep = args.sleep ?? defaultSleep;
    for (const delay of [0, 75, 150, 300, 450, 600]) {
      if (delay) await sleep(delay);
      const beforePollStop = stopped();
      if (beforePollStop) return beforePollStop;
      const fresh = await waitForNativeModelMenu(args);
      const afterPollStop = stopped();
      if (afterPollStop) return afterPollStop;
      if (!fresh.ok) return fresh;
      if (fresh.menu.kind !== "model") return changed();
      const sameRows = fresh.menu.rows.length === initial.menu.rows.length && fresh.menu.rows.every((row, index) => {
        const before = initial.menu.rows[index]!;
        return row.name === before.name && row.description === before.description && row.current === before.current;
      });
      // Claude removes ←/→ when Haiku is highlighted and restores them for reasoning models.
      // That expected capability change is not a foreign picker. Titles, footer keys, rows and
      // the exact target highlight still have to match; confirmation keeps its full fresh guard.
      const identity = (menu: MenuModel) => args.agent === "claude"
        ? { ...menu, nav: { ...menu.nav, leftRight: undefined } } : menu;
      if (!sameRows || !menusSameIdentity(identity(initial.block.menu), identity(fresh.block.menu))) return changed();
      if (fresh.menu.selectedIndex === targetIndex) return { ...fresh, name };
      // An unchanged repaint may lag the write. Any other highlight is a concurrent action;
      // never compensate with more arrows or let the caller accept the wrong row.
      if (fresh.block.menu.signature !== initial.block.menu.signature) return changed();
    }
    return { ok: false, reason: "timeout", error: "The model highlight has not updated. No further keys were sent." };
  } catch (error) {
    return stopped() ?? { ok: false, reason: "error", error: error instanceof Error ? error.message : String(error) };
  }
}
