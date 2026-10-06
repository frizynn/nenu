import { useCallback, useSyncExternalStore } from "react";

const supported = () => typeof window !== "undefined" && typeof window.matchMedia === "function";

/** Live `matchMedia` result; false where media queries are unavailable (tests, old engines). */
export function useMediaQuery(query: string): boolean {
  // Stable per query: a new subscribe function would make React re-subscribe on every render.
  const subscribe = useCallback((onChange: () => void) => {
    if (!supported()) return () => {};
    const list = window.matchMedia(query);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query]);
  return useSyncExternalStore(subscribe, () => supported() && window.matchMedia(query).matches, () => false);
}
