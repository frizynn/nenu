import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Check, CircleDashed, GitPullRequest, X } from "lucide-react";

import { FoldedList, HomeHeading } from "@/components/home-panels";
import { ACTIVITY_POLL_MS, activityConcerns } from "@/hooks/use-activity";
import { fetchActivity, type ActivityResponse } from "@/lib/activity";
import type { ReviewEntry } from "@/lib/home-stats";
import { isLocked, useLocked } from "@/lib/idle";
import { isLiveHealthy, onLiveEvent } from "@/lib/live-events";
import { panePath, projectPath } from "@/lib/nav";
import { cn } from "@/lib/utils";
import type { AgentView } from "@/lib/types";

/** How many Claude panes Home reads background work for, most recently active first. */
export const HOME_ACTIVITY_PANES = 8;

/**
 * Background work of the most recently active Claude panes, by pane. One read per pane, refreshed
 * when the stream names that pane and on the activity view's fallback poll; paused behind the idle
 * cover and while the page is hidden (ADR 0054).
 */
export function useHomeActivity(agents: readonly AgentView[], session?: string): ReadonlyMap<string, ActivityResponse> {
  const locked = useLocked();
  const [byPane, setByPane] = useState<ReadonlyMap<string, ActivityResponse>>(new Map());
  const ids = agents
    .filter((agent) => agent.agent === "claude" && agent.hasSession)
    .sort((a, b) => (b.lastActiveAt ?? 0) - (a.lastActiveAt ?? 0))
    .slice(0, HOME_ACTIVITY_PANES)
    .map((agent) => agent.paneId)
    .sort();
  const key = ids.join("\0");

  useEffect(() => {
    if (locked || !key) return void setByPane(new Map());
    const panes = key.split("\0");
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();

    async function read(paneId: string) {
      if (disposed || document.hidden || isLocked()) return;
      try {
        const res = await fetchActivity(paneId, session, controller.signal);
        if (!disposed) setByPane((prev) => new Map(prev).set(paneId, res));
      } catch {
        // A failed read keeps what was last known; the next poll tries again.
      }
    }
    function pollAll() {
      clearTimeout(timer);
      void Promise.all(panes.map(read)).finally(() => {
        if (!disposed) timer = setTimeout(pollAll, isLiveHealthy() ? ACTIVITY_POLL_MS.live : ACTIVITY_POLL_MS.quiet);
      });
    }
    const visibility = () => { if (!document.hidden) pollAll(); };
    const stopLive = onLiveEvent((event) => {
      if (event.topic === "resync") return pollAll();
      for (const paneId of panes) if (activityConcerns(event, paneId)) void read(paneId);
    });
    setByPane((prev) => new Map([...prev].filter(([paneId]) => panes.includes(paneId))));
    document.addEventListener("visibilitychange", visibility);
    pollAll();
    return () => {
      disposed = true;
      clearTimeout(timer);
      controller.abort();
      stopLive();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [key, session, locked]);

  return byPane;
}

function Checks({ checks }: { checks: NonNullable<ReviewEntry["checks"]> }) {
  // The phone keeps the icon and reads the words to a screen reader only: its row has no room for them.
  const words = "max-sm:sr-only";
  if (checks.failed) return <span className="flex shrink-0 items-center gap-1 text-xs text-destructive"><X aria-hidden className="size-3.5" /><span className={words}>{checks.failed} failing</span></span>;
  if (checks.pending) return <span className="flex shrink-0 items-center gap-1 text-xs text-status-working"><CircleDashed aria-hidden className="size-3.5" /><span className={words}>checks running</span></span>;
  if (!checks.passed) return null;
  return <span className="flex shrink-0 items-center gap-1 text-xs text-status-done"><Check aria-hidden className="size-3.5" /><span className={words}>checks</span></span>;
}

const REVIEW_WORDS: Record<NonNullable<ReviewEntry["review"]>, string | undefined> = {
  approved: "approved",
  changes_requested: "changes requested",
  review_required: undefined,
  commented: undefined,
};

const rowClass = "grid min-h-13 min-w-0 grid-cols-[auto_minmax(0,1fr)_auto_auto] items-center gap-x-3 gap-y-0 px-1 py-1.5 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto_auto] sm:rounded-[10px] sm:px-3.5";
const actionClass = "inline-flex min-h-9 shrink-0 items-center rounded-lg border border-border bg-secondary px-3 text-[13px] font-medium text-foreground hover:bg-secondary/70 max-lg:min-h-10";

/**
 * A pull request waiting for review. On a desk the line under the title reads "repo · #1342 · branch"
 * and the diff and checks sit in their own columns; on a phone it reads "#1342 · +212 −148", as the
 * narrow row has no room for both, and the number never gives way to the rest.
 */
function ReviewRow({ entry, session }: { entry: ReviewEntry; session?: string }) {
  const verdict = entry.review && REVIEW_WORDS[entry.review];
  const label = `Review ${entry.title}`;
  return (
    <li className={rowClass}>
      <GitPullRequest aria-hidden className={cn("row-span-2 size-4 shrink-0", entry.draft ? "text-muted-foreground" : "text-status-done")} />
      <span className="col-start-2 flex min-w-0 items-center gap-1.5">
        <span className="truncate text-[13.5px] leading-tight text-foreground">{entry.title}</span>
        {entry.draft && <span className="shrink-0 rounded border border-border px-1 text-[11px] leading-4 text-muted-foreground">Draft</span>}
      </span>
      <span className="col-start-2 row-start-2 flex min-w-0 items-baseline gap-1 text-xs leading-tight text-muted-foreground">
        <span className="shrink-0 max-sm:hidden">{entry.repo}{entry.number !== undefined && " ·"}</span>
        {entry.number !== undefined && <span className="shrink-0 font-mono">#{entry.number}</span>}
        {verdict && <span className={cn("min-w-0 truncate sm:shrink-0", entry.review === "approved" ? "text-status-done" : "text-destructive")}>· {verdict}</span>}
        {entry.branch && <span className="min-w-0 truncate font-mono max-sm:hidden">· {entry.branch}</span>}
        {entry.mergeBlocker && <span className="min-w-0 truncate max-sm:hidden">· {entry.mergeBlocker}</span>}
        {entry.diff && (
          <span className="shrink-0 font-mono sm:hidden">
            <span aria-hidden>· </span>
            <span className="text-status-done">+{entry.diff.additions}</span> <span className="text-destructive">−{entry.diff.deletions}</span>
          </span>
        )}
      </span>
      {entry.diff && (
        <span className="col-start-3 row-span-2 row-start-1 shrink-0 font-mono text-xs max-sm:hidden">
          <span className="text-status-done">+{entry.diff.additions}</span> <span className="text-destructive">−{entry.diff.deletions}</span>
        </span>
      )}
      <span className="col-start-3 row-span-2 row-start-1 sm:col-start-4">{entry.checks && <Checks checks={entry.checks} />}</span>
      {entry.open ? (
        <Link to={"paneId" in entry.open ? panePath(entry.open.paneId, session) : projectPath(entry.open.project, session)}
          className={cn(actionClass, "col-start-4 row-span-2 row-start-1 sm:col-start-5")} aria-label={label}>Review</Link>
      ) : entry.url ? (
        <a href={entry.url} target="_blank" rel="noopener noreferrer" className={cn(actionClass, "col-start-4 row-span-2 row-start-1 sm:col-start-5")} aria-label={label}>Review</a>
      ) : null}
    </li>
  );
}

/** How many rows show before "Show all": enough to act on, short enough to keep Recent in reach. */
export const REVIEW_ROWS = 5;

/** Home's "Ready to review": the pull requests waiting on you, nothing else. */
export function ReadyToReviewList({ entries, session }: { entries: readonly ReviewEntry[]; session?: string }) {
  if (!entries.length) return null;
  return (
    <section aria-labelledby="home-review" className="flex flex-col gap-1.5">
      <HomeHeading id="home-review" label="Ready to review" count={entries.length} />
      <FoldedList items={entries} rows={REVIEW_ROWS}>
        {(entry) => <ReviewRow key={entry.key} entry={entry} session={session} />}
      </FoldedList>
    </section>
  );
}
