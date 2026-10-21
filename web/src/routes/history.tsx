import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useLoaderData, useParams, useRouteLoaderData } from "react-router";
import { ArrowUpToLine, ChevronDown, ChevronUp, Pending, ScrollText, Search, X } from "@/components/ui/icon";

import { AppHeader, StepLink } from "@/components/app-header";
import { Button, buttonVariants } from "@/components/ui/button";
import { ChatMessageList, type ChatMessageListHandle } from "@/components/ui/chat/chat-message-list";
import { EmptyState } from "@/components/ui/empty-state";
import { FindBar } from "@/components/find-bar";
import { TranscriptView } from "@/components/transcript-view";
import { fetchHistory } from "@/lib/api";
import { linkPhrase, linkProblemOf, type LinkProblem } from "@/lib/connection";
import { displayName } from "@/lib/display-name";
import { HISTORY_PAGE_SIZE, ROOT_ROUTE_ID, type HistoryData, type HomeData } from "@/lib/loaders";
import { useGoUp } from "@/lib/motion";
import { homePath, panePath } from "@/lib/nav";
import { setStatus } from "@/lib/status";
import { matchingEntries, step, userTurnIndices } from "@/lib/transcript-search";
import type { TranscriptEntry } from "@/lib/types";
import { cn } from "@/lib/utils";

// Pane history route — the agent's own transcript, which is the ONLY conversation history a Claude
// pane can have. Its terminal runs on the alternate screen, so Herdr retains no scrollback ring at
// all and `pane.read` can never return more than the visible viewport (see bridge/transcript.ts).
//
// FETCH ALL, RENDER SOME. The whole conversation arrives in one request (measured: 1500 turns =
// 1.3 MB raw / 335 KB gzipped / 128 ms — cheap, and it's what makes find-in-history and
// jump-to-user-message work across turns you haven't scrolled to yet). What is NOT cheap is the DOM:
// 1425 turns rendered at once is ~17k nodes, and the longest log on this machine is 3244 turns, which
// would be ~39k. So the rendered window starts small and grows upward as you scroll — the data is
// already in memory, so growing it is instant and needs no network.
//
// The loader is deliberately not revalidated (`shouldRevalidate: false` in router.tsx), so the 1.5 s
// poll never re-pulls a several-hundred-turn transcript out from under the reader.

/**
 * Why there's nothing to read, in the user's terms. Each is an ordinary state, not an error. `name`
 * may be "this pane", so it never starts a sentence; `problem` is why the snapshot can't be trusted.
 */
function unavailableCopy(reason: NonNullable<HistoryData["unavailable"]>, name: string, shell: boolean, problem: LinkProblem | null) {
  switch (reason) {
    case "disabled":
      return { title: "History is off", body: "Transcript history is switched off in this Nenu's .env file." };
    case "no-session":
      return shell
        ? { title: "Shells keep no transcript", body: `History shows an agent's conversation, and ${name} is a shell.` }
        : { title: "No conversation yet", body: `There's no agent session in ${name}, so there's no transcript to read.` };
    case "no-log":
      return { title: "No transcript yet", body: `There's no transcript for ${name} yet.` };
    case "error":
      return { title: "Couldn't read the transcript", body: !problem ? "Go back and open History again."
        : `${linkPhrase(problem)}. ${problem === "refused" ? "Sign in again, then open History." : "Open History again once it's back."}` };
  }
}

/** Turns rendered on open — a few screens, so first paint stays instant on the longest threads. */
const INITIAL_RENDER = 60;
/** Turns added per upward growth step. */
const RENDER_STEP = 120;
/** Distance from the top of the scroller that triggers growth, in px. */
const GROW_THRESHOLD = 800;

export function HistoryRoute() {
  const data = useLoaderData() as HistoryData;
  const root = useRouteLoaderData(ROOT_ROUTE_ID) as HomeData;
  const { paneId = "" } = useParams();
  const session = data.session;
  const goUp = useGoUp();

  const pane =
    root.agents.find((a) => a.paneId === paneId) ??
    root.shellPanes.find((p) => p.paneId === paneId);
  // The name every other view gives this pane. A pane missing from the snapshot has none, and its
  // raw id means nothing to a reader, so the header then just says History.
  const name = pane ? displayName(pane, root.projects) : undefined;
  // Only a healthy snapshot can say the pane is gone, the guard DetailRoute closes a pane on. A failed
  // read or a disconnected Herdr leaves a live pane out too, and is said in the connection banner's words.
  const problem = linkProblemOf(root);
  const gone = !pane && !problem;

  // Pages walked back beyond the first request (only reachable on a log longer than HISTORY_PAGE_SIZE).
  const [older, setOlder] = useState<TranscriptEntry[]>([]);
  const [hasMore, setHasMore] = useState(data.hasMore);
  const [loading, setLoading] = useState(false);
  const entries = useMemo(
    () => (older.length ? [...older, ...data.entries] : data.entries),
    [older, data.entries],
  );

  // How many of the NEWEST turns are rendered. Everything else is held in memory, unrendered.
  const [renderCount, setRenderCount] = useState(INITIAL_RENDER);
  const shown = useMemo(
    () => (renderCount >= entries.length ? entries : entries.slice(entries.length - renderCount)),
    [entries, renderCount],
  );
  const allRendered = renderCount >= entries.length;

  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  // Index into `entries` (not `shown`) of the turn a find/jump landed on; -1 = nowhere yet.
  const [cursor, setCursor] = useState(-1);

  const matches = useMemo(() => matchingEntries(entries, query), [entries, query]);
  const userTurns = useMemo(() => userTurnIndices(entries), [entries]);
  const focusedUuid = cursor >= 0 ? entries[cursor]?.uuid : undefined;

  const listRef = useRef<ChatMessageListHandle>(null);
  // Growing upward inserts content ABOVE the viewport, which would yank what you're reading downward.
  // Measure before, restore after — the same anchoring the terminal mirror's "load older" uses.
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const pendingRestore = useRef(false);

  const captureAnchor = () => {
    const el = listRef.current?.getScrollElement();
    anchor.current = el ? { height: el.scrollHeight, top: el.scrollTop } : null;
    pendingRestore.current = true;
  };

  /** Fetch turns older than everything held — only for logs beyond the initial request. */
  const loadOlder = useCallback(async () => {
    const oldest = entries[0]?.uuid;
    if (loading || !hasMore || !oldest) return;
    captureAnchor();
    setLoading(true);
    try {
      const res = await fetchHistory(paneId, { limit: HISTORY_PAGE_SIZE, before: oldest }, session);
      if (!res.available) {
        setHasMore(false);
        return;
      }
      setOlder((prev) => [...res.entries, ...prev]);
      setRenderCount((c) => c + res.entries.length); // keep the newly-fetched turns visible
      setHasMore(res.hasMore);
    } catch {
      setStatus("Couldn't load older history", "error");
    } finally {
      setLoading(false);
    }
  }, [entries, hasMore, loading, paneId, session]);

  /** Reveal more of what we already hold; only hit the network once nothing is left in memory. */
  const growUpward = useCallback(() => {
    if (!allRendered) {
      captureAnchor();
      setRenderCount((c) => Math.min(c + RENDER_STEP, entries.length));
      return;
    }
    if (hasMore) void loadOlder();
  }, [allRendered, entries.length, hasMore, loadOlder]);

  // Auto-grow as the reader approaches the top, so scrolling back through a long thread feels
  // continuous instead of requiring a tap per window.
  useEffect(() => {
    const el = listRef.current?.getScrollElement();
    if (!el) return;
    const onScroll = () => {
      if (el.scrollTop < GROW_THRESHOLD && !loading) growUpward();
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [growUpward, loading]);

  // Restore the reading position once the newly-revealed turns have painted.
  useLayoutEffect(() => {
    if (!pendingRestore.current) return;
    pendingRestore.current = false;
    const a = anchor.current;
    const el = listRef.current?.getScrollElement();
    if (a && el) el.scrollTop = a.top + (el.scrollHeight - a.height);
    anchor.current = null;
  }, [shown]);

  /**
   * Send the reader to a turn by index, rendering far enough back to reach it first. React needs a
   * paint before the element exists, so the scroll runs in an effect keyed on the cursor.
   */
  const jumpTo = useCallback(
    (index: number | null) => {
      if (index === null) return;
      const needed = entries.length - index + 10; // a little context above the target
      setRenderCount((c) => Math.max(c, Math.min(needed, entries.length)));
      setCursor(index);
    },
    [entries.length],
  );

  useEffect(() => {
    if (cursor < 0) return;
    const uuid = entries[cursor]?.uuid;
    if (!uuid) return;
    const el = listRef.current?.getScrollElement();
    el?.querySelector(`[data-turn="${CSS.escape(uuid)}"]`)?.scrollIntoView({ block: "center" });
  }, [cursor, entries, shown]);

  // A new query invalidates the previous position, so the first Next starts from the top of the thread.
  useEffect(() => setCursor(-1), [query]);

  function closeFind() {
    setFindOpen(false);
    setQuery("");
    setCursor(-1);
  }

  // Open at the newest turn — you arrive from the live mirror, so the recent end is the continuation.
  useLayoutEffect(() => {
    listRef.current?.scrollToBottom();
  }, []);

  const matchCursor = matches.indexOf(cursor);
  // The pane this history belongs to, or Home once the pane is gone: the one way out, in the bar and
  // on an empty page alike. Its button says Go to Home as every empty state does, or Back to the pane.
  const back = gone
    ? { to: homePath(session), label: "Home", action: "Go to Home" }
    : { to: panePath(paneId, session), label: name ?? "the pane", action: `Back to ${name ?? "the pane"}` };
  const total = Math.max(data.total, entries.length);
  const empty = gone
    ? { title: "This pane is closed", body: "Its history can't be read from here anymore." }
    : unavailableCopy(data.unavailable ?? "no-log", name ?? "this pane", pane?.kind === "shell", problem);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <AppHeader
        bridge={root.bridge}
        error={root.error}
        title="History"
        subtitle={name}
        back={back}
        override={
          findOpen ? (
            <FindBar
              query={query}
              onQueryChange={setQuery}
              count={matches.length}
              current={matchCursor >= 0 ? matchCursor : 0}
              onPrev={() => jumpTo(step(matches, cursor, -1))}
              onNext={() => jumpTo(step(matches, cursor, 1))}
              onClose={closeFind}
              subject="history"
            />
          ) : undefined
        }
        rightLead={
          // A PWA has no browser find, so the view has to provide its own, once there is text to search.
          entries.length > 0 && (
            <button type="button" onClick={() => setFindOpen(true)} aria-label="Find in history" className="workbench-icon-button">
              <Search aria-hidden="true" size={17} />
            </button>
          )
        }
        // The header's back hides on a desk, where the sidebar is the way around; History is a reading
        // view you chose to open, so the desk gets its own way out, and each width has exactly one.
        rightTrail={
          <div className="flex max-lg:hidden">
            <StepLink to={back.to} go={goUp} aria-label="Close history" className="workbench-icon-button">
              <X aria-hidden="true" size={17} />
            </StepLink>
          </div>
        }
      />

      {/* The text scrolls under the home indicator; everything that floats stops above it.
          ChatMessageList pins its Latest pill to its own box, so that box ends at the inset (this
          padding) while the scroller reaches past it to the screen's edge. */}
      <main className="relative min-h-0 min-w-0 flex-1 pb-[env(safe-area-inset-bottom)]">
        {entries.length === 0 ? (
          <EmptyState
            icon={ScrollText}
            title={empty.title}
            className="h-full justify-center"
            // cn() is what drops buttonVariants' base text-footnote for lg's text-body on a link.
            action={
              <StepLink to={back.to} go={goUp} className={cn(buttonVariants({ size: "lg" }), "max-w-[min(20rem,80vw)]")}>
                <span className="truncate">{back.action}</span>
              </StepLink>
            }
          >
            {empty.body}
          </EmptyState>
        ) : (
          <ChatMessageList
            ref={listRef}
            // 72px under the last turn clears the 44px controls with room to spare.
            className="h-[calc(100%_+_env(safe-area-inset-bottom))] px-(--page-gutter) pt-6 pb-[calc(env(safe-area-inset-bottom)_+_72px)]"
          >
            <div className="mx-auto w-full max-w-(--chat-column)">
              {/* Sits at the very top of what's rendered, so scrolling up reaches it naturally. The
                  auto-grow above usually gets there first; this is the explicit fallback. */}
              {!allRendered || hasMore ? (
                <div className="mb-4 flex flex-col items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={growUpward} disabled={loading} aria-busy={loading || undefined} className="text-muted-foreground">
                    {loading ? <Pending aria-hidden="true" /> : <ArrowUpToLine aria-hidden="true" />}
                    {loading ? "Loading…" : "Load older"}
                  </Button>
                  <p className="text-footnote text-subtle-foreground tabular-nums">
                    {`Showing ${shown.length.toLocaleString()} of ${total.toLocaleString()}`}
                  </p>
                </div>
              ) : (
                <p className="mb-4 text-center text-footnote text-subtle-foreground">
                  {data.fileTruncated
                    ? "Start of the readable transcript (the log was clipped at the read cap)"
                    : "Start of the conversation"}
                </p>
              )}
              <TranscriptView entries={shown} query={query} focusedUuid={focusedUuid} />
            </div>
          </ChatMessageList>
        )}

        {/* Jump between the turns YOU wrote — in a thousand-turn thread those are the only landmarks
            (20 human turns in 900 is typical). Bottom-right so it's thumb-reachable and clear of the
            centred "scroll to latest" button, on the same line above the home indicator, at the reading
            column's edge rather than the window's on a wide screen. Side by
            side, so it is no taller than that button and the list's bottom padding clears both.
            Hidden while find is open, which owns prev/next then. Each half rounds itself instead of
            the pill clipping them, because a clip would also cut the focus ring drawn outside a button. */}
        {userTurns.length > 1 && !findOpen && (
          <div className="absolute bottom-[calc(env(safe-area-inset-bottom)_+_0.75rem)] right-[max(var(--page-gutter),calc((100%_-_var(--chat-column))/2))] z-10 flex rounded-full border bg-popover shadow-(--shadow-float)">
            <button
              type="button"
              onClick={() => jumpTo(step(userTurns, cursor, -1))}
              aria-label="Previous message you sent"
              className="grid size-11 place-items-center rounded-l-full text-muted-foreground transition-colors hover:text-foreground active:bg-muted"
            >
              <ChevronUp aria-hidden="true" className="size-5" />
            </button>
            <button
              type="button"
              onClick={() => jumpTo(step(userTurns, cursor, 1))}
              aria-label="Next message you sent"
              className="grid size-11 place-items-center rounded-r-full border-l text-muted-foreground transition-colors hover:text-foreground active:bg-muted"
            >
              <ChevronDown aria-hidden="true" className="size-5" />
            </button>
          </div>
        )}
      </main>
    </div>
  );
}
