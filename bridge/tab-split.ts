/** One pane of a tab's layout, as Herdr's `pane.layout` reports it (cells). */
export interface LayoutPane {
  pane_id: string;
  rect: { width: number; height: number };
}

/**
 * Where a new pane goes in a tab: beside its largest pane, so repeated starts never shave one pane
 * thin. A pane at least twice as wide as tall in cells (about square on screen) splits to the right,
 * any other down, as Herdr's own guide splits them. Null for a tab with no panes.
 */
export function splitTarget(panes: readonly LayoutPane[]): { paneId: string; direction: "right" | "down" } | null {
  const area = (p: LayoutPane) => p.rect.width * p.rect.height;
  const largest = panes.reduce<LayoutPane | null>((best, p) => (!best || area(p) > area(best) ? p : best), null);
  if (!largest) return null;
  return { paneId: largest.pane_id, direction: largest.rect.width >= 2 * largest.rect.height ? "right" : "down" };
}
