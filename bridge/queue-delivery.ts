import type { HerdrClient } from "./herdr-client.ts";
import type { QueuedMessage, QueueOutcome } from "./message-queue.ts";
import { guardedSend, type SendHerdr } from "./guarded-send.ts";
import { adapterFor } from "../web/src/lib/harness/index.ts";
import { splitLines } from "../web/src/lib/blocks.ts";
import { parseAnsi } from "../web/src/lib/ansi.ts";
import type { Sleep } from "../web/src/lib/harness/poll.ts";
import type { ActionResponse } from "./types.ts";

/** Types into the pane through the audited reply route: text alone, or the configured submit key. */
export type QueueWrite = (text: string, submit: boolean, requestId: string, paste: boolean) => Promise<ActionResponse>;

const READ_LINES = 100;
// Sentinels for the submit step: guardedSend presses `submitKeys` by reference, so the wrapper below
// knows a submit from any other key it might be asked for.
const ENTER: string[] = ["Enter"];
const TAB: string[] = ["Tab"];

/**
 * Deliver one claimed row through the guarded send (guarded-send.ts): pre-flight, type, verify on a
 * fresh read, re-read right before the submit key, then confirm the input box let go of it.
 *
 * Three things differ from a phone send. The queue never clears a draft: one in the box is the
 * operator's own typing at the terminal, so the row waits instead of sweeping it. Text and Enter go
 * through `write`, the reply route, so each lands in the audit trail as before. And the submit key
 * follows the row's mode: Enter, or Tab for Codex's next-turn queue (queue-native.ts), pressed on
 * `herdr`, which the queue service hands in already audited.
 */
export async function deliverQueuedMessage(
  row: QueuedMessage,
  herdr: SendHerdr,
  write: QueueWrite,
  sameConversation: () => Promise<boolean>,
  submit: "enter" | "tab" = "enter",
  sleep?: Sleep,
): Promise<QueueOutcome> {
  const adapter = adapterFor(row.agent);
  if (!adapter?.composerReady)
    return { status: "blocked", error: "This agent cannot accept queued messages." };
  let initial;
  try {
    initial = splitLines(parseAnsi((await herdr.readPane(row.paneId, "recent", READ_LINES, "ansi")).text));
  } catch {
    return { status: "blocked", error: "Waiting for the terminal connection. Your message is saved." };
  }
  if (!adapter.composerReady(initial) || adapter.extractInputDraft(initial)?.trim())
    return { status: "blocked", error: "The terminal has a dialog or draft. Check it before sending." };

  const base = `queue:${row.id}:${row.revision}`;
  // Whether anything reached the terminal: until then a failed delivery is safe to retry.
  let wrote = false;
  const checked = async (step: () => Promise<ActionResponse>) => {
    if (!(await sameConversation())) throw new Error("The connected conversation changed.");
    wrote = true;
    const result = await step();
    if (!result.ok) throw new Error(result.error ?? "The terminal refused the write.");
  };
  const pane: SendHerdr = {
    getPane: (id) => herdr.getPane(id),
    readPane: (...args) => herdr.readPane(...args),
    waitForOutput: (...args) => herdr.waitForOutput(...args),
    sendPaneText: (_id, wire) => checked(() => write(row.text, false, `${base}:type`, wire !== row.text)),
    async sendPaneKeys(id, keys) {
      if (keys === ENTER) return checked(() => write("", true, `${base}:submit`, false));
      if (keys === TAB) return checked(async () => (await herdr.sendPaneKeys(id, keys), { ok: true }));
      // Only a sweep asks for other keys, and the queue never clears the operator's draft.
      throw new Error("The terminal input changed. Check it before sending.");
    },
  };
  const { outcome } = await guardedSend(
    { herdr: pane, paneId: row.paneId, readLines: READ_LINES, submitKeys: submit === "tab" ? TAB : ENTER, ...(sleep ? { sleep } : {}) },
    { text: row.text, requestId: base },
  );
  if (outcome.ok) return { status: "sent" };
  return {
    status: !wrote && !outcome.textDelivered ? "blocked" : "uncertain",
    error: outcome.error,
  };
}

/**
 * Make Claude read its queued messages now (Ctrl+Enter, measured in P0). Only into an input box that
 * is on screen and empty: with a draft in it the chord would queue the draft too.
 */
export async function sendQueuedNow(
  paneId: string,
  agent: string,
  keys: string[],
  herdr: Pick<HerdrClient, "readPane" | "sendPaneKeys">,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const adapter = adapterFor(agent);
  if (!adapter?.composerReady) return { ok: false, error: "This agent cannot read queued messages early." };
  const lines = splitLines(parseAnsi((await herdr.readPane(paneId, "recent", READ_LINES, "ansi")).text));
  if (!adapter.composerReady(lines)) return { ok: false, error: "A dialog is on screen. Answer it first." };
  if (adapter.extractInputDraft(lines)?.trim()) return { ok: false, error: "The terminal input holds a draft. Clear it first." };
  await herdr.sendPaneKeys(paneId, keys);
  return { ok: true };
}
