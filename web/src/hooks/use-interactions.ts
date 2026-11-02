import { useCallback, useEffect, useState } from "react";

import { recommendedLabel } from "@/components/recommended-badge";
import { answerInteraction, fetchInteractions, isApiErrorStatus } from "@/lib/api";
import { isLiveHealthy } from "@/lib/live-events";
import { useLivePoll } from "./use-live-poll";
import type { AnswerOutcome, AnswerRequest, Interaction, InteractionOption } from "@/lib/types";

/** Fallback poll for the bridge's dialogs: brisk without the event stream, relaxed with it (ADR 0054). */
export const INTERACTIONS_POLL_MS = { live: 10_000, fallback: 2_500 } as const;
/** How long a receipt stays when no new dialog replaces it. */
export const RECEIPT_MS = 6_000;

/** What an answer may add to the tapped option: typed text, or the persistent option's confirm. */
export type AnswerExtra = Pick<AnswerRequest, "text" | "confirm">;

/** The optimistic record of an answer, shown until the pane's next dialog or {@link RECEIPT_MS}. */
export interface Receipt {
  paneId: string;
  signature: string;
  label: string;
  /** What the answer did, in a few words: "Approved · echo hi > hello.txt", "Answered · Apple". */
  summary: string;
  at: number;
}

/** What an answer did, said with what it was about: the command approved, the answer chosen. */
export function receiptSummary(i: Interaction, option: InteractionOption, text?: string): string {
  const label = recommendedLabel(option.label).text;
  const verdict = option.role === "deny" ? "Declined" : "Approved";
  switch (i.kind) {
    case "permission": {
      // A request in parts names its command or file. Without parts only a lone plain row is known
      // to be the command (Grok); a longer one ends on a fold, a link or a sentence, so the answer
      // names itself instead, and so does a folder's trust.
      const rows = i.family === "trust" ? [] : i.context?.split("\n") ?? [];
      return `${verdict} · ${i.subject?.command ?? i.subject?.file ?? (rows.length === 1 ? rows[0] : label)}`;
    }
    case "plan":
      return option.role === "freeText" && text ? `Sent · ${text}` : `${verdict} · ${label}`;
    case "multi-select":
      if (option.role === "primary" && !i.answers && !i.incomplete) {
        const ticked = i.options.filter((o) => o.checked).map((o) => recommendedLabel(o.label).text);
        return `${label} · ${ticked.join(", ") || "nothing ticked"}`;
      }
      break;
  }
  if (i.answers || i.incomplete) return option.role === "primary" ? "Submitted your answers" : label;
  return `Answered · ${text ?? label}`;
}

/**
 * A tap the bridge refused because the dialog had moved on. The card it was on is replaced by the
 * pane's next one, so the refusal is said there: on the first dialog after `from`, and no later one.
 */
interface Refusal {
  paneId: string;
  /** The dialog the refused tap was on. */
  from: string;
  /** The dialog that replaced it, once a read has seen one. */
  to?: string;
  text: string;
}

/** Each refusal bound to the dialog that replaced its own, and dropped once that one is gone too. */
function settle(refusals: Refusal[], list: Interaction[]): Refusal[] {
  if (!refusals.length) return refusals;
  const now = new Map(list.map((i) => [i.paneId, i.signature]));
  const next = refusals.flatMap((r): Refusal[] => {
    const shown = now.get(r.paneId);
    if (shown === r.from || (r.to !== undefined && shown === r.to)) return [r];
    return r.to === undefined && shown !== undefined ? [{ ...r, to: shown }] : [];
  });
  return next.length === refusals.length && next.every((r, n) => r === refusals[n]) ? refusals : next;
}

/** The new list, reusing each dialog object a read repeated unchanged, so a poll re-renders nothing. */
function sameDialogs(prev: Interaction[], next: Interaction[]): Interaction[] {
  const kept = new Map(prev.map((i) => [i.paneId, i]));
  const merged = next.map((i) => {
    const old = kept.get(i.paneId);
    return old && JSON.stringify(old) === JSON.stringify(i) ? old : i;
  });
  return merged.length === prev.length && merged.every((i, n) => i === prev[n]) ? prev : merged;
}

/** A multi-select checkbox only ticks a row; the dialog is still there afterwards. */
export const isToggle = (i: Interaction, o: InteractionOption) => i.kind === "multi-select" && o.checked !== undefined;

export interface InteractionsState {
  interactions: Interaction[];
  receipts: Receipt[];
  /** The last read failed; `interactions` is what was last known. */
  stale: boolean;
  /** A read for this session has succeeded, so an empty list means no dialog rather than not asked yet. */
  loaded: boolean;
  refresh: () => void;
  answer: (i: Interaction, option: InteractionOption, extra?: AnswerExtra) => Promise<AnswerOutcome>;
  /** Why the pane's last tap did nothing, when `i` is the dialog that replaced the one it hit. */
  refusalFor: (i: Interaction) => string | undefined;
}

// The last dialogs read for each session, by any view, so a page that mounts again (Home after a chat's
// back control) draws what it last knew while its first read is on its way, instead of a placeholder
// that turns into the question as the page slides in.
const lastRead = new Map<string, Interaction[]>();
const sessionKey = (session?: string) => session ?? "";

/** Tests only: what one test read is no other test's. */
export function __resetLastRead(): void {
  lastRead.clear();
}

/**
 * Every dialog the bridge detected in `session`. Wakes on the `interaction` live topic, keeps a
 * fallback poll, and pauses behind the idle cover and while the page is hidden. An answer is one
 * POST: the bridge re-reads the screen and refuses a stale signature.
 */
export function useInteractions(session?: string, enabled = true): InteractionsState {
  const [list, setList] = useState<Interaction[]>(() => lastRead.get(sessionKey(session)) ?? []);
  const [receipts, setReceipts] = useState<Receipt[]>([]);
  const [refusals, setRefusals] = useState<Refusal[]>([]);
  const [stale, setStale] = useState(false);
  const [loaded, setLoaded] = useState(() => lastRead.has(sessionKey(session)));
  // Another session's dialogs are not this one's: start from what it last read, if anything.
  const [shown, setShown] = useState(session);
  if (shown !== session) {
    setShown(session);
    setList(lastRead.get(sessionKey(session)) ?? []);
    setReceipts([]);
    setRefusals([]);
    setLoaded(lastRead.has(sessionKey(session)));
  }

  const poke = useLivePoll({
    enabled,
    deps: [session],
    read: (signal) => fetchInteractions(session, signal),
    onRead: (next) => {
      lastRead.set(sessionKey(session), next.interactions);
      setList((prev) => sameDialogs(prev, next.interactions));
      setRefusals((rs) => settle(rs, next.interactions));
      setStale(false);
      setLoaded(true);
    },
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

  const answer = useCallback(async (i: Interaction, option: InteractionOption, extra: AnswerExtra = {}) => {
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
    // A new tap on the pane supersedes what its last one met.
    setRefusals((rs) => [
      ...rs.filter((r) => r.paneId !== i.paneId),
      ...(!outcome.ok && outcome.code === "interaction_changed" ? [{ paneId: i.paneId, from: i.signature, text: outcome.error }] : []),
    ]);
    // A tick or a step between questions leaves the dialog up: nothing to receipt.
    if (outcome.ok && !isToggle(i, option) && option.role !== "nav") {
      const summary = receiptSummary(i, option, extra.text);
      setReceipts((rs) => [...rs.filter((r) => r.paneId !== i.paneId), { paneId: i.paneId, signature: i.signature, label: option.label, summary, at: Date.now() }]);
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
    loaded,
    refresh: poke,
    answer,
    refusalFor: (i) => refusals.find((r) => r.paneId === i.paneId && r.to === i.signature)?.text,
  };
}
