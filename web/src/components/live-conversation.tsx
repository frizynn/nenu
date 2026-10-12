import { type ReactNode, type TouchEvent as ReactTouchEvent, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, Loader2, MessageSquare } from "lucide-react";

import { WorkActivityLabel } from "@/components/work-activity-label";
import { thirdScrollTop } from "@/components/find-bar";
import { TranscriptView } from "@/components/transcript-view";
import { fetchHistory } from "@/lib/api";
import type { AgentStatus, PaneHistoryResponse, TranscriptEntry } from "@/lib/types";
import { matchingEntries } from "@/lib/transcript-search";
import { PendingTurns } from "@/components/pending-turns";
import { atTail, isTextField, useEditShift } from "@/hooks/use-auto-scroll";
import { TURN_PENDING_MS } from "@/hooks/use-stop-turn";
import { localSendScope, reconcileLocalSends, useLocalSendActions, useLocalSends } from "@/lib/local-sends";
import { ScrollToLatest } from "@/components/ui/chat/scroll-to-latest";
import { RecoveryLeads } from "@/components/connect-conversation";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/utils";

interface LiveConversationProps {
  paneId: string;
  session?: string;
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
  /** Rendered after the newest turn, inside the scroller (a coordinator's thread cards, the question card). */
  footer?: ReactNode;
  /** A question waits at the tail: the way back to it says so. */
  waiting?: boolean;
}

type AvailableHistory = Extract<PaneHistoryResponse, { available: true }>;
const OLDER_PAGE_SIZE = 120;
/** How close to the top, in px, a reader moving up gets before the next older page starts loading. */
const OLDER_PAGE_MARGIN = 800;
/** Room kept above a `[data-follow-stop]` element when following lands on it. */
const STOP_MARGIN = 12;

/**
 * Where following stops for a question at the tail taller than the list: its first line. Null when
 * there is none or it fits, so the bottom is the stop.
 */
function stopCap(el: HTMLElement): number | null {
  const stop = el.querySelector<HTMLElement>("[data-follow-stop]");
  if (!stop) return null;
  const cap = el.scrollTop + stop.getBoundingClientRect().top - el.getBoundingClientRect().top - STOP_MARGIN;
  return cap < el.scrollHeight - el.clientHeight ? cap : null;
}

/** How far a finger moves before a touch is a drag, not a tap. */
const TAP_SLOP = 10;
/** A drag down this far on the thread closes the phone keyboard. */
const DISMISS_DRAG = 32;
const CONTROL = "button, a[href], input, textarea, select, label, summary, [role='button'], [contenteditable]";

/**
 * Close the phone keyboard by blurring the field that holds it, unless the touch landed in that
 * field. The draft stays in the box. iOS keeps the keyboard up over a tap on plain text, so the
 * thread does it, as Messages does.
 */
function dismissKeyboard(target: EventTarget): void {
  const field = document.activeElement;
  if (isTextField(field) && !(target instanceof Node && field.contains(target))) field.blur();
}

/** A message as a reader counts one: someone's words or images, not a tool call or a note. */
function spoken(entry: TranscriptEntry): boolean {
  return (entry.role === "user" || entry.role === "assistant") && entry.parts.some((part) => part.kind === "text" || part.kind === "image");
}

/**
 * The held window with each call's result where the live window has it: a call that finished while
 * the reader held the thread says so on its row. Nothing else in the window moves. The same window
 * comes back when no result landed, so a held thread does not redraw on every poll.
 */
function withResults(held: AvailableHistory, live: TranscriptEntry[]): AvailableHistory {
  const now = new Map(live.map((entry) => [entry.uuid, entry]));
  const landed = (entry: TranscriptEntry, index: number) => {
    const part = now.get(entry.uuid)?.parts[index];
    return part?.kind === "tool" ? part.result : undefined;
  };
  let changed = false;
  const entries = held.entries.map((entry) => {
    if (!entry.parts.some((part, index) => part.kind === "tool" && !part.result && landed(entry, index))) return entry;
    changed = true;
    return { ...entry, parts: entry.parts.map((part, index) => {
      const result = part.kind === "tool" && !part.result ? landed(entry, index) : undefined;
      return result ? { ...part, result } : part;
    }) };
  });
  return changed ? { ...held, entries } : held;
}

/** The operator is typing in a box inside the question (a reply, a note). */
function typingIn(el: HTMLElement): boolean {
  const active = document.activeElement;
  return isTextField(active) && Boolean(active.closest("[data-follow-stop]")) && el.contains(active);
}
const UNAVAILABLE_COPY = {
  disabled: "Conversation history is disabled on this bridge.",
  "no-session": "Send the first message to start the conversation.",
  "no-log": "Waiting for the first conversation entry…",
};

/**
 * The thread's shape while its first page loads: an answer, a message of yours, an answer, at the
 * foot of the list where the tail will land, so the turns replace it without a jump.
 */
function TranscriptSkeleton() {
  const lines = (widths: string[]) => (
    <div data-skeleton-turn className="space-y-3 px-0.5 py-1.5">
      {widths.map((width) => <div key={width} className="h-3 rounded-full bg-muted" style={{ width }} />)}
    </div>
  );
  return (
    <div role="status" data-slot="transcript-skeleton" className="flex flex-col gap-6 animate-pulse motion-reduce:animate-none">
      <span className="sr-only">Loading conversation…</span>
      {lines(["92%", "64%"])}
      <div data-skeleton-turn className="flex justify-end"><div className="h-16 w-3/5 rounded-xl rounded-br-md bg-muted" /></div>
      {lines(["96%", "88%", "52%"])}
    </div>
  );
}

/** Scope pagination to a pane/session without remounting the surrounding live composer. */
export const LiveConversation = memo(function LiveConversation(props: LiveConversationProps) {
  return <ScopedConversation key={JSON.stringify([props.paneId, props.session, props.history?.available ? props.history.sessionKey : null])} {...props} />;
});

/** Journal prose and tool calls; older pages stay inside this live, writable pane route. */
function ScopedConversation({ paneId, session, activityStatus, history, loading, error, onRetry, recovery, followKey, historyRequest = 0, searching = false, query = "", currentMatch = 0, onMatchCount, footer, waiting = false }: LiveConversationProps) {
  const [frozen, setFrozen] = useState<PaneHistoryResponse | null>(null);
  const [paused, setPaused] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderError, setOlderError] = useState(false);
  const [olderStopped, setOlderStopped] = useState(false);
  const request = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const following = useRef(true);
  // Where the list last stood, set by every pin: only a move up from here is the reader leaving the
  // tail (see useAutoScroll for why geometry alone can't tell).
  const lastTop = useRef(0);
  // The last pin landed on a question's first line, so a shift above it should carry the view along.
  const onCap = useRef(false);
  const restoring = useRef(false);
  const restoreFrame = useRef<number | null>(null);
  // The list's height just before an older page goes in above the reader. Restoring adds only the
  // growth to wherever the list stands by then: a reader still scrolling keeps moving from there.
  const anchorHeight = useRef<number | null>(null);
  const editShift = useEditShift(scrollRef);
  const shown = frozen ?? history;
  const entries = shown?.available ? shown.entries : [];
  const latest = history?.available ? history.entries.at(-1) : undefined;
  const lastShown = entries.at(-1);
  const hasNew = frozen !== null && history?.available && (
    latest?.uuid !== lastShown?.uuid || latest?.turn?.status !== lastShown?.turn?.status ||
    latest?.turn?.durationMs !== lastShown?.turn?.durationMs
  );
  // What the live window holds below the frozen one; null when it slid past it.
  const below = useMemo(() => {
    if (!frozen || !history?.available) return null;
    const from = lastShown ? history.entries.findIndex((entry) => entry.uuid === lastShown.uuid) : -1;
    return from < 0 ? null : history.entries.slice(from + 1);
  }, [frozen, history, lastShown]);
  // How many messages arrived below the frozen window; null when the live window slid past it.
  const newCount = !hasNew ? 0 : below ? below.filter(spoken).length : null;
  // The frozen window still ends on the live turn when only the agent's own steps came after it.
  const onLiveTurn = below?.every((entry) => entry.role === "assistant") ?? false;
  useEffect(() => {
    if (history?.available) setFrozen((current) => current?.available ? withResults(current, history.entries) : current);
  }, [history]);
  const matches = useMemo(() => matchingEntries(entries, query), [entries, query]);
  // This client's sends the journal has not caught up with yet. Reconciled against the LIVE window,
  // not a frozen one, so scrolling back to read never holds a delivered bubble on screen.
  const sendScope = localSendScope(paneId, session);
  const localSends = useLocalSends(sendScope);
  const localSendActions = useLocalSendActions(sendScope);
  const liveEntries = history?.available ? history.entries : null;
  useEffect(() => {
    if (liveEntries) reconcileLocalSends(sendScope, liveEntries);
  }, [sendScope, liveEntries, localSends]);
  // A new bubble is the operator's own action: bring the tail into view even if they had scrolled up.
  const localSendCount = localSends.length;
  // A message the agent received starts its turn, as Stop already counts it in the composer: Working…
  // shows at once and holds until the agent's state has reported the turn and then its end. The
  // journal row and that state arrive on separate reads, in either order. Gives up like Stop does if
  // nothing ever reports the turn.
  const handed = localSends.at(-1);
  const delivered = handed?.state === "sent" && !handed.native && !handed.unverified ? handed.id : null;
  const [starting, setStarting] = useState<{ id: string; ran: boolean } | null>(null);
  useEffect(() => {
    if (delivered) setStarting((current) => current?.id === delivered ? current : { id: delivered, ran: false });
  }, [delivered]);
  useEffect(() => {
    if (!starting) return;
    if (activityStatus === "working") {
      if (!starting.ran) setStarting({ ...starting, ran: true });
      return;
    }
    if (starting.ran) {
      setStarting(null);
      return;
    }
    const timer = setTimeout(() => setStarting(null), TURN_PENDING_MS);
    return () => clearTimeout(timer);
  }, [starting, activityStatus]);
  // A frozen window shows its turn running only while that turn is the live one and still runs: any
  // other state would draw the reader's window as something it is not, or fold a turn they are reading.
  const activity = error ? undefined : frozen ? (onLiveTurn && activityStatus === "working" ? "working" : undefined)
    : starting ? "working" : activityStatus;
  // Under this client's bubble while the journal does not show it yet; the transcript's own after that.
  const labelUnderSend = activity === "working" && delivered !== null;
  const startingLabel = labelUnderSend && <div className="mt-3 px-0.5 py-1" role="status"><WorkActivityLabel /></div>;
  const previousSendCount = useRef(localSendCount);
  useEffect(() => { onMatchCount?.(matches.length); }, [matches.length, onMatchCount]);
  useEffect(() => {
    if (searching) {
      following.current = false;
      setPaused(true);
      setFrozen((current) => current ?? history);
    }
  }, [searching, history]);
  // Find's current hit lands a third down what the reader sees, below the chrome a phone draws over the
  // list (its scroll-padding), and every redraw of the held window (a result landing, an older page)
  // puts it back there. The turn stands in for a hit the view doesn't draw.
  useEffect(() => {
    const el = scrollRef.current;
    const uuid = entries[matches[currentMatch] ?? -1]?.uuid;
    if (!searching || !uuid || !el) return;
    const turn = Array.from(el.querySelectorAll<HTMLElement>("[data-turn]")).find((element) => element.dataset.turn === uuid);
    const hit = turn?.querySelector<HTMLElement>('mark[aria-current="true"]') ?? turn;
    if (!hit) return;
    const view = el.getBoundingClientRect();
    el.scrollTop = thirdScrollTop({ scrollTop: el.scrollTop, viewTop: view.top, viewBottom: view.bottom, hitTop: hit.getBoundingClientRect().top,
      inset: parseFloat(getComputedStyle(el).scrollPaddingTop) || 0 });
  }, [searching, currentMatch, matches, entries]);

  const cancelOlder = useCallback(() => {
    request.current?.abort();
    request.current = null;
  }, []);

  // Following lands on the newest line, except that a question at the tail taller than the list is
  // read from its first line: the view never passes that line, and a reader already further down
  // inside the question stays where they are. While the operator types in the question (its reply
  // box sits at its foot) the bottom wins again, so the phone keyboard never hides the box.
  const pin = useCallback((el: HTMLElement) => {
    const bottom = el.scrollHeight - el.clientHeight;
    const cap = typingIn(el) ? null : stopCap(el);
    const top = cap === null ? bottom : onCap.current ? cap : Math.max(cap, Math.min(el.scrollTop, bottom));
    el.scrollTo({ top, behavior: "auto" });
    onCap.current = cap !== null && top === cap;
    lastTop.current = el.scrollTop;
  }, []);

  const followLatest = useCallback(() => {
    cancelOlder();
    anchorHeight.current = null;
    following.current = true;
    setPaused(false);
    setFrozen(null);
    setLoadingOlder(false);
    setOlderError(false);
    setOlderStopped(false);
    const el = scrollRef.current;
    if (el) pin(el);
  }, [cancelOlder, pin]);

  useEffect(() => {
    if (localSendCount > previousSendCount.current) followLatest();
    previousSendCount.current = localSendCount;
  }, [localSendCount, followLatest]);

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
    if (anchorHeight.current !== null) {
      const before = anchorHeight.current;
      anchorHeight.current = null;
      restoring.current = true;
      el.scrollTop += el.scrollHeight - before;
      if (restoreFrame.current !== null) cancelAnimationFrame(restoreFrame.current);
      restoreFrame.current = requestAnimationFrame(() => { restoring.current = false; });
    } else if (following.current) {
      pin(el);
    }
  }, [entries, pin]);

  // Follow viewport/content resizing (including the mobile keyboard) only while at the live tail.
  useEffect(() => {
    const el = scrollRef.current;
    const content = contentRef.current;
    if (!el || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (following.current) pin(el);
    });
    observer.observe(el);
    observer.observe(content);
    return () => observer.disconnect();
  }, [pin]);

  // A tap on the thread's text, or a drag down of DISMISS_DRAG px, closes the keyboard. A tap on a
  // control stays the control's; a drag up or sideways (a code block) is only scrolling.
  const touch = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const onTouchStart = (event: ReactTouchEvent) => {
    const point = event.touches[0];
    touch.current = point && event.touches.length === 1 ? { x: point.clientX, y: point.clientY, moved: false } : null;
  };
  const onTouchMove = (event: ReactTouchEvent) => {
    const start = touch.current;
    const point = event.touches[0];
    if (!start || !point) return;
    const dx = point.clientX - start.x;
    const dy = point.clientY - start.y;
    if (Math.abs(dx) > TAP_SLOP || Math.abs(dy) > TAP_SLOP) start.moved = true;
    if (dy >= DISMISS_DRAG && dy > Math.abs(dx)) {
      dismissKeyboard(event.target);
      touch.current = null;
    }
  };
  const onTouchEnd = (event: ReactTouchEvent) => {
    const start = touch.current;
    touch.current = null;
    if (start && !start.moved && !(event.target instanceof Element && event.target.closest(CONTROL))) dismissKeyboard(event.target);
  };

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
    if (!el) return;
    const up = el.scrollTop < lastTop.current;
    // Our own pins leave scrollTop where they put it; any other move is the reader's.
    if (Math.abs(el.scrollTop - lastTop.current) >= 1) onCap.current = false;
    lastTop.current = el.scrollTop;
    if (restoring.current) return;
    // Reading inside a question at the tail is being at the tail: its foot may be far below.
    const cap = stopCap(el);
    if (atTail(el) || (cap !== null && el.scrollTop >= cap - 1)) {
      if (!following.current) followLatest();
    } else if (up && !(following.current && editShift())) {
      following.current = false;
      setPaused(true);
      setFrozen((current) => current ?? history);
      // Heading for the top: fetch the next page before the reader gets there. Not after a failure
      // (Retry asks again) nor during find (a page landing would shift its matches).
      if (el.scrollTop < OLDER_PAGE_MARGIN && !olderError && !searching) void loadOlder();
    } else if (following.current) {
      pin(el);
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
      anchorHeight.current = el ? el.scrollHeight : null;
      // Onto the window as it stands now: a result that landed while the page loaded stays on its row.
      setFrozen((current) => {
        const held = current?.available ? current : base;
        return {
          ...held,
          entries: [...older, ...held.entries],
          hasMore: page.hasMore,
          fileTruncated: held.fileTruncated || page.fileTruncated,
          total: Math.max(held.total, page.total),
        };
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
  if (shown && !shown.available) emptyCopy = UNAVAILABLE_COPY[shown.reason];
  else if (error) emptyCopy = "Your draft is safe. Retry to load the conversation.";
  const empty = entries.length === 0 && localSends.length === 0;
  // The skeleton and the turns sit at the list's foot, where the tail will land.
  const skeleton = empty && loading;
  // A conversation the operator can link: the shared empty state, centred, with the ways to link it as
  // its action. While a question waits in the thread it folds to one line at the foot, so the question
  // is the one card.
  const linkable = empty && !loading && shown?.available === false && shown.reason === "no-session" && Boolean(recovery);
  const canLoadOlder = shown?.available && shown.hasMore && !olderStopped;
  const historyBoundary = olderStopped || (shown?.available && shown.fileTruncated && !shown.hasMore);

  return (
    <section aria-label="Live conversation" className="flex h-full min-h-0 min-w-0 flex-col">
      {error && (
        <div role="status" className="flex items-center justify-between gap-3 border-b px-4 py-2 text-xs text-muted-foreground">
          <span>{entries.length ? "Conversation refresh failed. Showing the last update." : "Couldn't load the conversation."}</span>
          {onRetry && <button type="button" onClick={onRetry} className="min-h-11 shrink-0 rounded-md px-3 font-medium hover:bg-muted">Retry</button>}
        </div>
      )}
      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={onScroll} onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd} onTouchCancel={() => { touch.current = null; }} className="h-full min-w-0 overflow-y-auto overflow-x-hidden px-(--page-gutter) py-6" style={{ overflowAnchor: "none" }}>
          <div ref={contentRef} className={cn("mx-auto w-full max-w-(--chat-column)", skeleton && "flex min-h-full flex-col justify-end", linkable && cn("flex min-h-full flex-col", waiting ? "justify-end" : "justify-center"))}>
            {entries.length > 0 ? <>
              {(canLoadOlder || historyBoundary || olderError) && <div className="mb-6 text-center text-xs text-muted-foreground">
                {canLoadOlder && <button type="button" disabled={loadingOlder} onClick={() => void loadOlder()} className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-3 hover:bg-muted hover:text-foreground disabled:opacity-50">
                  {loadingOlder ? <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" /> : <ArrowUp aria-hidden="true" className="size-3" />}
                  {loadingOlder ? "Loading older messages…" : olderError ? "Retry older messages" : "Load older messages"}
                </button>}
                {olderError && <p role="status">Couldn't load older messages. Your conversation is still live.</p>}
                {historyBoundary && <p role="status">You've reached the oldest messages available from this session log.</p>}
              </div>}
              <TranscriptView entries={entries} query={query}
                focusedUuid={searching ? entries[matches[currentMatch] ?? -1]?.uuid : undefined}
                activityStatus={activity} activityLabel={!labelUnderSend} onWorkToggle={onWorkToggle} />
              <PendingTurns sends={localSends} actions={localSendActions} />
              {startingLabel}
              {footer}
            </> : localSends.length > 0 ? <><PendingTurns sends={localSends} actions={localSendActions} />{startingLabel}{footer}</> : skeleton ? <>
              <TranscriptSkeleton />
              {activityStatus === "working" && <div className="mt-3 px-0.5 py-1"><WorkActivityLabel /></div>}
              {footer}
            </> : linkable ? <>
              {waiting ? <p className="mb-4 flex items-center justify-center gap-2 text-footnote text-muted-foreground">
                <MessageSquare aria-hidden="true" className="size-4 shrink-0" strokeWidth={1.75} />No conversation linked
              </p> : <EmptyState icon={MessageSquare} title="No conversation linked" action={
                // The form's column: 384 px, or the empty state's width where that is narrower. A grid
                // track, because the empty state shrink-wraps its action: a w-sm box would hold it at
                // 384 px and push the form past a phone's gutter, while minmax(0, 24rem) asks for 384
                // and gives way.
                <div className="grid grid-cols-[minmax(0,24rem)]">
                  <RecoveryLeads.Provider value>{recovery}</RecoveryLeads.Provider>
                  {!error && activityStatus === "working" && <div className="mt-3 flex justify-center"><WorkActivityLabel /></div>}
                </div>
              }>Send a message to start, or link the one already running.</EmptyState>}
              {footer}
            </> : <><div className="flex flex-col items-center gap-3 px-4 py-16 text-center text-sm text-muted-foreground">
              <MessageSquare className="size-5" />
              <p>{emptyCopy}</p>
              {shown && !shown.available && shown.reason !== "disabled" && recovery && <div className="w-full max-w-sm">{recovery}</div>}
              {!error && activityStatus === "working" && <WorkActivityLabel />}
            </div>{footer}</>}
          </div>
        </div>
        {/* The list's top edge fades into the page instead of cutting text under the strip above it.
            A gradient over the list, not a mask on it: a mask would also clip the fixed popovers and
            sheets that open from inside the thread. */}
        <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 z-[1] h-3 bg-linear-to-b from-background" />
        {paused && <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 px-(--page-gutter)">
          <div className="mx-auto max-w-(--chat-column)">
            <ScrollToLatest corner onClick={followLatest} waiting={waiting} count={newCount} changed={Boolean(hasNew)} />
          </div>
        </div>}
      </div>
    </section>
  );
}
