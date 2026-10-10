import { useEffect, useRef } from "react";
import { useParams } from "react-router";

import { liveEventsUrl } from "@/lib/api";
import { useLocked } from "@/lib/idle";
import { connectLiveEvents, useMirrorShown } from "@/lib/live-events";

/** The stream URL, naming the pane whose mirror is on screen so the bridge watches it (ADR 0058). */
export function liveStreamUrl(session: string | undefined, watch: string | undefined): string {
  const base = liveEventsUrl(session);
  return watch ? `${base}${base.includes("?") ? "&" : "?"}watch=${encodeURIComponent(watch)}` : base;
}

/**
 * Hold the session's live-events stream open while someone can see the page. It closes behind the
 * idle cover and while the page is hidden, like polling pauses, and reopens on return. Each reader's
 * own wake-up refetch covers whatever changed meanwhile. The open pane is watched only while its
 * mirror (or a dialog drawn from it) is on screen; the conversation view needs no screen watching.
 */
export function useLiveEvents(session: string | undefined): void {
  const locked = useLocked();
  const { paneId } = useParams();
  const mirrorShown = useMirrorShown();
  const watch = paneId && mirrorShown ? paneId : undefined;
  const watchRef = useRef(watch);
  watchRef.current = watch;
  // The pane the open stream names, and how to swap that stream for one naming `watchRef.current`.
  const watched = useRef(watch);
  const swap = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (locked || typeof EventSource === "undefined") return;
    let stop: ((handover?: boolean) => void) | null = null;
    const open = (resync: boolean) => {
      watched.current = watchRef.current;
      return connectLiveEvents(liveStreamUrl(session, watchRef.current), undefined, { resync });
    };
    const sync = () => {
      if (document.hidden) {
        stop?.();
        stop = null;
      } else if (!stop) {
        stop = open(false);
      }
    };
    // Changing what is watched opens the new stream before closing the old one, so the store stays
    // healthy, and the new stream resyncs: an event published between the two would otherwise be lost.
    swap.current = () => {
      if (!stop) return;
      const previous = stop;
      stop = open(true);
      previous(true);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      swap.current = null;
      document.removeEventListener("visibilitychange", sync);
      stop?.();
    };
  }, [session, locked]);

  useEffect(() => {
    if (watched.current !== watch) swap.current?.();
  }, [watch]);
}
