import { useCallback, useEffect, useState } from "react";

import { answerInteraction, fetchInteractions, isApiErrorStatus } from "@/lib/api";
import { isLiveHealthy } from "@/lib/live-events";
import { useLivePoll } from "./use-live-poll";
import type { AnswerOutcome, AnswerRequest, Interaction, InteractionOption } from "@/lib/types";

/** Fallback poll for the bridge's dialogs: brisk without the event stream, relaxed with it (ADR 0054). */
export const INTERACTIONS_POLL_MS = { live: 10_000, fallback: 2_500 } as const;
/** How long "Answered: X" stays when no new dialog replaces it. */
export const RECEIPT_MS = 6_000;

/** The optimistic record of an answer, shown until the pane's next dialog or {@link RECEIPT_MS}. */
export interface Receipt {
  paneId: string;
  signature: string;
  label: string;
  at: number;
}

/** A multi-select checkbox only ticks a row; the dialog is still there afterwards. */
export const isToggle = (i: Interaction, o: InteractionOption) => i.kind === "multi-select" && o.checked !== undefined;

export interface InteractionsState {
  interactions: Interaction[];
  receipts: Receipt[];
  /** The last read failed; `interactions` is what was last known. */
  stale: boolean;
  refresh: () => void;
  answer: (i: Interaction, option: InteractionOption, extra?: { text?: string; confirm?: boolean }) => Promise<AnswerOutcome>;
}

/**
 * Every dialog the bridge detected in `session`. Wakes on the `interaction` live topic, keeps a
 * fallback poll, and pauses behind the idle cover and while the page is hidden. An answer is one
 * POST: the bridge re-reads the screen and refuses a stale signature.
 */
export function useInteractions(session?: string, enabled = true): InteractionsState {
  const [list, setList] = useState<Interaction[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [stale, setStale] = useState(false);
  useEffect(() => {
    setList([]);
    setReceipts([]);
  }, [session]);

  const poke = useLivePoll({
    enabled,
    deps: [session],
    read: (signal) => fetchInteractions(session, signal),
    onRead: (next) => { setList(next.interactions); setStale(false); },
    onFail: () => setStale(true),
    delay: () => isLiveHealthy() ? INTERACTIONS_POLL_MS.live : INTERACTIONS_POLL_MS.fallback,
    wakes: (event) => event.topic === "interaction" || event.topic === "resync",
  });

  // A receipt lapses on its own, so a dialog that comes back with the same signature shows again.
  useEffect(() => {
    if (receipts.length === 0) return;
    const next = Math.min(...receipts.map((r) => r.at + RECEIPT_MS)) - Date.now();
    const timer = setTimeout(() => setReceipts((rs) => rs.filter((r) => r.at + RECEIPT_MS > Date.now())), Math.max(0, next));
    return () => clearTimeout(timer);
  }, [receipts]);

  const answer = useCallback(async (i: Interaction, option: InteractionOption, extra: { text?: string; confirm?: boolean } = {}) => {
    const body: AnswerRequest = {
      signature: i.signature,
      optionIndex: option.index,
      ...(extra.text !== undefined ? { text: extra.text } : {}),
      ...(extra.confirm ? { confirm: true } : {}),
    };
    let outcome: AnswerOutcome;
    try {
      outcome = await answerInteraction(i.paneId, body, session);
    } catch (err) {
      outcome = isApiErrorStatus(err, 422)
        ? { ok: false, error: "Answer this one in the terminal.", code: "unsupported" }
        : { ok: false, error: (err as Error).message || "Answer failed" };
    }
    if (outcome.ok && !isToggle(i, option)) {
      setReceipts((rs) => [...rs.filter((r) => r.paneId !== i.paneId), { paneId: i.paneId, signature: i.signature, label: option.label, at: Date.now() }]);
    }
    poke();
    return outcome;
  }, [session, poke]);

  // A dialog just answered stays hidden behind its receipt even if a read raced the answer.
  const answered = new Set(receipts.map((r) => `${r.paneId}\0${r.signature}`));
  const interactions = list.filter((i) => !answered.has(`${i.paneId}\0${i.signature}`));
  const live = new Set(interactions.map((i) => i.paneId));
  return {
    interactions,
    receipts: receipts.filter((r) => !live.has(r.paneId)),
    stale,
    refresh: poke,
    answer,
  };
}
