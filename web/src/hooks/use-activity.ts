import { useEffect, useState } from "react";
import { fetchActivity, fetchWorkflowDetail, type ActivityResponse, type WorkflowDetailResponse } from "@/lib/activity";
import { concerns, isLiveHealthy, type LiveEvent } from "@/lib/live-events";
import { useLivePoll } from "./use-live-poll";

/** Fallback poll: brisk while something runs, relaxed when the session is quiet or the stream is up. */
export const ACTIVITY_POLL_MS = { running: 5_000, quiet: 20_000, live: 30_000 } as const;

/**
 * Whether a live event asks this pane's activity to refresh. "activity" is the reader's own topic;
 * a "journal" change for the pane also counts, because launches and task notifications land in
 * the session log.
 */
export function activityConcerns(event: LiveEvent, paneId: string): boolean {
  return concerns(event, "activity", paneId) || concerns(event, "journal", paneId);
}

export interface ActivityState {
  data: ActivityResponse | null;
  /** The last refresh failed; `data` is what was last known. */
  stale: boolean;
  refresh: () => void;
}

const anyRunning = (res: ActivityResponse | undefined) =>
  !!res?.available && (res.workflows.some((w) => w.status === "running") || res.tasks.some((t) => t.status === "running"));

/**
 * The background work of the Claude session in `paneId`. Pauses behind the idle cover and while the
 * page is hidden, wakes on a matching live event, and keeps a fallback poll (ADR 0054).
 */
export function useActivity(paneId: string, session?: string, enabled = true): ActivityState {
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [stale, setStale] = useState(false);
  const [tick, setTick] = useState(0);
  const scope = JSON.stringify([paneId, session]);

  useEffect(() => {
    setData(null);
    setStale(false);
  }, [scope]);

  useLivePoll<ActivityResponse>({
    enabled,
    deps: [scope, tick],
    read: (signal) => fetchActivity(paneId, session, signal),
    onRead: (next) => { setData(next); setStale(false); },
    onFail: () => setStale(true),
    delay: (last) => isLiveHealthy() ? ACTIVITY_POLL_MS.live : anyRunning(last) ? ACTIVITY_POLL_MS.running : ACTIVITY_POLL_MS.quiet,
    wakes: (event) => activityConcerns(event, paneId),
  });

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
