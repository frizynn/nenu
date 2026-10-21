import { cn } from "@/lib/utils";

// The composer docks' one control surface: a filled tile on the dock's card, used by the Keys pad,
// the quick replies, Display's steppers and a segmented control's chosen segment. The fill makes it
// read as a key or a chip (about 1.3:1 against the card), and the 1px edge carries the 3:1 a
// control's boundary needs (WCAG 1.4.11). The edge borrows --switch-ring, the token index.css
// measures at 3:1 on the card for that job; a --control-edge token would be foundations' call.
// A disabled tile recedes to the disabled fill and a hairline, instead of keeping its edge.
export const DOCK_TILE =
  "border border-[color:var(--switch-ring)] bg-foreground/10 text-foreground hover:bg-foreground/15 disabled:border-border disabled:bg-disabled";

/** A tile that just took a press: a step past hover, never the accent. */
export const DOCK_TILE_PRESSED = "bg-foreground/20 hover:bg-foreground/20";

// A segmented control (the Keys pads, the chat's Text size in Display): a hairline track whose chosen segment is
// a tile. The track has no fill of its own, so the tile's edge sits on the card at its full 3:1.
export const SEGMENT_TRACK = "grid auto-cols-fr grid-flow-col gap-1 rounded-lg border border-border p-1";

export function segmentClass(selected: boolean): string {
  return cn(
    "hit-area h-9 rounded-md border px-2 text-subhead font-medium transition-colors duration-120 ease-out motion-reduce:transition-none",
    selected ? DOCK_TILE : "border-transparent text-muted-foreground hover:text-foreground",
  );
}
