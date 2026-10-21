import { useEffect, useState } from "react";

import { errorMessage } from "@/components/node-start";
import { fetchOrgAsks } from "@/lib/api";
import type { AsksList, ProjectView } from "@/lib/types";

export interface AsksRead { list: AsksList | null; loaded: boolean; failed: string | null }

/** Whether this Organizations lists asks: the snapshot then counts what waits on you per project. */
export function asksAvailable(projects: readonly ProjectView[] | undefined): boolean {
  return (projects ?? []).some((project) => project.waitingAsks !== undefined);
}

/**
 * Every coordinator's asks, read while a page that shows them is on screen and again only when
 * something they depend on moves in the snapshot: a STATUS.md's stamp, a count waiting, or a thread's
 * state or pull request (what an ask's links confirm). An Organizations that cannot list asks is
 * never asked. A failed read keeps what was shown and says why.
 */
export function useAsks(projects: readonly ProjectView[] | undefined): AsksRead {
  const [read, setRead] = useState<AsksRead>({ list: null, loaded: false, failed: null });
  const enabled = asksAvailable(projects);
  const moved = (projects ?? []).map((project) => `${project.slug}:${project.statusUpdated ?? ""}:${project.waitingAsks ?? "-"}:${project.threads.map((thread) =>
    `${thread.id}:${thread.status}:${thread.group ?? ""}:${thread.pr?.state ?? ""}:${thread.statusUpdated ?? ""}`).join(",")}`).join(";");
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    fetchOrgAsks(controller.signal).then(
      ({ asks, decisions, answers }) => setRead({ list: { asks, decisions, answers }, loaded: true, failed: null }),
      (failure: unknown) => { if (!controller.signal.aborted) setRead((current) => ({ ...current, loaded: true, failed: errorMessage(failure) })); },
    );
    return () => controller.abort();
  }, [enabled, moved]);
  return enabled ? read : { list: null, loaded: true, failed: null };
}
