import { useEffect, useState } from "react";
import { Link } from "react-router";
import { GitPullRequest } from "@/components/ui/icon";

import { DiffStat } from "@/components/diff-stat";
import { FoldedList, isOpening, OpeningSpinner } from "@/components/home-panels";
import { ACTIVITY_POLL_MS, activityConcerns } from "@/hooks/use-activity";
import { fetchActivity, type ActivityResponse } from "@/lib/activity";
import { readyToMerge, type ReviewEntry } from "@/lib/home-stats";
import { isLocked, useLocked } from "@/lib/idle";
import { isLiveHealthy, onLiveEvent } from "@/lib/live-events";
import { panePath } from "@/lib/nav";
import { cn, keepUnchanged } from "@/lib/utils";
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
        if (!disposed) setByPane((prev) => {
          const kept = keepUnchanged(prev.get(paneId), res);
          return kept === prev.get(paneId) ? prev : new Map(prev).set(paneId, kept);
        });
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

/**
 * What a pull request's checks say, in two or three words, and their colour; null when it has none. The
 * colour is a phone's: a desk keeps the words grey and the colour to the row's icon.
 */
function checksWord(checks: ReviewEntry["checks"]): { word: string; tone: string } | null {
  if (!checks) return null;
  if (checks.failed) return { word: `${checks.failed} ${checks.failed === 1 ? "check" : "checks"} failing`, tone: "max-lg:text-destructive" };
  if (checks.pending) return { word: "checks running", tone: "max-lg:text-status-working" };
  return checks.passed ? { word: "checks passed", tone: "max-lg:text-status-done" } : null;
}

const REVIEW_WORDS: Record<NonNullable<ReviewEntry["review"]>, { word: string; tone?: string }> = {
  approved: { word: "approved", tone: "max-lg:text-status-done" },
  changes_requested: { word: "changes requested", tone: "max-lg:text-destructive" },
  review_required: { word: "needs review" },
};

const rowClass = "relative grid min-h-14 min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-3 px-1 py-2 hover:bg-[var(--workbench-row-hover)] sm:min-h-12 sm:rounded-lg sm:px-2.5";

/**
 * A pull request as one row and one tap: its title, then its number and what its checks and review
 * say in a few words, its size at the end. The tap opens the chat on its branch in Nenu, else its page on GitHub.
 */
function ReviewRow({ entry, session, opening }: { entry: ReviewEntry; session?: string; opening: string | null }) {
  const checks = checksWord(entry.checks);
  const review = entry.review && REVIEW_WORDS[entry.review];
  const number = entry.number !== undefined && { word: `#${entry.number}`, tone: "font-mono" };
  const said = [checks, review, entry.draft && { word: "draft" }].filter((fact): fact is { word: string; tone?: string } => !!fact);
  const facts = number ? [number, ...said] : said;
  const size = entry.diff && `+${entry.diff.additions} −${entry.diff.deletions}`;
  const label = [entry.title, number && number.word, size, ...said.map((fact) => fact.word)].filter(Boolean).join(", ");
  const to = entry.open && panePath(entry.open.paneId, session);
  const busy = !!to && isOpening(opening, to);
  // What a desk says in red, on the icon alone: a check failing or changes asked for.
  const blocked = !!entry.checks?.failed || entry.review === "changes_requested";
  const body = <>
    <GitPullRequest aria-hidden className={cn("row-span-2 size-4 shrink-0 justify-self-center",
      readyToMerge(entry) ? "text-status-done" : blocked ? "text-muted-foreground lg:text-destructive" : "text-muted-foreground")} />
    <span className="col-start-2 truncate text-body sm:text-subhead">{entry.title}</span>
    <span className="col-start-2 row-start-2 flex min-w-0 items-baseline gap-1 truncate text-footnote text-muted-foreground">
      <span className="shrink-0 max-sm:hidden">{entry.repo} ·</span>
      {facts.map((fact, index) => <span key={fact.word} className={cn("shrink-0", fact.tone)}>{index > 0 && <span aria-hidden className="text-muted-foreground">· </span>}{fact.word}</span>)}
    </span>
    <span className="col-start-3 row-span-2 row-start-1 flex items-center gap-3 text-footnote text-muted-foreground">
      {entry.diff && <DiffStat diff={entry.diff} className="text-caption" />}
      {busy && <OpeningSpinner />}
    </span>
  </>;
  return (
    <li>
      {to ? <Link to={to} aria-label={label} aria-busy={busy || undefined} className={cn(rowClass, busy && "bg-[var(--workbench-row-hover)]")}>{body}</Link>
        : entry.url ? <a href={entry.url} target="_blank" rel="noopener noreferrer" aria-label={label} className={rowClass}>{body}</a>
        : <div aria-label={label} className={rowClass}>{body}</div>}
    </li>
  );
}

/** How many rows show before "Show all": enough to act on, short enough to keep the sessions in reach. */
export const REVIEW_ROWS = 5;

/** Which run a pull request sits in; ready to merge comes first. */
const reviewGroup = (entry: ReviewEntry) => readyToMerge(entry) ? "Ready to merge" : "In review";

/** Home's PRs tab: every pull request, the ones ready to merge first, then the rest. */
export function PullRequestList({ entries, session, opening }: { entries: readonly ReviewEntry[]; session?: string; opening: string | null }) {
  const ordered = [...entries.filter(readyToMerge), ...entries.filter((entry) => !readyToMerge(entry))];
  return (
    <FoldedList items={ordered} rows={REVIEW_ROWS} group={reviewGroup}>
      {(entry) => <ReviewRow key={entry.key} entry={entry} session={session} opening={opening} />}
    </FoldedList>
  );
}
