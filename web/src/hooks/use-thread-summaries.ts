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
type Kept = Read & { slug: string; moved: string };
// Each project's last read with the stamps it answered, so a page opened again draws it in its first
// frame while the snapshot still carries those stamps. Any other read is older than what is on disk.
const lastRead = new Map<string, Kept>();

export function __forgetSummaries(): void {
  lastRead.clear();
}

/**
 * What the reports of `threads` say and show, and the project coordinator's STATUS.md, read while a
 * page is on screen and again only when one of them moves: a new report changes its `updated` or its
 * unread mark, an edited STATUS.md its `statusUpdated`, a new token reading its `usageStamp`. The
 * snapshot does not carry the texts or the numbers, so its
 * own revalidation is not enough to see one change. Only a project read through Organizations'
 * `--json` has any; a failed read keeps what was shown and says why. `ready` is true once
 * there is a read (or a failure) to draw, so a page can hold what it would push down until then.
 */
export function useThreadSummaries(project: ProjectView | undefined, threads: readonly ProjectThreadView[]): Read & { ready: boolean } {
  const [read, setRead] = useState<Kept | null>(null);
  const slug = project?.source === "json" ? project.slug : undefined;
  const moved = [project?.statusUpdated ?? "", project?.usageStamp ?? "", ...threads.map((thread) =>
    `${thread.id}:${thread.status}:${thread.group ?? ""}:${thread.updated ?? ""}:${thread.reportUnacked ? 1 : 0}:${thread.verdict ?? ""}:${thread.statusUpdated ?? ""}:${thread.usageStamp ?? ""}`)].join(",");
  useEffect(() => {
    if (!slug) return;
    const controller = new AbortController();
    fetchOrgSummary(slug, controller.signal).then(
      (reply) => {
        const next = {
          slug, moved, summaries: new Map((reply.threads ?? []).map((summary) => [summary.id, summary])),
          status: reply.status ?? null, usage: reply.usage ?? null, coordinator: reply.coordinator ?? null, failed: null,
        };
        lastRead.set(slug, next);
        setRead(next);
      },
      (failure: unknown) => {
        if (!controller.signal.aborted) setRead((current) => current?.slug === slug ? { ...current, failed: errorMessage(failure) } : { slug, moved, ...EMPTY, failed: errorMessage(failure) });
      },
    );
    return () => controller.abort();
  }, [slug, moved]);
  const kept = slug ? lastRead.get(slug) : undefined;
  const shown = read?.slug === slug ? read : kept?.moved === moved ? kept : null;
  return { ...(shown ?? { ...EMPTY, failed: null }), ready: !slug || shown !== null };
}
