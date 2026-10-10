import { useEffect, useState } from "react";
import { Link } from "react-router";
import { Check, CircleDashed, GitPullRequest, Terminal, Workflow, X } from "lucide-react";

import { ACTIVITY_POLL_MS, activityConcerns } from "@/hooks/use-activity";
import { fetchActivity, formatCount, formatDuration, type ActivityResponse } from "@/lib/activity";
import { timeAgoShort } from "@/lib/format";
import type { FinishedNotice, ReviewItem } from "@/lib/home-stats";
import { isLocked, useLocked } from "@/lib/idle";
import { isLiveHealthy, onLiveEvent } from "@/lib/live-events";
import { panePath, projectPath } from "@/lib/nav";
import { cn } from "@/lib/utils";
import type { AgentView, ThreadPullRequest } from "@/lib/types";

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

function Checks({ checks }: { checks: NonNullable<ThreadPullRequest["checks"]> }) {
  if (checks.failed) return <span className="flex shrink-0 items-center gap-1 text-xs text-destructive"><X aria-hidden className="size-3.5" />{checks.failed} failing</span>;
  if (checks.pending) return <span className="flex shrink-0 items-center gap-1 text-xs text-status-working"><CircleDashed aria-hidden className="size-3.5" />checks running</span>;
  if (!checks.passed) return null;
  return <span className="flex shrink-0 items-center gap-1 text-xs text-status-done"><Check aria-hidden className="size-3.5" />checks</span>;
}

const rowClass = "flex min-h-13 min-w-0 items-center gap-3 sm:rounded-[10px] px-1 py-1.5 sm:px-3.5";
const actionClass = "inline-flex min-h-9 shrink-0 items-center rounded-lg border border-border bg-secondary px-3 text-[13px] font-medium text-foreground hover:bg-secondary/70 max-lg:min-h-10";

/**
 * A pull request ready for review. On a desk the diff and checks sit in their own columns; on a
 * phone the line under the title reads "#1342 · +212 −148", as the narrow row has no room for both.
 */
function ReviewRow({ item, session }: { item: ReviewItem; session?: string }) {
  const { project, thread } = item;
  const pr = thread.pr;
  const to = thread.paneId ? panePath(thread.paneId, session) : projectPath(project.slug, session);
  const numbered = pr?.number !== undefined;
  return (
    <li className={cn(rowClass, "grid grid-cols-[auto_minmax(0,1fr)_auto] gap-y-0 sm:grid-cols-[auto_minmax(0,1fr)_auto_auto_auto]")}>
      <GitPullRequest aria-hidden className="row-span-2 size-4 shrink-0 text-status-done" />
      <span className="col-start-2 truncate text-[13.5px] leading-tight text-foreground">{thread.title}</span>
      <span className="col-start-2 row-start-2 flex min-w-0 items-baseline gap-1 text-xs leading-tight text-muted-foreground sm:contents">
        <span className="min-w-0 truncate sm:col-start-2 sm:row-start-2">
          <span className={cn(numbered && "max-sm:hidden")}>{project.name}{numbered && " · "}</span>
          {numbered && <span className="font-mono">#{pr.number}</span>}
          {pr?.review === "approved" && " · approved"}
          {pr?.mergeBlocker && <span className="max-sm:hidden"> · {pr.mergeBlocker}</span>}
        </span>
        {pr?.diff && (
          <span className="shrink-0 font-mono sm:col-start-3 sm:row-span-2 sm:row-start-1">
            <span aria-hidden className="sm:hidden">· </span>
            <span className="text-status-done">+{pr.diff.additions}</span> <span className="text-destructive">−{pr.diff.deletions}</span>
          </span>
        )}
      </span>
      {pr?.checks && <span className="max-sm:hidden sm:col-start-4 sm:row-span-2 sm:row-start-1"><Checks checks={pr.checks} /></span>}
      <Link to={to} className={cn(actionClass, "col-start-3 row-span-2 row-start-1 sm:col-start-5")} aria-label={`Review ${thread.title}`}>Review</Link>
    </li>
  );
}

function NoticeRow({ notice, agent, session, now }: { notice: FinishedNotice; agent?: AgentView; session?: string; now: number }) {
  const wf = notice.workflow;
  const meta = wf
    ? [wf.agentCount ? `${wf.agentCount} ${wf.agentCount === 1 ? "agent" : "agents"}` : "", formatDuration(wf.durationMs), wf.totalTokens ? `${formatCount(wf.totalTokens)} tokens` : ""]
    : [notice.task?.exitCode !== undefined ? `exit ${notice.task.exitCode}` : "", notice.task?.event ?? ""];
  const where = agent ? agent.workspaceLabel : "";
  const Icon = notice.kind === "workflow" ? Workflow : Terminal;
  const label = notice.kind === "workflow" ? `Workflow ${notice.failed ? "failed" : "finished"}: ${notice.title}` : `Command failed: ${notice.title}`;
  return (
    <li className={rowClass}>
      <Icon aria-hidden className={cn("size-4 shrink-0", notice.failed ? "text-destructive" : "text-status-done")} />
      <span className="flex min-w-0 flex-1 flex-col leading-tight">
        <span className="truncate text-[13.5px] text-foreground">{label}</span>
        <span className="truncate text-xs text-muted-foreground">{[where, ...meta].filter(Boolean).join(" · ")}</span>
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums max-sm:hidden">{timeAgoShort(notice.at, now)}</span>
      <Link to={panePath(notice.paneId, session)} className={actionClass} aria-label={`View result of ${notice.title}`}>View result</Link>
    </li>
  );
}

/** Home's "Ready to review": finished background work first (newest), then pull requests. */
export function ReadyToReviewList({ reviews, notices, agents, session, now }: {
  reviews: readonly ReviewItem[];
  notices: readonly FinishedNotice[];
  agents: readonly AgentView[];
  session?: string;
  now: number;
}) {
  const total = reviews.length + notices.length;
  if (!total) return null;
  const byPane = new Map(agents.map((agent) => [agent.paneId, agent]));
  return (
    <section aria-labelledby="home-review" className="flex flex-col gap-1.5">
      <h2 id="home-review" className="flex items-center gap-2 text-[12.5px] font-medium text-muted-foreground">
        <span className="text-foreground/85">Ready to review</span><span className="tabular-nums">{total}</span>
      </h2>
      <ul className="flex flex-col max-sm:divide-y max-sm:divide-border">
        {notices.map((notice) => <NoticeRow key={`${notice.paneId}:${notice.kind}:${notice.id}`} notice={notice} agent={byPane.get(notice.paneId)} session={session} now={now} />)}
        {reviews.map((item) => <ReviewRow key={`${item.project.slug}:${item.thread.id}`} item={item} session={session} />)}
      </ul>
    </section>
  );
}
