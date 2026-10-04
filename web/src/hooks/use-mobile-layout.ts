import { useSyncExternalStore } from "react";

const QUERY = "(max-width: 767px)";
const mediaQuery = () => typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(QUERY) : null;
const snapshot = () => mediaQuery()?.matches ?? false;
const serverSnapshot = () => false;
function subscribe(onChange: () => void) {
  const media = mediaQuery();
  if (!media) return () => {};
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

export function useMobileLayout(): boolean {
  return useSyncExternalStore(subscribe, snapshot, serverSnapshot);
}
