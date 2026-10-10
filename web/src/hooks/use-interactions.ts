import { useCallback, useEffect, useRef, useState } from "react";

import { answerInteraction, fetchInteractions, isApiErrorStatus } from "@/lib/api";
import { isLocked, useLocked } from "@/lib/idle";
import { isLiveHealthy, onLiveEvent } from "@/lib/live-events";
import type { AnswerOutcome, AnswerRequest, Interaction, InteractionOption } from "@/lib/types";

/** Fallback poll for the bridge's dialogs: brisk without the event stream, relaxed with it (ADR 0054). */
export const INTERACTIONS_POLL_MS = { live: 10_000, fallback: 2_500 } as const;
/** How long "Answered: X" stays when no new dialog replaces it. */
export const RECEIPT_MS = 6_000;

/**
 * An interaction as bridge/interactions.ts serves it. The extra fields are wire additions the
 * bridge owns until the shared types name them.
 */
export interface LiveInteraction extends Interaction {
  options: Array<InteractionOption & { checked?: boolean }>;
  /** The full command, file or plan is on the card; only then may Home or a push approve it. */
  detailComplete?: boolean;
  /** The dialog's own input has focus in the terminal: any key sent now would be typed into it. */
  typing?: true;
}

export type LiveOption = LiveInteraction["options"][number];

/** The optimistic record of an answer, shown until the pane's next dialog or {@link RECEIPT_MS}. */
export interface Receipt {
  paneId: string;
  signature: string;
  label: string;
  at: number;
}

/** A multi-select checkbox only ticks a row; the dialog is still there afterwards. */
export const isToggle = (i: LiveInteraction, o: LiveOption) => i.kind === "multi-select" && o.checked !== undefined;

export interface InteractionsState {
  interactions: LiveInteraction[];
  receipts: Receipt[];
  /** The last read failed; `interactions` is what was last known. */
  stale: boolean;
  refresh: () => void;
  answer: (i: LiveInteraction, option: LiveOption, extra?: { text?: string; confirm?: boolean }) => Promise<AnswerOutcome>;
}

/**
 * Every dialog the bridge detected in `session`. Wakes on the `interaction` live topic, keeps a
 * fallback poll, and pauses behind the idle cover and while the page is hidden. An answer is one
 * POST: the bridge re-reads the screen and refuses a stale signature.
 */
export function useInteractions(session?: string, enabled = true): InteractionsState {
  const locked = useLocked();
  const [list, setList] = useState<LiveInteraction[]>([]);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [stale, setStale] = useState(false);
  const poke = useRef<() => void>(() => {});

  useEffect(() => {
    setList([]);
    setReceipts([]);
  }, [session]);

  useEffect(() => {
    if (!enabled || locked) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let again = false;

    async function poll() {
      if (disposed || document.hidden || isLocked()) return;
      if (controller) return void (again = true);
      clearTimeout(timer);
      const request = (controller = new AbortController());
      try {
        const next = await fetchInteractions(session, request.signal);
        if (disposed || request.signal.aborted) return;
        setList(next.interactions as LiveInteraction[]);
        setStale(false);
      } catch {
        if (!disposed && !request.signal.aborted) setStale(true);
      } finally {
        if (controller === request) controller = undefined;
        if (again && !disposed) {
          again = false;
          void poll();
        } else if (!disposed && !document.hidden) {
          timer = setTimeout(() => void poll(), isLiveHealthy() ? INTERACTIONS_POLL_MS.live : INTERACTIONS_POLL_MS.fallback);
        }
      }
    }
    const visibility = () => {
      if (!document.hidden) return void poll();
      clearTimeout(timer);
      controller?.abort();
      controller = undefined;
    };
    poke.current = () => void poll();
    const stopLive = onLiveEvent((event) => {
      if (event.topic === "interaction" || event.topic === "resync") void poll();
    });
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", visibility);
    void poll();
    return () => {
      disposed = true;
      poke.current = () => {};
      clearTimeout(timer);
      controller?.abort();
      stopLive();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", visibility);
    };
  }, [session, enabled, locked]);

  // A receipt lapses on its own, so a dialog that comes back with the same signature shows again.
  useEffect(() => {
    if (receipts.length === 0) return;
    const next = Math.min(...receipts.map((r) => r.at + RECEIPT_MS)) - Date.now();
    const timer = setTimeout(() => setReceipts((rs) => rs.filter((r) => r.at + RECEIPT_MS > Date.now())), Math.max(0, next));
    return () => clearTimeout(timer);
  }, [receipts]);

  const answer = useCallback(async (i: LiveInteraction, option: LiveOption, extra: { text?: string; confirm?: boolean } = {}) => {
    // `confirm` is the bridge's acknowledgement of a persistent option (AnswerBody in bridge/interactions.ts).
    const body: AnswerRequest & { confirm?: boolean } = {
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
    poke.current();
    return outcome;
  }, [session]);

  // A dialog just answered stays hidden behind its receipt even if a read raced the answer.
  const answered = new Set(receipts.map((r) => `${r.paneId}\0${r.signature}`));
  const interactions = list.filter((i) => !answered.has(`${i.paneId}\0${i.signature}`));
  const live = new Set(interactions.map((i) => i.paneId));
  return {
    interactions,
    receipts: receipts.filter((r) => !live.has(r.paneId)),
    stale,
    refresh: useCallback(() => poke.current(), []),
    answer,
  };
}
