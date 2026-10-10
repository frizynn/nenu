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
  // A stream reopened only to start watching a pane resyncs, so a mirror that just came on screen
  // is read now rather than at its next change.
  const watched = useRef(watch);
  useEffect(() => {
    let resync = watch !== undefined && watched.current !== watch;
    watched.current = watch;
    if (locked || typeof EventSource === "undefined") return;
    let stop: (() => void) | null = null;
    const sync = () => {
      if (document.hidden) {
        stop?.();
        stop = null;
      } else if (!stop) {
        stop = connectLiveEvents(liveStreamUrl(session, watch), undefined, { resync });
        resync = false;
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      document.removeEventListener("visibilitychange", sync);
      stop?.();
    };
  }, [session, locked, watch]);
}
