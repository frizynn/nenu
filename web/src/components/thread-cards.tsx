import { useState } from "react";
import { Eye, GitPullRequest } from "lucide-react";

import { errorMessage } from "@/components/node-start";
import { NodeDot } from "@/components/node-row";
import { canMerge, threadDetail, threadTree } from "@/components/project-tasks";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/dialog";
import { mergeOrgThread } from "@/lib/api";
import { orgTree } from "@/lib/org-tree";
import { setStatus } from "@/lib/status";
import type { AgentView, ProjectThreadView, ProjectView } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * One card per open node the coordinator runs, under its conversation, in the organization tree's
 * order: what it is doing and the one action it is waiting for. Resolved work lives in History.
 * Merge appears only when Organizations can merge and says nothing blocks it; it still asks first.
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
  const nodes = orgTree(threadTree(project, coordinatorId)).open;
  if (nodes.length === 0) return null;

  return (
    <section aria-label="Threads" className="mt-4 flex max-w-xl flex-col gap-2">
      {nodes.map(({ thread, state }) => {
        const mergeable = !readOnly && canMerge(project, thread);
        const open = () => onOpen(thread);
        const actions = state === "needs" || mergeable;
        const pr = thread.pr?.number !== undefined && (
          <span className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md bg-status-done/10 px-1.5 text-caption font-medium tabular-nums text-status-done">
            <GitPullRequest aria-hidden className="size-3" />#{thread.pr.number}
          </span>
        );
        return (
          <article key={thread.id} aria-label={thread.title}
            className={cn("relative rounded-xl border border-border bg-card/40 px-3.5", actions ? "py-3" : "py-2")}>
            <div className="flex min-h-7 items-center gap-2.5">
              {state === "review" ? <Eye aria-hidden className="size-3.5 shrink-0 text-primary" /> : <NodeDot state={state} />}
              {!actions
                ? <button type="button" onClick={open} className="flex min-w-0 flex-1 items-baseline gap-2.5 text-left after:absolute after:inset-0 after:rounded-xl after:content-['']">
                  <span className="shrink-0 text-subhead font-medium">{thread.title}</span>
                  <span className="truncate text-footnote text-muted-foreground">{threadDetail(thread, panes)}</span>
                </button>
                : <span className="flex min-w-0 flex-1 items-baseline gap-2.5">
                  <span className="shrink-0 text-subhead font-medium">{thread.title}</span>
                  <span className={cn("truncate text-footnote", state === "needs" ? "text-status-blocked" : "text-muted-foreground")}>
                    {state === "needs" && thread.status !== "failed" ? "Asked you a question" : threadDetail(thread, panes)}
                  </span>
                </span>}
              {pr}
            </div>
            {actions && (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {mergeable && <Button type="button" size="lg" aria-label={`Merge ${thread.title}`} onClick={() => setMerging(thread)}>Merge</Button>}
                {state === "needs" && thread.paneId && <Button type="button" variant="outline" size="lg" className="bg-transparent" onClick={open}>Answer</Button>}
                <Button type="button" variant="outline" size="lg" className="bg-transparent" onClick={open}>View thread</Button>
              </div>
            )}
          </article>
        );
      })}
      <MergeDialog project={project} thread={merging} session={session} onMerged={() => { setMerging(null); onChanged(); }} onCancel={() => setMerging(null)} />
    </section>
  );
}

/** Asks before Herdr Organizations merges a thread's pull request; a refusal stays in the dialog. */
export function MergeDialog({ project, thread, session, onMerged, onCancel }: {
  project: ProjectView;
  thread: ProjectThreadView | null;
  session?: string;
  onMerged: () => void;
  onCancel: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function merge() {
    if (!thread) return;
    setBusy(true);
    setError(null);
    try {
      await mergeOrgThread({ project: project.slug, id: thread.id }, session);
      setStatus(`Merged ${thread.title}`, "success");
      onMerged();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConfirmDialog open={thread !== null} title="Merge this pull request?" confirmLabel="Merge" busy={busy} error={error}
      description={<><span className="font-medium text-foreground">{thread?.title}</span>{thread?.pr?.number !== undefined ? ` · PR #${thread.pr.number}` : ""} is merged by Herdr Organizations, which checks again that it is approved and green.</>}
      onConfirm={() => void merge()} onCancel={() => { if (!busy) { setError(null); onCancel(); } }} />
  );
}
