import { useEffect } from "react";

import { liveEventsUrl } from "@/lib/api";
import { useLocked } from "@/lib/idle";
import { connectLiveEvents } from "@/lib/live-events";

/**
 * Hold the session's live-events stream open while someone can see the page. It closes behind the
 * idle cover and while the page is hidden, like polling pauses, and reopens on return. Each reader's
 * own wake-up refetch covers whatever changed meanwhile.
 */
export function useLiveEvents(session: string | undefined): void {
  const locked = useLocked();
  useEffect(() => {
    if (locked || typeof EventSource === "undefined") return;
    let stop: (() => void) | null = null;
    const sync = () => {
      if (document.hidden) {
        stop?.();
        stop = null;
      } else {
        stop ??= connectLiveEvents(liveEventsUrl(session));
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      stop?.();
    };
  }, [session, locked]);
}
