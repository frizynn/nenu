import { useEffect, useState } from "react";
import { fetchActivity, fetchWorkflowDetail, type ActivityResponse, type WorkflowDetailResponse } from "@/lib/activity";
import { isLocked, useLocked } from "@/lib/idle";
import { isLiveHealthy, onLiveEvent, type LiveEvent } from "@/lib/live-events";

/** Fallback poll: brisk while something runs, relaxed when the session is quiet or the stream is up. */
export const ACTIVITY_POLL_MS = { running: 5_000, quiet: 20_000, live: 30_000 } as const;

/**
 * Whether a live event asks this pane's activity to refresh. "activity" is the reader's own topic;
 * a "journal" change for the pane also counts, because launches and task notifications land in
 * the session log. Compared as a string so it works before the shared LiveTopic union names it.
 */
export function activityConcerns(event: LiveEvent, paneId: string): boolean {
  if (event.topic === "resync") return true;
  const topic: string = event.topic;
  return (topic === "activity" || topic === "journal") && event.paneId === paneId;
}

export interface ActivityState {
  data: ActivityResponse | null;
  /** The last refresh failed; `data` is what was last known. */
  stale: boolean;
  refresh: () => void;
}

/**
 * The background work of the Claude session in `paneId`. Pauses behind the idle cover and while the
 * page is hidden, wakes on a matching live event, and keeps a fallback poll (ADR 0054).
 */
export function useActivity(paneId: string, session?: string, enabled = true): ActivityState {
  const locked = useLocked();
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [stale, setStale] = useState(false);
  const [tick, setTick] = useState(0);
  const scope = JSON.stringify([paneId, session]);

  useEffect(() => {
    setData(null);
    setStale(false);
  }, [scope]);

  useEffect(() => {
    if (!enabled || locked) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let running = false;
    let again = false;

    async function poll() {
      if (disposed || document.hidden || isLocked()) return;
      // An event during a read means the read may already be stale; take one more afterwards.
      if (controller) return void (again = true);
      clearTimeout(timer);
      const request = (controller = new AbortController());
      try {
        const next = await fetchActivity(paneId, session, request.signal);
        if (disposed || request.signal.aborted) return;
        setData(next);
        setStale(false);
        running = next.available && (next.workflows.some((w) => w.status === "running") || next.tasks.some((t) => t.status === "running"));
      } catch {
        if (!disposed && !request.signal.aborted) setStale(true);
      } finally {
        if (controller === request) controller = undefined;
        if (again && !disposed) {
          again = false;
          void poll();
        } else if (!disposed && !document.hidden) {
          const delay = isLiveHealthy() ? ACTIVITY_POLL_MS.live : running ? ACTIVITY_POLL_MS.running : ACTIVITY_POLL_MS.quiet;
          timer = setTimeout(() => void poll(), delay);
        }
      }
    }
    const visibility = () => {
      if (!document.hidden) return void poll();
      clearTimeout(timer);
      controller?.abort();
      controller = undefined;
    };
    const stopLive = onLiveEvent((event) => { if (activityConcerns(event, paneId)) void poll(); });
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", visibility);
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller?.abort();
      stopLive();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", visibility);
    };
  }, [scope, paneId, session, enabled, locked, tick]);

  return { data, stale, refresh: () => setTick((n) => n + 1) };
}

/**
 * One workflow with its agents' return values, re-read whenever the activity list behind it
 * changes (`version`, e.g. the list's own data object). Null until the first answer.
 */
export function useWorkflowDetail(paneId: string, runId: string | null, session?: string, version?: unknown): { detail: WorkflowDetailResponse | null; failed: boolean } {
  const [detail, setDetail] = useState<WorkflowDetailResponse | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setDetail(null); setFailed(false); }, [paneId, runId, session]);
  useEffect(() => {
    if (!runId) return;
    const controller = new AbortController();
    fetchWorkflowDetail(paneId, runId, session, controller.signal).then(
      (next) => { setDetail(next); setFailed(false); },
      () => { if (!controller.signal.aborted) setFailed(true); },
    );
    return () => controller.abort();
  }, [paneId, runId, session, version]);
  return { detail, failed };
}
