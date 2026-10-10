import { useState } from "react";
import { Eye, GitPullRequest } from "lucide-react";

import { errorMessage } from "@/components/new-thread-menu";
import { ThreadStateDot, canMerge, coordinatedThreads, threadBucket, threadDetail, threadDot } from "@/components/project-tasks";
import { ConfirmDialog } from "@/components/ui/dialog";
import { mergeOrgThread } from "@/lib/api";
import { setStatus } from "@/lib/status";
import type { AgentView, ProjectThreadView, ProjectView } from "@/lib/types";
import { cn } from "@/lib/utils";

const ORDER = { needs: 0, ready: 1, working: 2, resolved: 3 } as const;
/** Resolved threads only matter for a while; the panel keeps the full history. */
const RESOLVED_SHOWN = 2;

/** The coordinator's threads in the order they need attention, recent resolved ones last. */
export function cardThreads(threads: readonly ProjectThreadView[]): ProjectThreadView[] {
  const sorted = [...threads].sort((a, b) => ORDER[threadBucket(a)] - ORDER[threadBucket(b)]);
  const open = sorted.filter((thread) => threadBucket(thread) !== "resolved");
  const resolved = sorted.filter((thread) => threadBucket(thread) === "resolved")
    .sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""))
    .slice(0, RESOLVED_SHOWN);
  return [...open, ...resolved];
}

/**
 * One card per thread the coordinator runs, under its conversation: what the thread is doing and the
 * one action it is waiting for. Merge appears only when Organizations can merge and says nothing
 * blocks it; it still asks first.
 */
export function ThreadCards({ project, coordinatorId, panes, session, readOnly, onOpen, onChanged }: {
  project: ProjectView;
  /** The coordinator thread whose threads to show; the project coordinator when undefined. */
  coordinatorId?: string;
  panes: readonly AgentView[];
  session?: string;
  readOnly: boolean;
  onOpen: (thread: ProjectThreadView) => void;
  onChanged: () => void;
}) {
  const [merging, setMerging] = useState<ProjectThreadView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threads = cardThreads(coordinatedThreads(project, coordinatorId));
  if (threads.length === 0) return null;

  async function merge() {
    if (!merging) return;
    setBusy(true);
    setError(null);
    try {
      await mergeOrgThread({ project: project.slug, id: merging.id }, session);
      setStatus(`Merged ${merging.title}`, "success");
      setMerging(null);
      onChanged();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label="Threads" className="mt-4 flex max-w-xl flex-col gap-2">
      {threads.map((thread) => {
        const bucket = threadBucket(thread);
        const mergeable = !readOnly && canMerge(project, thread);
        const open = thread.paneId ? () => onOpen(thread) : undefined;
        const actions = bucket === "needs" || mergeable;
        const pr = thread.pr?.number !== undefined && (
          <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-status-done/10 px-1.5 text-xs font-medium tabular-nums text-status-done">
            <GitPullRequest aria-hidden className="size-3" />#{thread.pr.number}
          </span>
        );
        return (
          <article key={thread.id} aria-label={thread.title}
            className={cn("relative rounded-xl border border-border bg-card/40 px-3.5", actions ? "py-3" : "py-2")}>
            <div className="flex min-h-7 items-center gap-2.5">
              {bucket === "ready" ? <Eye aria-hidden className="size-3.5 shrink-0 text-primary" /> : <ThreadStateDot state={threadDot(thread)} />}
              {!actions && open
                ? <button type="button" onClick={open} className="flex min-w-0 flex-1 items-baseline gap-2.5 text-left after:absolute after:inset-0 after:rounded-xl after:content-['']">
                  <span className="shrink-0 text-sm font-medium">{thread.title}</span>
                  <span className="truncate text-[13px] text-muted-foreground">{threadDetail(thread, panes)}</span>
                </button>
                : <span className="flex min-w-0 flex-1 items-baseline gap-2.5">
                  <span className="shrink-0 text-sm font-medium">{thread.title}</span>
                  <span className={cn("truncate text-[13px]", bucket === "needs" ? "text-status-blocked" : "text-muted-foreground")}>
                    {bucket === "needs" && thread.status !== "failed" ? "Asked you a question" : threadDetail(thread, panes)}
                  </span>
                </span>}
              {pr}
            </div>
            {actions && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {mergeable && <button type="button" className="h-11 rounded-md bg-foreground px-3 text-[13px] font-medium text-background lg:h-8"
                  onClick={() => { setError(null); setMerging(thread); }}>Merge it</button>}
                {bucket === "needs" && open && <button type="button" className="h-11 rounded-md border border-border px-3 text-[13px] lg:h-8" onClick={open}>Answer</button>}
                {open && <button type="button" className="h-11 rounded-md border border-border px-3 text-[13px] lg:h-8" onClick={open}>View thread</button>}
              </div>
            )}
          </article>
        );
      })}
      <ConfirmDialog open={merging !== null} title="Merge this pull request?" confirmLabel="Merge" busy={busy} error={error}
        description={<><span className="font-medium text-foreground">{merging?.title}</span>{merging?.pr?.number !== undefined ? ` · PR #${merging.pr.number}` : ""} is merged by Herdr Organizations, which checks again that it is approved and green.</>}
        onConfirm={() => void merge()} onCancel={() => { if (!busy) setMerging(null); }} />
    </section>
  );
}
