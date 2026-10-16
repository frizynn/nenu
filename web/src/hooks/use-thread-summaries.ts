import { useEffect, useState } from "react";

import { errorMessage } from "@/components/node-start";
import { fetchOrgSummary } from "@/lib/api";
import type { ProjectThreadView, ProjectView, ThreadSummary } from "@/lib/types";

const NONE: ReadonlyMap<string, ThreadSummary> = new Map();

/**
 * What the reports of `threads` say and show, read while a node's page is on screen and again only
 * when one of them moves: a new report changes its `updated` or its unread mark. The snapshot does
 * not carry the summaries, so its own revalidation is not enough to see one change. Only a project
 * read through Organizations' `--json` has any; a failed read keeps what was shown and says why.
 */
export function useThreadSummaries(project: ProjectView | undefined, threads: readonly ProjectThreadView[]): { summaries: ReadonlyMap<string, ThreadSummary>; failed: string | null } {
  const [read, setRead] = useState<{ slug: string; summaries: ReadonlyMap<string, ThreadSummary>; failed: string | null } | null>(null);
  const slug = project?.source === "json" ? project.slug : undefined;
  const moved = threads.map((thread) => `${thread.id}:${thread.status}:${thread.group ?? ""}:${thread.updated ?? ""}:${thread.reportUnacked ? 1 : 0}:${thread.verdict ?? ""}`).join(",");
  useEffect(() => {
    if (!slug) return;
    const controller = new AbortController();
    fetchOrgSummary(slug, controller.signal).then(
      (reply) => setRead({ slug, summaries: new Map((reply.threads ?? []).map((summary) => [summary.id, summary])), failed: null }),
      (failure: unknown) => {
        if (!controller.signal.aborted) setRead((current) => ({ slug, summaries: current?.slug === slug ? current.summaries : NONE, failed: errorMessage(failure) }));
      },
    );
    return () => controller.abort();
  }, [slug, moved]);
  return read && read.slug === slug ? read : { summaries: NONE, failed: null };
}
