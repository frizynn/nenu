import { useCallback, useEffect, useRef, useState } from "react";
import { isLocked, useLocked } from "@/lib/idle";
import { concerns, isLiveHealthy, onLiveEvent } from "@/lib/live-events";
import { CONNECTION_LOST_MS } from "@/lib/connection-health";
import {
  fetchMessageQueue,
  changeMessageQueue,
  isDefiniteRefusal,
  type MessageQueuePage,
  type QueueMessage,
} from "@/lib/api";
import type { DeliveryMode, NativeQueueState, QueueWaitReason } from "@/lib/types";

// ── What each CLI does with a message that meets it busy (ADR 0056) ────────────────────────────────
//
// The bridge implements the measured table (bridge/queue-native.ts); this is the same table in the
// operator's words. Only a CLI whose probes measured both behaviours gets the send-time choice.

export interface BusyChoice {
  name: string;
  /** The mode "Send now" stores: Claude's Enter (its own queue) or Codex's Enter (a steer). */
  now: DeliveryMode;
  nowHint: string;
  laterHint: string;
}

const BUSY_CHOICES: Record<string, BusyChoice> = {
  claude: {
    name: "Claude",
    now: "asap",
    nowHint: "Goes into Claude's queue. Claude reads it after the step it's on.",
    laterHint: "Nenu holds it until Claude finishes this turn.",
  },
  codex: {
    name: "Codex",
    now: "steer",
    nowHint: "Steers this turn. Codex reads it after the step it's on.",
    laterHint: "Goes into Codex's queue and runs as the next turn.",
  },
};

/** The send-time choice for a busy agent, or null when this CLI has only one behaviour Nenu measured. */
export function busyChoiceFor(agent: string | null | undefined): BusyChoice | null {
  return (agent && BUSY_CHOICES[agent]) || null;
}

function agentName(agent: string | null | undefined): string {
  return busyChoiceFor(agent)?.name ?? "The agent";
}

/** A queue row as the operator sees it, whether it still waits in Nenu or was handed to the CLI. */
export interface QueueRowView {
  state: "queued" | "sending" | "paused" | "sent";
  deliveryMode?: DeliveryMode;
  waitingFor?: QueueWaitReason;
  stranded?: { reason: string; since: number };
  native?: NativeQueueState;
  error?: string;
}

export type QueueRowAction = "sendNow" | "edit" | "remove" | "readNow";

/**
 * One status line and the buttons that make sense for a row. The wording follows the agent and the
 * mode, and never claims more than the bridge knows: "read" comes only from Claude's own journal.
 */
export function queueRowStatus(
  agent: string | null | undefined,
  row: QueueRowView,
): { tone: "busy" | "waiting" | "done" | "problem"; label: string; actions: QueueRowAction[] } {
  const name = agentName(agent);
  if (row.stranded) return { tone: "problem", label: row.stranded.reason || "Its conversation is gone.", actions: ["sendNow", "remove"] };
  if (row.state === "sending") return { tone: "busy", label: "Sending…", actions: [] };
  if (row.state === "paused") return { tone: "problem", label: row.error || "Paused. Check the terminal.", actions: ["edit", "remove"] };
  if (row.state === "sent") {
    if (row.native === "enqueued") return { tone: "waiting", label: `In ${name}'s queue. ${name} reads it after the step it's on.`, actions: agent === "claude" ? ["readNow"] : [] };
    if (row.native === "absorbed") return { tone: "done", label: `Read by ${name}`, actions: [] };
    if (row.native === "recalled") return { tone: "problem", label: "Taken back into the terminal's input box", actions: [] };
    if (agent === "codex" && row.deliveryMode === "steer") return { tone: "done", label: "Sent into Codex's current turn", actions: [] };
    return { tone: "done", label: "Sent", actions: [] };
  }
  // "Send now" lifts the wait for the turn; a row already going as soon as it can has nothing to lift.
  const holds = row.deliveryMode === undefined || row.deliveryMode === "afterTurn";
  return { tone: "waiting", label: waitingLabel(name, row), actions: holds ? ["sendNow", "edit", "remove"] : ["edit", "remove"] };
}

function waitingLabel(name: string, row: QueueRowView): string {
  switch (row.waitingFor) {
    case "dialog":
      return "Waiting. Answer the dialog first.";
    case "draft":
      return "Waiting. The terminal's input box holds a draft.";
    case "disconnected":
      return "Waiting for the pane to reconnect.";
    case "turn-start":
      return `Waiting for ${name} to start on the previous message.`;
    case "working":
      return row.deliveryMode === "afterTurn" ? `Waiting for ${name} to finish this turn.` : `Waiting for ${name}'s input box.`;
    default:
      if (row.deliveryMode === "afterTurn") return `Queued. It goes when ${name} finishes this turn.`;
      return row.deliveryMode ? `Goes as soon as ${name}'s input box is free.` : "Waiting";
  }
}

/** A row the bridge delivered in the last minutes, with what the CLI's own queue did with it. */
export interface DeliveredRow {
  id: string;
  text: string;
  sentAt?: number;
  deliveryMode?: DeliveryMode;
  native?: NativeQueueState;
}

function deliveredRows(page: MessageQueuePage | null): DeliveredRow[] {
  // The bridge's queue page carries `delivered` (bridge/queue-service.ts); lib/api.ts types the rest.
  const value = page && "delivered" in page ? (page as { delivered?: unknown }).delivered : undefined;
  if (!Array.isArray(value)) return [];
  return value.filter(
    (row): row is DeliveredRow =>
      !!row && typeof row === "object" && typeof (row as DeliveredRow).id === "string" && typeof (row as DeliveredRow).text === "string",
  );
}

// ── The hook ─────────────────────────────────────────────────────────────────────────────────────

type PendingMessage = {
  id: string;
  text: string;
  scope: string;
  createdAt?: number;
  deliveryMode?: DeliveryMode;
};
// localStorage, so an add whose answer was lost survives the PWA being killed until the bridge acks it.
const RESEND_WINDOW_MS = 5 * 60_000;
/** Past the resend window, or for a conversation the pane no longer shows: the poll would never resend it. */
function expired(row: PendingMessage, scope: string): boolean {
  return row.scope !== scope || typeof row.createdAt !== "number" || Date.now() - row.createdAt >= RESEND_WINDOW_MS;
}
function readPending(key: string): PendingMessage | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "null");
    if (
      value &&
      typeof value === "object" &&
      "id" in value &&
      typeof value.id === "string" &&
      /^[a-zA-Z0-9_-]{1,80}$/.test(value.id) &&
      "text" in value &&
      typeof value.text === "string" &&
      "scope" in value &&
      typeof value.scope === "string"
    )
      return value as PendingMessage;
  } catch {
    /* Storage can be unavailable in private browsing. */
  }
  return null;
}
function savePending(key: string, value: PendingMessage | null) {
  try {
    if (value) localStorage.setItem(key, JSON.stringify(value));
    else localStorage.removeItem(key);
  } catch {
    /* In-memory retries remain available without storage. */
  }
}

/** The `now` action is newer than lib/api.ts's body type; the bridge validates it (queue-service.ts). */
type QueueChange = Parameters<typeof changeMessageQueue>[1];
type ReadNowChange = Omit<QueueChange, "action"> & { action: "now"; confirm: true };

export function useMessageQueue(
  paneId: string,
  session: string | undefined,
  enabled: boolean,
) {
  const locked = useLocked();
  const [page, setPage] = useState<MessageQueuePage | null>(null);
  const [error, setError] = useState("");
  const [refreshError, setRefreshError] = useState("");
  const [busy, setBusy] = useState(false);
  const mutating = useRef(false);
  const [accepted, setAccepted] = useState<{ id: string; text: string } | null>(
    null,
  );
  const current = useRef(`${paneId}:${session}`);
  current.current = `${paneId}:${session}`;
  const pending = useRef<PendingMessage | null>(null);
  const storageKey = `collie.queue.pending:${JSON.stringify([paneId, session])}`;
  useEffect(() => {
    setPage(null);
    setBusy(false);
    setError("");
    setRefreshError("");
    pending.current = readPending(storageKey);
    setAccepted(null);
    mutating.current = false;
  }, [paneId, session, storageKey]);
  useEffect(() => {
    if (!enabled || locked) return;
    const scope = current.current;
    let stopped = false;
    let failedAt: number | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    // A change announced mid-read may postdate it: read once more as soon as this one settles.
    let again = false;
    const poll = async () => {
      if (stopped || document.hidden || isLocked()) return;
      if (controller) {
        again = true;
        return;
      }
      controller = new AbortController();
      let resent: PendingMessage | null = null;
      try {
        let next = await fetchMessageQueue(paneId, session, controller.signal);
        const waiting = pending.current;
        if (!stopped && current.current === scope && next.available && waiting && expired(waiting, next.scope)) {
          savePending(storageKey, null);
          pending.current = null;
        } else if (
          !stopped &&
          current.current === scope &&
          !mutating.current &&
          next.available &&
          waiting
        ) {
          // The read already succeeded: show it even if the resend fails, so the composer keeps
          // routing this text through the queue instead of falling back to a direct send.
          if (!stopped && current.current === scope) setPage(next);
          resent = waiting;
          next = await changeMessageQueue(
            paneId,
            {
              scope: waiting.scope,
              action: "add",
              id: waiting.id,
              text: waiting.text,
              ...(waiting.deliveryMode ? { deliveryMode: waiting.deliveryMode } : {}),
            },
            session,
          );
          if (!stopped && current.current === scope && next.available) {
            savePending(storageKey, null);
            if (pending.current?.id === waiting.id) pending.current = null;
            setAccepted({ id: waiting.id, text: waiting.text });
            setError("");
          }
        }
        if (!stopped && current.current === scope) {
          setPage(next);
          failedAt = null;
          setRefreshError("");
        }
      } catch (failure) {
        // The bridge refused the resent add outright: resending it for minutes would never land.
        if (resent && pending.current?.id === resent.id && isDefiniteRefusal(failure)) {
          savePending(storageKey, null);
          pending.current = null;
        }
        if (!stopped && !controller.signal.aborted) {
          failedAt ??= Date.now();
          if (Date.now() - failedAt >= CONNECTION_LOST_MS)
            setRefreshError("Could not refresh the queue.");
        }
      } finally {
        controller = undefined;
        if (!stopped && again) {
          again = false;
          void poll();
        } else if (!stopped) {
          // Every queue change is announced on the live stream; while it is up this is the fallback.
          timer = setTimeout(poll, isLiveHealthy() ? 10_000 : 3000);
        }
      }
    };
    const wake = () => {
      clearTimeout(timer);
      void poll();
    };
    void poll();
    const unsubscribe = onLiveEvent((event) => {
      if (concerns(event, "queue", paneId)) wake();
    });
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      unsubscribe();
      clearTimeout(timer);
      controller?.abort();
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [paneId, session, enabled, locked, storageKey]);

  /**
   * One queue write. True once the bridge saved it and the page still belongs to this pane.
   * `onRefused` runs when the bridge answered no, so the write is known not to have happened.
   */
  const write = useCallback(
    async (
      body: (scope: string) => QueueChange | ReadNowChange,
      onSaved?: () => void,
      onRefused?: () => void,
    ): Promise<boolean> => {
      if (!page?.available || mutating.current) return false;
      mutating.current = true;
      const key = current.current;
      setBusy(true);
      setError("");
      try {
        const next = await changeMessageQueue(paneId, body(page.scope) as QueueChange, session);
        if (!next.available) {
          onRefused?.();
          throw new Error(
            "The connected conversation is unavailable. Your draft was kept.",
          );
        }
        onSaved?.();
        if (current.current === key) setPage(next);
        return current.current === key;
      } catch (failure) {
        if (isDefiniteRefusal(failure)) onRefused?.();
        if (current.current === key)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not update the queue.",
          );
        return false;
      } finally {
        if (current.current === key) {
          setBusy(false);
          mutating.current = false;
        }
      }
    },
    [page, paneId, session],
  );

  /** The add still waiting for the bridge's answer in this conversation; an expired one is dropped. */
  const pendingFor = useCallback(
    (scope: string): PendingMessage | null => {
      pending.current ??= readPending(storageKey);
      if (pending.current && expired(pending.current, scope)) {
        savePending(storageKey, null);
        pending.current = null;
      }
      return pending.current;
    },
    [storageKey],
  );
  /** A pending add the operator's next send of the same text must reuse, so it is delivered once. */
  const pendingAdd = useCallback(
    (): { text: string; deliveryMode: DeliveryMode } | null => {
      const row = page?.available ? pendingFor(page.scope) : null;
      return row ? { text: row.text, deliveryMode: row.deliveryMode ?? "afterTurn" } : null;
    },
    [page, pendingFor],
  );

  /**
   * Queue a message with the operator's choice of mode. The row id is minted here and kept in
   * localStorage until the bridge acknowledges it, so a lost answer is retried with the same id.
   * Resolves the row id, or null when it was not saved.
   */
  const add = useCallback(
    async (text: string, deliveryMode: DeliveryMode): Promise<string | null> => {
      if (!page?.available || mutating.current) return null;
      const waiting = pendingFor(page.scope);
      if (waiting && waiting.text !== text) {
        setError(
          "The previous message is still being saved. Keep this draft until it reconnects.",
        );
        return null;
      }
      // The same text in another mode is a new request: the operator's latest pick is what goes.
      const row =
        waiting && (waiting.deliveryMode ?? "afterTurn") === deliveryMode
          ? waiting
          : { id: crypto.randomUUID(), text, scope: page.scope, createdAt: Date.now(), deliveryMode };
      pending.current = row;
      savePending(storageKey, row);
      const key = current.current;
      // Only a lost answer keeps the row for a resend. A refusal (too long, terminal controls, a full
      // queue) would be refused again, and would hold every later send in this conversation.
      const forget = () => {
        savePending(storageKey, null);
        if (pending.current?.id === row.id) pending.current = null;
      };
      const saved = await write(
        (scope) => ({ scope, action: "add", id: row.id, text, deliveryMode }),
        () => savePending(storageKey, null),
        forget,
      );
      if (!saved) return null;
      if (current.current === key) {
        setAccepted({ id: row.id, text });
        pending.current = null;
      }
      return row.id;
    },
    [page, pendingFor, storageKey, write],
  );

  const mutate = useCallback(
    async (
      action: "add" | "edit" | "remove" | "send",
      text?: string,
      item?: QueueMessage,
    ): Promise<boolean> => {
      // Callers that predate the send-time choice queue for after the turn, as the queue always did.
      if (action === "add") return (await add(text!, "afterTurn")) !== null;
      if (!item) return false;
      return write((scope) => ({ scope, action, id: item.id, text, revision: item.revision }));
    },
    [add, write],
  );

  /** "Read it now": Claude's send-now chord for a row its own queue still holds. Confirmed by the caller. */
  const readNow = useCallback(
    (id: string) => write((scope) => ({ scope, action: "now", id, confirm: true })),
    [write],
  );

  return { page, delivered: deliveredRows(page), error, refreshError, busy, add, pendingAdd, mutate, readNow, accepted };
}
