// The chunks a desk's chat draws beside it, each a lazy import of its own so a phone never loads them.
// Opening a pane on a desk asks for them with its read instead of after the chat's first render.

const DESK = "(min-width: 1024px)";

export const loadSessionPanel = () => import("@/components/inspector-panels");

export function preloadDeskChunks(): void {
  if (typeof window === "undefined" || !window.matchMedia?.(DESK).matches) return;
  void loadSessionPanel().catch(() => {});
}
