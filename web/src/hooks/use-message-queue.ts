import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchMessageQueue,
  changeMessageQueue,
  type MessageQueuePage,
  type QueueMessage,
} from "@/lib/api";

export function useMessageQueue(
  paneId: string,
  session: string | undefined,
  enabled: boolean,
) {
  const [page, setPage] = useState<MessageQueuePage | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = useRef(`${paneId}:${session}`);
  current.current = `${paneId}:${session}`;
  const pending = useRef<{ id: string; text: string; scope: string } | null>(
    null,
  );
  useEffect(() => {
    setPage(null);
    setBusy(false);
    setError("");
    pending.current = null;
  }, [paneId, session]);
  useEffect(() => {
    if (!enabled) return;
    const scope = current.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let controller: AbortController | undefined;
    const poll = async () => {
      if (stopped || document.hidden || controller) return;
      controller = new AbortController();
      try {
        const next = await fetchMessageQueue(
          paneId,
          session,
          controller.signal,
        );
        if (!stopped && current.current === scope) {
          setPage(next);
          setError("");
        }
      } catch {
        if (!stopped && !controller.signal.aborted)
          setError("Could not refresh the queue.");
      } finally {
        controller = undefined;
        if (!stopped) timer = setTimeout(poll, 3000);
      }
    };
    const wake = () => {
      clearTimeout(timer);
      void poll();
    };
    void poll();
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [paneId, session, enabled]);
  const mutate = useCallback(
    async (
      action: "add" | "edit" | "remove" | "send",
      text?: string,
      item?: QueueMessage,
    ) => {
      if (!page?.available || busy) return false;
      const key = current.current;
      setBusy(true);
      setError("");
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
        };
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
        if (current.current === key) {
          setPage(next);
          if (action === "add") pending.current = null;
        }
        return true;
      } catch (failure) {
        if (current.current === key)
          setError(
            failure instanceof Error
              ? failure.message
              : "Could not update the queue.",
          );
        return false;
      } finally {
        if (current.current === key) setBusy(false);
      }
    },
    [page, busy, paneId, session],
  );
  return { page, error, busy, mutate };
}
