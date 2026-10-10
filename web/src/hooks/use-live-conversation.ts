import { useCallback, useEffect, useRef, useState } from "react";

import { fetchHistory, isApiErrorStatus } from "@/lib/api";
import { CONNECTION_LOST_MS } from "@/lib/connection-health";
import { isLocked, useLocked } from "@/lib/idle";
import { concerns, isLiveHealthy, onLiveEvent, useLiveHealthy } from "@/lib/live-events";
import type { PaneHistoryResponse } from "@/lib/types";

interface LiveConversationOptions {
  paneId: string;
  session?: string;
  enabled: boolean;
  busy?: boolean;
  paused?: boolean;
}

interface ConversationState {
  scope: string;
  history: PaneHistoryResponse | null;
  loading: boolean;
  error: boolean;
}

const BUSY_MS = 1_500;
const IDLE_MS = 12_000;
// While the live stream is up the bridge watches the journal and names each append (ADR 0058), so a
// busy transcript only needs the safety-net poll.
const LIVE_BUSY_MS = 10_000;

/** A small, newest-anchored journal window; the history route owns older turns. */
export function useLiveConversation({
  paneId,
  session,
  enabled,
  busy = false,
  paused = false,
}: LiveConversationOptions) {
  const scope = JSON.stringify([paneId, session ?? null]);
  const [state, setState] = useState<ConversationState>({
    scope,
    history: null,
    loading: false,
    error: false,
  });
  const stateRef = useRef(state);
  stateRef.current = state;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const refreshRef = useRef<(queueIfPending?: boolean) => void>(() => {});
  const locked = useLocked();
  const previousActivity = useRef({ scope, enabled, locked, busy });

  useEffect(() => {
    if (!enabled || !paneId || locked || paused) return;
    let disposed = false;
    const publish = (next: ConversationState) => { stateRef.current = next; setState(next); };
    let timer: ReturnType<typeof setTimeout> | undefined;
    let request: AbortController | undefined;
    let refreshQueued = false;
    let failedAt: number | null = null;

    const schedule = () => {
      clearTimeout(timer);
      if (!disposed && !document.hidden && !isLocked()) {
        const cadence = !busyRef.current ? IDLE_MS : isLiveHealthy() ? LIVE_BUSY_MS : BUSY_MS;
        timer = setTimeout(() => void poll(), failedAt !== null ? 3_000 : stateRef.current.history?.available === false ? 2_000 : cadence);
      }
    };

    async function poll(queueIfPending = false) {
      if (disposed || document.hidden || isLocked()) return;
      if (request) {
        if (queueIfPending) refreshQueued = true;
        return;
      }
      clearTimeout(timer);
      const controller = new AbortController();
      request = controller;
      if (stateRef.current.scope !== scope || !stateRef.current.history) {
        publish({ scope, history: null, loading: true, error: false });
      }
      try {
        const history = await fetchHistory(paneId, { limit: 60 }, session, controller.signal);
        if (!disposed && !controller.signal.aborted) {
          failedAt = null;
          const previous = stateRef.current;
          if (previous.scope !== scope || previous.history !== history || previous.loading || previous.error) {
            publish({ scope, history, loading: false, error: false });
          }
        }
      } catch (error) {
        if (!disposed && !controller.signal.aborted) {
          const authError = isApiErrorStatus(error, 401) || isApiErrorStatus(error, 403);
          failedAt ??= Date.now();
          const visibleError = authError || !stateRef.current.history || Date.now() - failedAt >= CONNECTION_LOST_MS;
          publish({ ...stateRef.current, history: authError ? null : stateRef.current.history, loading: false, error: visibleError });
        }
      } finally {
        // A visibility reset can already own a newer request. Its completion owns scheduling.
        if (request === controller) {
          request = undefined;
          if (!disposed) {
            if (refreshQueued) { refreshQueued = false; void poll(); }
            else schedule();
          }
        }
      }
    }

    const wake = () => void poll();
    const visibility = () => {
      if (document.hidden) {
        clearTimeout(timer);
        request?.abort();
        request = undefined;
        refreshQueued = false;
      } else {
        wake();
      }
    };
    refreshRef.current = (queueIfPending) => void poll(queueIfPending);
    window.addEventListener("focus", wake);
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", visibility);
    wake();
    return () => {
      disposed = true;
      clearTimeout(timer);
      request?.abort();
      refreshRef.current = () => {};
      window.removeEventListener("focus", wake);
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [paneId, session, scope, enabled, locked, paused]);

  useEffect(() => {
    const before = previousActivity.current;
    previousActivity.current = { scope, enabled, locked, busy };
    // A new scope/resume already starts its own read. Only activity edges need an extra catch-up;
    // queue one if a read is pending so completion metadata with the same UUID is not missed.
    if (before.scope === scope && before.enabled === enabled && before.locked === locked && before.busy !== busy) {
      refreshRef.current(true);
    }
  }, [scope, enabled, locked, busy]);

  // The bridge names a transcript change (an append, a status flip, a delivered queue message) as it
  // happens.
  useEffect(() => onLiveEvent((event) => {
    if (concerns(event, "journal", paneId)) refreshRef.current(true);
  }), [paneId]);

  // The stream dropped: appends may have gone unannounced, so read now and go back to the fast poll.
  const liveHealthy = useLiveHealthy();
  const wasHealthy = useRef(liveHealthy);
  useEffect(() => {
    if (wasHealthy.current && !liveHealthy) refreshRef.current(true);
    wasHealthy.current = liveHealthy;
  }, [liveHealthy]);

  const refresh = useCallback(() => refreshRef.current(true), []);
  const current = state.scope === scope && enabled;
  return {
    history: current ? state.history : null,
    loading: current && !locked && !paused ? state.loading : false,
    error: current ? state.error : false,
    refresh,
  };
}
