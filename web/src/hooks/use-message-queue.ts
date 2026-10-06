import { useCallback, useEffect, useRef, useState } from "react";
import { isLocked, useLocked } from "@/lib/idle";
import { concerns, isLiveHealthy, onLiveEvent } from "@/lib/live-events";
import { CONNECTION_LOST_MS } from "@/lib/connection-health";
import {
  fetchMessageQueue,
  changeMessageQueue,
  type MessageQueuePage,
  type QueueMessage,
} from "@/lib/api";

type PendingMessage = {
  id: string;
  text: string;
  scope: string;
  createdAt?: number;
};
function readPending(key: string): PendingMessage | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(key) ?? "null");
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
    if (value) sessionStorage.setItem(key, JSON.stringify(value));
    else sessionStorage.removeItem(key);
  } catch {
    /* In-memory retries remain available without storage. */
  }
}

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
      try {
        let next = await fetchMessageQueue(paneId, session, controller.signal);
        const waiting = pending.current;
        if (
          !stopped &&
          current.current === scope &&
          !mutating.current &&
          next.available &&
          waiting?.scope === next.scope &&
          typeof waiting.createdAt === "number" &&
          Date.now() - waiting.createdAt < 5 * 60_000
        ) {
          next = await changeMessageQueue(
            paneId,
            {
              scope: waiting.scope,
              action: "add",
              id: waiting.id,
              text: waiting.text,
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
      } catch {
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
  const mutate = useCallback(
    async (
      action: "add" | "edit" | "remove" | "send",
      text?: string,
      item?: QueueMessage,
    ) => {
      if (!page?.available || mutating.current) return false;
      mutating.current = true;
      const key = current.current;
      setBusy(true);
      setError("");
      if (
        action === "add" &&
        pending.current &&
        (pending.current.text !== text || pending.current.scope !== page.scope)
      ) {
        setError(
          "The previous message is still being saved. Keep this draft until it reconnects.",
        );
        setBusy(false);
        mutating.current = false;
        return false;
      }
      if (action === "add" && !pending.current)
        pending.current = readPending(storageKey);
      if (
        action === "add" &&
        (!pending.current ||
          pending.current.text !== text ||
          pending.current.scope !== page.scope)
      )
        pending.current = {
          id: crypto.randomUUID(),
          text: text!,
          scope: page.scope,
          createdAt: Date.now(),
        };
      if (action === "add") savePending(storageKey, pending.current);
      try {
        const next = await changeMessageQueue(
          paneId,
          {
            scope: page.scope,
            action,
            id: item?.id ?? pending.current!.id,
            text,
            revision: item?.revision,
          },
          session,
        );
        if (!next.available)
          throw new Error(
            "The connected conversation is unavailable. Your draft was kept.",
          );
        if (action === "add") savePending(storageKey, null);
        if (current.current === key) {
          setPage(next);
          if (action === "add") {
            setAccepted({ id: pending.current?.id ?? "", text: text! });
            pending.current = null;
          }
        }
        return current.current === key;
      } catch (failure) {
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
    [page, busy, paneId, session, storageKey],
  );
  return { page, error, refreshError, busy, mutate, accepted };
}
