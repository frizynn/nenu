import { useEffect, useState } from "react";

import { errorMessage } from "@/components/node-start";
import { fetchOrgSummary } from "@/lib/api";
import type { CoordinatorAgent, ProjectThreadView, ProjectView, StatusFile, ThreadSummary, TokenUsage } from "@/lib/types";

const NONE: ReadonlyMap<string, ThreadSummary> = new Map();

interface Read {
  summaries: ReadonlyMap<string, ThreadSummary>;
  /** The project coordinator's STATUS.md, token use and agent. */
  status: StatusFile | null;
  usage: TokenUsage | null;
  coordinator: CoordinatorAgent | null;
  failed: string | null;
}
const EMPTY = { summaries: NONE, status: null, usage: null, coordinator: null };

/**
 * What the reports of `threads` say and show, and the project coordinator's STATUS.md, read while a
 * page is on screen and again only when one of them moves: a new report changes its `updated` or its
 * unread mark, an edited STATUS.md its `statusUpdated`. The snapshot does not carry the texts, so its
 * own revalidation is not enough to see one change. Only a project read through Organizations'
 * `--json` has any; a failed read keeps what was shown and says why.
 */
export function useThreadSummaries(project: ProjectView | undefined, threads: readonly ProjectThreadView[]): Read {
  const [read, setRead] = useState<Read & { slug: string } | null>(null);
  const slug = project?.source === "json" ? project.slug : undefined;
  const moved = [project?.statusUpdated ?? "", ...threads.map((thread) =>
    `${thread.id}:${thread.status}:${thread.group ?? ""}:${thread.updated ?? ""}:${thread.reportUnacked ? 1 : 0}:${thread.verdict ?? ""}:${thread.statusUpdated ?? ""}`)].join(",");
  useEffect(() => {
    if (!slug) return;
    const controller = new AbortController();
    fetchOrgSummary(slug, controller.signal).then(
      (reply) => setRead({
        slug, summaries: new Map((reply.threads ?? []).map((summary) => [summary.id, summary])),
        status: reply.status ?? null, usage: reply.usage ?? null, coordinator: reply.coordinator ?? null, failed: null,
      }),
      (failure: unknown) => {
        if (!controller.signal.aborted) setRead((current) => current?.slug === slug ? { ...current, failed: errorMessage(failure) } : { slug, ...EMPTY, failed: errorMessage(failure) });
      },
    );
    return () => controller.abort();
  }, [slug, moved]);
  return read && read.slug === slug ? read : { ...EMPTY, failed: null };
}
