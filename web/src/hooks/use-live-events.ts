import { useEffect, useRef, useSyncExternalStore } from "react";
import { useParams } from "react-router";

import { liveEventsUrl } from "@/lib/api";
import { useLocked } from "@/lib/idle";
import { connectLiveEvents, useMirrorShown } from "@/lib/live-events";

/** The stream URL, naming every pane whose mirror is on screen so the bridge watches it (ADR 0058). */
export function liveStreamUrl(session: string | undefined, watch: string | readonly string[] | undefined): string {
  const base = liveEventsUrl(session);
  const panes = typeof watch === "string" ? [watch] : watch ?? [];
  if (panes.length === 0) return base;
  const query = panes.map((id) => `watch=${encodeURIComponent(id)}`).join("&");
  return `${base}${base.includes("?") ? "&" : "?"}${query}`;
}

// Panes other than the route's own whose mirror is on screen, such as a thread docked beside its
// coordinator. Counted, so two views of one pane release it only when both are gone.
const docked = new Map<string, number>();
const dockedListeners = new Set<() => void>();
let dockedKey = "";

function setDocked(paneId: string, delta: 1 | -1): void {
  const count = (docked.get(paneId) ?? 0) + delta;
  if (count > 0) docked.set(paneId, count);
  else docked.delete(paneId);
  dockedKey = [...docked.keys()].sort().join("\n");
  for (const fn of dockedListeners) fn();
}

function useDockedKey(): string {
  return useSyncExternalStore(
    (fn) => { dockedListeners.add(fn); return () => { dockedListeners.delete(fn); }; },
    () => dockedKey,
    () => dockedKey,
  );
}

/** Ask the bridge to watch `paneId`'s screen while this component shows it; undefined watches nothing. */
export function useWatchPane(paneId: string | undefined): void {
  useEffect(() => {
    if (!paneId) return;
    setDocked(paneId, 1);
    return () => setDocked(paneId, -1);
  }, [paneId]);
}

/** Test-only. */
export function resetWatchedPanes(): void {
  docked.clear();
  dockedKey = "";
}

/**
 * Hold the session's live-events stream open while someone can see the page. It closes behind the
 * idle cover and while the page is hidden, like polling pauses, and reopens on return. Each reader's
 * own wake-up refetch covers whatever changed meanwhile. The open pane is watched only while its
 * mirror (or a dialog drawn from it) is on screen, plus any pane a docked view registered; the
 * conversation view needs no screen watching.
 */
export function useLiveEvents(session: string | undefined): void {
  const locked = useLocked();
  const { paneId } = useParams();
  const mirrorShown = useMirrorShown();
  const others = useDockedKey();
  const watch = [...new Set([...(paneId && mirrorShown ? [paneId] : []), ...(others ? others.split("\n") : [])])].join("\n");
  const watchRef = useRef(watch);
  watchRef.current = watch;
  // The panes the open stream names, and how to swap that stream for one naming `watchRef.current`.
  const watched = useRef(watch);
  const swap = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (locked || typeof EventSource === "undefined") return;
    let stop: ((handover?: boolean) => void) | null = null;
    const open = (resync: boolean) => {
      watched.current = watchRef.current;
      return connectLiveEvents(liveStreamUrl(session, watchRef.current ? watchRef.current.split("\n") : undefined), undefined, { resync });
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
