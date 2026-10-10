import { useCallback, useEffect, useRef } from "react";

import { isLocked, useLocked } from "@/lib/idle";
import { onLiveEvent, type LiveEvent } from "@/lib/live-events";

export interface LivePoll<T> {
  /** Off: no reads, no timer. The idle cover and a hidden page pause it on their own. */
  enabled: boolean;
  /** A change restarts the loop (the pane, the session, a manual refresh counter). */
  deps: readonly unknown[];
  read: (signal: AbortSignal) => Promise<T>;
  onRead: (value: T) => void;
  /** The read failed; whatever the caller shows is now stale. */
  onFail: () => void;
  /** The fallback delay after a read, given the last value read. */
  delay: (last: T | undefined) => number;
  /** A live event that should trigger a read right away. */
  wakes: (event: LiveEvent) => boolean;
}

/**
 * A read kept fresh by the live stream with a fallback poll (ADR 0054). One read at a time: an event
 * during a read takes one more afterwards, since the read in flight may predate it. Pauses behind
 * the idle cover and while the page is hidden, and reads again on return or reconnect. Returns a
 * stable function that reads now.
 */
export function useLivePoll<T>(poll: LivePoll<T>): () => void {
  const locked = useLocked();
  const latest = useRef(poll);
  latest.current = poll;
  const poke = useRef<() => void>(() => {});
  const { enabled, deps } = poll;

  useEffect(() => {
    if (!enabled || locked) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let again = false;
    let last: T | undefined;

    async function run() {
      if (disposed || document.hidden || isLocked()) return;
      if (controller) return void (again = true);
      clearTimeout(timer);
      const request = (controller = new AbortController());
      try {
        const next = await latest.current.read(request.signal);
        if (disposed || request.signal.aborted) return;
        last = next;
        latest.current.onRead(next);
      } catch {
        if (!disposed && !request.signal.aborted) latest.current.onFail();
      } finally {
        if (controller === request) controller = undefined;
        if (again && !disposed) {
          again = false;
          void run();
        } else if (!disposed && !document.hidden) {
          timer = setTimeout(() => void run(), latest.current.delay(last));
        }
      }
    }
    const visibility = () => {
      if (!document.hidden) return void run();
      clearTimeout(timer);
      controller?.abort();
      controller = undefined;
    };
    poke.current = () => void run();
    const stopLive = onLiveEvent((event) => { if (latest.current.wakes(event)) void run(); });
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", visibility);
    void run();
    return () => {
      disposed = true;
      poke.current = () => {};
      clearTimeout(timer);
      controller?.abort();
      stopLive();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", visibility);
    };
    // The caller's deps name what restarts the loop; the callbacks are read through `latest`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, locked, ...deps]);

  return useCallback(() => poke.current(), []);
}
