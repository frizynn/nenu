import { useEffect, useState } from "react";
import { fetchArtifactMetadata, type ArtifactMetadata } from "@/lib/api";

export function useArtifactMetadata(
  paneId: string,
  session: string | undefined,
  paths: string[],
  enabled: boolean,
) {
  const [found, setFound] = useState<ArtifactMetadata[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [limit, setLimit] = useState(60);
  const [attempt, setAttempt] = useState(0);
  const scope = JSON.stringify([paneId, session]);
  const signature = JSON.stringify(paths.slice(0, limit));
  useEffect(() => {
    setFound([]);
    setLimit(60);
  }, [scope]);
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const candidates: string[] = JSON.parse(signature);
    setLoading(candidates.length > 0);
    setError(false);
    void (async () => {
      const result: ArtifactMetadata[] = [];
      try {
        for (let index = 0; index < candidates.length; index += 20) {
          result.push(
            ...(await fetchArtifactMetadata(
              paneId,
              candidates.slice(index, index + 20),
              session,
              controller.signal,
            )),
          );
          if (controller.signal.aborted) return;
        }
        setFound(result);
      } catch {
        if (!controller.signal.aborted) setError(true);
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => controller.abort();
  }, [paneId, session, signature, enabled, attempt]);
  return {
    found,
    loading,
    error,
    more: paths.length > limit,
    loadMore: () => setLimit((n) => n + 60),
    retry: () => setAttempt((n) => n + 1),
  };
}
