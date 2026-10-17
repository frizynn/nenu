import { useCallback, useEffect, useRef } from "react";

/**
 * A phone's Back closes an open layer (a chip's panel, the model sheet) instead of the page under it.
 * While `open`, the layer stands on a history entry of its own, a copy of the page's, so the router
 * sees the same page on either side of it; Back steps off it and `onBack` runs. The returned `leave`
 * steps back over the entry when the layer closed itself and still stands on it, so Back afterwards
 * leaves the page. A layer closed by a press that may start a navigation should not call it: stepping
 * back then would race the navigation.
 */
export function useBackCloses(key: string, open: boolean, enabled: boolean, onBack: () => void): () => void {
  const back = useRef(onBack);
  back.current = onBack;
  const onEntry = useCallback(() => Boolean((window.history.state as Record<string, unknown> | null)?.[key]), [key]);
  useEffect(() => {
    if (!open || !enabled) return;
    if (!onEntry()) window.history.pushState({ ...(window.history.state as object | null), [key]: true }, "");
    const onPop = () => { if (!onEntry()) back.current(); };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [open, enabled, key, onEntry]);
  return useCallback(() => { if (enabled && onEntry()) window.history.back(); }, [enabled, onEntry]);
}
