import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { ChevronDown } from "@/components/ui/icon";

import { useLongPress } from "@/hooks/use-long-press";
import { StatusDot } from "@/components/status-badge";
import { revealScrollLeft } from "@/components/ui/strip-reveal";
import { STATUS_LABEL, type AgentStatus } from "@/lib/types";

// The tab and pane strips above a chat share this one chip, styled in styles/strips.css: a pill with
// a leading glyph, a name capped so it can't hide its siblings, and a neutral fill on the open one.

/** The fade a strip draws on an edge it can still scroll toward (strips.css: --fade-start/--fade-end).
 *  chip.test.tsx reads that width from strips.css, so the two can't drift apart. */
const EDGE_FADE = 40;

interface ChipProps {
  label: string;
  /** Tells same-named siblings apart, drawn quieter than the name. Omit when the name is unique. */
  tag?: string;
  active: boolean;
  /** Dashed outline for the item focused in the desktop TUI. */
  focused?: boolean;
  /** Drawn as a leading dot and said after the name ("claude, idle"); omit when there is no agent,
   *  since empty is not idle. */
  status?: AgentStatus | null;
  /** A glyph in place of the dot (a shell's). */
  icon?: ReactNode;
  onClick: () => void;
  /** Long-press (or right-click / Android contextmenu) opens the chip's actions. Inert when unset. */
  onLongPress?: () => void;
  /** A tap on the chip while it is `active` opens its actions instead of a dead re-select, and the
   *  chip shows a chevron saying so: long-press alone was a gesture nobody found. */
  onTapActive?: () => void;
  /** Makes the chip draggable along a strip that runs useStripReorder (ui/strip-reorder). */
  reorderKey?: string;
  /** Held or dragged right now: lifted off the row (strips.css). */
  lifted?: boolean;
}

export function Chip({ label, tag, active, focused, status, icon, onClick, onLongPress, onTapActive, reorderKey, lifted }: ChipProps) {
  const longPress = useLongPress(onLongPress);
  const opensActions = active && !!onTapActive;

  // A long-press already suppresses the click that follows (longPress.onClickCapture), so this only
  // sees a genuine tap.
  function handleClick() {
    if (active && onTapActive) {
      onTapActive();
      return;
    }
    onClick();
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      {...longPress}
      aria-current={active ? "true" : undefined}
      aria-haspopup={opensActions ? "dialog" : undefined}
      data-focused={focused || undefined}
      data-reorder-key={reorderKey}
      data-lifted={lifted || undefined}
      title={label}
      className="strip-chip"
    >
      {icon ?? (status && <StatusDot status={status} />)}
      <span className="strip-chip-label">{label}</span>
      {tag && <span className="strip-chip-tag"> · {tag}</span>}
      {status && <span className="sr-only">, {STATUS_LABEL[status]}</span>}
      {opensActions && <ChevronDown data-chip-actions aria-hidden="true" className="strip-chip-more" />}
    </button>
  );
}

interface ChipStripProps {
  /** Which strip this is: also the hook the keyboard rule and the bench use. */
  band: "tabs" | "panes";
  /** The open item's key: when it changes, the strip scrolls its chip into view. */
  activeKey: string;
  /** Before the scroller, outside it (the desk's "Panes" label). */
  lead?: ReactNode;
  /** After the scroller, outside it, so it never scrolls out of reach (the tab strip's +). */
  trail?: ReactNode;
  /** The scroller, for a strip whose chips can be dragged (ui/strip-reorder). */
  scrollerRef?: RefObject<HTMLDivElement | null>;
  children: ReactNode;
}

// One row of chips that scrolls sideways. The open chip is kept in view, and an edge the row can
// still scroll toward fades, so a sibling past it is seen to exist.
export function ChipStrip({ band, activeKey, lead, trail, scrollerRef: givenScrollerRef, children }: ChipStripProps) {
  const ownScrollerRef = useRef<HTMLDivElement>(null);
  const scrollerRef = givenScrollerRef ?? ownScrollerRef;
  const chipsRef = useRef<HTMLDivElement>(null);
  const revealed = useRef<ChipSpot | null>(null);

  // Another chip opens: bring it into view.
  useLayoutEffect(() => {
    if (scrollerRef.current) revealOpenChip(scrollerRef.current, revealed);
  }, [activeKey]);

  // The chips change size on a rename, a chip that comes or goes, or a late web font: if that moved
  // the open one, it comes back into view. Which edges fade follows every scroll and every resize.
  useEffect(() => {
    const scroller = scrollerRef.current;
    const chips = chipsRef.current;
    if (!scroller || !chips) return;
    const update = () => markFadingEdges(scroller);
    scroller.addEventListener("scroll", update, { passive: true });
    // A mouse wheel only turns vertically and a strip has no scrollbar, so the wheel scrolls it
    // sideways. A trackpad's own sideways swipe passes through untouched.
    const wheel = (e: WheelEvent) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || scroller.scrollWidth <= scroller.clientWidth) return;
      e.preventDefault();
      scroller.scrollLeft += e.deltaMode === WheelEvent.DOM_DELTA_LINE ? e.deltaY * 16 : e.deltaY;
    };
    scroller.addEventListener("wheel", wheel, { passive: false });
    const resize =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            revealOpenChip(scroller, revealed);
            update();
          });
    resize?.observe(scroller);
    resize?.observe(chips);
    update();
    return () => {
      scroller.removeEventListener("scroll", update);
      scroller.removeEventListener("wheel", wheel);
      resize?.disconnect();
    };
  }, []);

  return (
    <div data-workbench-navigation-band={band} className="strip">
      {lead}
      <div ref={scrollerRef} className="strip-scroller">
        <div ref={chipsRef} className="strip-chips">
          {children}
        </div>
      </div>
      {trail}
    </div>
  );
}

/** Where the open chip sat, in the strip's scroll coordinates, when the strip last brought it in. */
interface ChipSpot {
  chip: HTMLElement;
  start: number;
  end: number;
}

/** Scrolls the open chip into view, unless it sits where it sat the last time: a strip the user
 *  scrolled by hand stays put until the open chip changes, moves or resizes. */
function revealOpenChip(scroller: HTMLElement, last: { current: ChipSpot | null }) {
  const chip = scroller.querySelector<HTMLElement>('[aria-current="true"]');
  if (!chip) return;
  const spot = { chip, start: chip.offsetLeft, end: chip.offsetLeft + chip.offsetWidth };
  const prev = last.current;
  if (prev && prev.chip === chip && prev.start === spot.start && prev.end === spot.end) return;
  last.current = spot;
  const left = revealScrollLeft({
    scrollLeft: scroller.scrollLeft,
    width: scroller.clientWidth,
    max: scroller.scrollWidth - scroller.clientWidth,
    fade: EDGE_FADE,
    start: spot.start,
    end: spot.end,
  });
  if (left !== null) scroller.scrollLeft = left;
}

/** Marks the edges a strip can still scroll toward, which strips.css fades. */
function markFadingEdges(scroller: HTMLElement) {
  const max = scroller.scrollWidth - scroller.clientWidth;
  const edges = [scroller.scrollLeft > 1 && "start", scroller.scrollLeft < max - 1 && "end"].filter(Boolean);
  scroller.dataset.overflow = edges.join(" ");
}
