import { type ReactNode, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Loader2, MessageSquare } from "lucide-react";

import { WorkActivityLabel } from "@/components/work-activity-label";
import { TranscriptView } from "@/components/transcript-view";
import { fetchHistory } from "@/lib/api";
import type { AgentStatus, PaneHistoryResponse } from "@/lib/types";
import { matchingEntries } from "@/lib/transcript-search";

interface LiveConversationProps {
  paneId: string;
  session?: string;
  agent?: string;
  activityStatus?: AgentStatus;
  history: PaneHistoryResponse | null;
  loading: boolean;
  error: boolean;
  onRetry?: () => void;
  recovery?: ReactNode;
  /** Change after a successful send to release the reading window and follow the latest turn. */
  followKey?: number;
  historyRequest?: number;
  searching?: boolean;
  query?: string;
  currentMatch?: number;
  onMatchCount?: (count: number) => void;
}

type AvailableHistory = Extract<PaneHistoryResponse, { available: true }>;
const OLDER_PAGE_SIZE = 120;
const UNAVAILABLE_COPY = {
  disabled: "Conversation history is disabled on this bridge.",
  "no-session": "Send the first message to start the conversation, or connect an existing session.",
  "no-log": "Waiting for the first conversation entry…",
};

/** Scope pagination to a pane/session without remounting the surrounding live composer. */
export const LiveConversation = memo(function LiveConversation(props: LiveConversationProps) {
  return <ScopedConversation key={JSON.stringify([props.paneId, props.session, props.history?.available ? props.history.sessionKey : null])} {...props} />;
});

/** Journal prose and tool calls; older pages stay inside this live, writable pane route. */
function ScopedConversation({ paneId, session, agent, activityStatus, history, loading, error, onRetry, recovery, followKey, historyRequest = 0, searching = false, query = "", currentMatch = 0, onMatchCount }: LiveConversationProps) {
  const [frozen, setFrozen] = useState<PaneHistoryResponse | null>(null);
  const [paused, setPaused] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const [olderStopped, setOlderStopped] = useState(false);
  const request = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  const restoring = useRef(false);
  const restoreFrame = useRef<number | null>(null);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const shown = frozen ?? history;
  const entries = shown?.available ? shown.entries : [];
  const latest = history?.available ? history.entries.at(-1) : undefined;
  const lastShown = entries.at(-1);
  const hasNew = frozen !== null && history?.available && (
    latest?.uuid !== lastShown?.uuid || latest?.turn?.status !== lastShown?.turn?.status ||
    latest?.turn?.durationMs !== lastShown?.turn?.durationMs
  );
  const matches = useMemo(() => matchingEntries(entries, query), [entries, query]);
  useEffect(() => { onMatchCount?.(matches.length); }, [matches.length, onMatchCount]);
  useEffect(() => {
    if (searching) {
      following.current = false;
      setPaused(true);
      setFrozen((current) => current ?? history);
    }
  }, [searching, history]);
  useEffect(() => {
    const uuid = entries[matches[currentMatch] ?? -1]?.uuid;
    if (!searching || !uuid) return;
    const target = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-turn]") ?? [])
      .find((element) => element.dataset.turn === uuid);
    target?.scrollIntoView({ block: "center" });
  }, [searching, currentMatch, matches, entries]);

  const cancelOlder = useCallback(() => {
    request.current?.abort();
    request.current = null;
  }, []);

  const followLatest = useCallback(() => {
    cancelOlder();
    anchor.current = null;
    following.current = true;
    setPaused(false);
    setFrozen(null);
    setLoadingOlder(false);
    setOlderError(false);
    setOlderStopped(false);
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  }, [cancelOlder]);

  // Also runs when a successful send occurs during an outstanding history request.
  useLayoutEffect(() => {
    followLatest();
  }, [followKey, followLatest]);

  useEffect(() => {
    if (historyRequest === 0) return;
    following.current = false;
    setPaused(true);
    setFrozen((current) => current ?? history);
    scrollRef.current?.scrollTo({ top: 0, behavior: "auto" });
    // The toolbar enters the same older-message flow; the composer and route stay mounted.
    void loadOlder();
  }, [historyRequest]);

  useEffect(() => () => {
    cancelOlder();
    if (restoreFrame.current !== null) cancelAnimationFrame(restoreFrame.current);
  }, [cancelOlder]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (anchor.current) {
      const saved = anchor.current;
      anchor.current = null;
      restoring.current = true;
      el.scrollTop = saved.top + (el.scrollHeight - saved.height);
      if (restoreFrame.current !== null) cancelAnimationFrame(restoreFrame.current);
      restoreFrame.current = requestAnimationFrame(() => { restoring.current = false; });
    } else if (following.current) {
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    }
  }, [entries]);

  // Follow viewport/content resizing (including the mobile keyboard) only while at the live tail.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following.current) el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    });
    observer.observe(el);
    observer.observe(content);
    return () => observer.disconnect();
  }, []);

  const onWorkToggle = useCallback((target: HTMLElement) => {
    const el = scrollRef.current;
    if (!el) return;
    const before = target.getBoundingClientRect().top;
    following.current = false;
    setPaused(true);
    setFrozen((current) => current ?? history);
    restoring.current = true;
    if (restoreFrame.current !== null) cancelAnimationFrame(restoreFrame.current);
    restoreFrame.current = requestAnimationFrame(() => {
      if (target.isConnected) el.scrollTop += target.getBoundingClientRect().top - before;
      restoring.current = false;
      restoreFrame.current = null;
    });
  }, [history]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el || restoring.current) return;
    const atBottom = Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) <= 24;
    if (atBottom) {
      if (!following.current) followLatest();
    } else {
      following.current = false;
      setPaused(true);
      setFrozen((current) => current ?? history);
    }
  }

  async function loadOlder() {
    if (request.current || olderStopped || !shown?.available || !shown.hasMore) return;
    const before = shown.entries[0]?.uuid;
    if (!before) return;
    const base: AvailableHistory = shown;
    const controller = new AbortController();
    request.current = controller;
    following.current = false;
    setPaused(true);
    setFrozen(base);
    setLoadingOlder(true);
    setOlderError(false);
    try {
      const page = await fetchHistory(paneId, { limit: OLDER_PAGE_SIZE, before }, session, controller.signal);
      if (request.current !== controller || controller.signal.aborted) return;
      if (page.paneId !== paneId) throw new Error("History response belongs to another pane");
      if (!page.available) {
        setOlderStopped(true);
        return;
      }
      const seen = new Set(base.entries.map((entry) => entry.uuid));
      const older = page.entries.filter((entry) => {
        if (seen.has(entry.uuid)) return false;
        seen.add(entry.uuid);
        return true;
      });
      // A tail-capped log or a missing cursor can return the same page. Stop at this boundary.
      if (older.length === 0) {
        setOlderStopped(true);
        return;
      }
      const el = scrollRef.current;
      anchor.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
      setFrozen({
        ...base,
        entries: [...older, ...base.entries],
        hasMore: page.hasMore,
        fileTruncated: base.fileTruncated || page.fileTruncated,
        total: Math.max(base.total, page.total),
      });
    } catch {
      if (request.current === controller && !controller.signal.aborted) setOlderError(true);
    } finally {
      if (request.current === controller) {
        request.current = null;
        setLoadingOlder(false);
      }
    }
  }

  let emptyCopy = "Waiting for the first conversation entry…";
  if (loading) emptyCopy = "Loading conversation…";
  else if (shown && !shown.available) emptyCopy = UNAVAILABLE_COPY[shown.reason];
  else if (error) emptyCopy = "Your draft is safe. Retry to load the conversation.";
  const canLoadOlder = shown?.available && shown.hasMore && !olderStopped;
  const historyBoundary = olderStopped || (shown?.available && shown.fileTruncated && !shown.hasMore);

  return (
    <section aria-label="Live conversation" className="flex h-full min-h-0 min-w-0 flex-col">
      {shown?.available && recovery && <details className="border-b px-4 text-sm text-muted-foreground">
        <summary className="min-h-11 cursor-pointer content-center">Change connected conversation</summary>
        <div className="max-h-[50dvh] overflow-y-auto pb-4">{recovery}</div>
      </details>}
      {error && (
        <div role="status" className="flex items-center justify-between gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
          <span>{entries.length ? "Conversation refresh failed. Showing the last update." : "Couldn't load the conversation."}</span>
          {onRetry && <button type="button" onClick={onRetry} className="min-h-11 shrink-0 rounded-md px-3 font-medium hover:bg-muted">Retry</button>}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} className="h-full min-w-0 overflow-y-auto overflow-x-hidden px-4 py-6 sm:px-8" style={{ overflowAnchor: "none" }}>
          <div ref={contentRef} className="mx-auto w-full max-w-3xl">
            {entries.length > 0 ? <>
              {(canLoadOlder || historyBoundary || olderError) && <div className="mb-6 text-center text-xs text-muted-foreground">
                {canLoadOlder && <button type="button" disabled={loadingOlder} onClick={() => void loadOlder()} className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 hover:bg-muted hover:text-foreground disabled:opacity-50">
                  {loadingOlder ? <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" /> : <ArrowUp aria-hidden="true" className="size-3" />}
                  {loadingOlder ? "Loading older messages…" : olderError ? "Retry older messages" : "Load older messages"}
                </button>}
                {olderError && <p role="status">Couldn't load older messages. Your conversation is still live.</p>}
                {historyBoundary && <p role="status">You've reached the oldest messages available from this session log.</p>}
              </div>}
              <TranscriptView entries={entries} agent={agent} query={query}
                focusedUuid={searching ? entries[matches[currentMatch] ?? -1]?.uuid : undefined}
                activityStatus={!error && !frozen ? activityStatus : undefined} onWorkToggle={onWorkToggle} />
            </> : <div className="flex flex-col items-center gap-3 px-4 py-16 text-center text-sm text-muted-foreground">
              {loading ? <Loader2 className="size-5 animate-spin motion-reduce:animate-none" /> : <MessageSquare className="size-5" />}
              <p>{emptyCopy}</p>
              {shown && !shown.available && shown.reason !== "disabled" && recovery}
              {!error && activityStatus === "working" && <WorkActivityLabel />}
            </div>}
          </div>
        </div>
        {paused && <button type="button" onClick={followLatest} aria-label="Scroll to latest" className="absolute bottom-3 left-1/2 z-10 flex min-h-9 -translate-x-1/2 items-center gap-1.5 rounded-full border border-border bg-background px-3 text-xs shadow-md hover:bg-muted">
          <ArrowDown aria-hidden="true" className="size-4" />{hasNew ? "New messages" : "Latest"}
        </button>}
      </div>
    </section>
  );
}
