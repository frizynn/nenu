import { useEffect, useState } from "react";
import { fetchArtifactMetadata, type ArtifactMetadata } from "@/lib/api";

export function useArtifactMetadata(
  paneId: string,
  session: string | undefined,
  paths: string[],
  enabled: boolean,
) {
  const [found, setFound] = useState<ArtifactMetadata[]>([]);
  // The read last answered; any other is loading from its first frame, not from the effect after it.
  const [settled, setSettled] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [limit, setLimit] = useState(60);
  const [attempt, setAttempt] = useState(0);
  const scope = JSON.stringify([paneId, session]);
  const signature = JSON.stringify(paths.slice(0, limit));
  const key = JSON.stringify([scope, signature, attempt]);
  useEffect(() => {
    setFound([]);
    setLimit(60);
  }, [scope]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const candidates: string[] = JSON.parse(signature);
    setError(false);
    void (async () => {
      try {
        // The bridge takes 20 names a request; the batches go together, as it reads the journal once for all.
        const batches: string[][] = [];
        for (let index = 0; index < candidates.length; index += 20) batches.push(candidates.slice(index, index + 20));
        const result = (await Promise.all(batches.map((batch) => fetchArtifactMetadata(paneId, batch, session, controller.signal)))).flat();
        if (controller.signal.aborted) return;
        setFound(result);
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setSettled(key);
      }
    })();
    return () => controller.abort();
  }, [paneId, session, signature, enabled, attempt, key]);
  return {
    found,
    loading: enabled && signature !== "[]" && settled !== key,
    error,
    more: paths.length > limit,
    loadMore: () => setLimit((n) => n + 60),
    retry: () => setAttempt((n) => n + 1),
  };
}
