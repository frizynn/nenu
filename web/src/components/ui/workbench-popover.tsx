import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useBackCloses } from "@/hooks/use-back-closes";
import { useMediaQuery } from "@/hooks/use-media-query";
import { PanelHeader } from "@/components/ui/panel-header";
import { cn } from "@/lib/utils";

export type WorkbenchDismissReason = "outside" | "escape" | "close" | "back";

interface WorkbenchPopoverProps {
  open: boolean;
  onDismiss: (reason: WorkbenchDismissReason) => void;
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  children: ReactNode;
  className?: string;
  /** On a touch screen, Back closes it (a sheet a phone expects to leave that way). */
  phoneBack?: boolean;
  /** Below the desk, draw it as a bottom sheet (see PHONE_SHEET). */
  sheetBelowDesk?: boolean;
  /** A glance of a few rows: the desk's smaller title and a 12px inset on every screen. */
  dense?: boolean;
}

// Below the desk breakpoint a `sheetBelowDesk` popover is a bottom sheet rather than a card floating
// over the thread and the composer: full width, pinned to the bottom edge above the home indicator,
// rising from it on the drawer curve a phone's own sheets use. It stays the same nonmodal popover
// underneath (outside tap, Escape, ✕ and, with `phoneBack`, a phone's Back dismiss it, and opening it
// never takes the composer's focus), so only the placement changes, with a sheet's title.
// The popover positions itself with inline left/top/bottom from its anchor; the important utilities
// are what lets a class win over that inline placement on a phone. The body there is full bleed: its
// rows own the 16px gutter, so they start where the sheet's title does. It leaves the way it came: a
// card fades back toward its anchor (index.css), a sheet slides down as BottomSheet's does. Under
// reduced motion neither moves: index.css stops both.
/** Where the desk starts: below it a `sheetBelowDesk` popover is a sheet (Tailwind's `lg`). */
const DESK_WIDTH = 1024;
const PHONE_SHEET = [
  "max-lg:left-0! max-lg:right-0! max-lg:top-auto! max-lg:bottom-0! max-lg:w-full! max-lg:max-w-none!",
  "max-lg:rounded-b-none max-lg:rounded-t-2xl max-lg:border-x-0 max-lg:border-b-0 max-lg:pb-[env(safe-area-inset-bottom)]",
].join(" ");
const SHEET_ENTER = "max-lg:duration-180 max-lg:ease-out max-lg:animate-in max-lg:slide-in-from-bottom";
const SHEET_LEAVE = "duration-180 ease-out animate-out slide-out-to-bottom fill-mode-forwards";

/** Where it sits: over its anchor, under it, or a sheet on the bottom edge. Each enters and leaves from its own side. */
type Side = "above" | "below" | "sheet";

/**
 * Keeps a layer drawn while it leaves: `leaving` is the cue for its exit (a `data-leaving` rule, or an
 * `animate-out` class), and the layer goes once every animation and transition that cue started on it
 * has ended, or at once when none runs (reduced motion, an engine without `getAnimations`, a test).
 */
export function useLeaving(open: boolean, layer: RefObject<HTMLElement | null>) {
  const [drawn, setDrawn] = useState(open);
  if (open && !drawn) setDrawn(true);
  const leaving = drawn && !open;
  useEffect(() => {
    if (!leaving) return;
    const running = layer.current?.getAnimations?.() ?? [];
    if (running.length === 0) {
      setDrawn(false);
      return;
    }
    let current = true;
    void Promise.allSettled(running.map((animation) => animation.finished)).then(() => {
      if (current) setDrawn(false);
    });
    return () => {
      current = false;
    };
  }, [leaving, layer]);
  return { mounted: open || drawn, leaving };
}

/** A controlled, nonmodal inspector. Opening it never takes the composer's focus or locks scroll. */
export function WorkbenchPopover({ open, onDismiss, anchorRef, label, children, className, phoneBack = false, sheetBelowDesk = false, dense = false }: WorkbenchPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const dismissed = useRef(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const coarse = useMediaQuery("(pointer: coarse)");
  // How it last closed: an outside press may be starting a navigation and Back already stepped, so
  // only the other ways out, its parent's included, step back over the entry it stands on.
  const closedBy = useRef<WorkbenchDismissReason | null>(null);
  const leaveEntry = useBackCloses("nenuPopover", open, phoneBack && coarse, () => dismiss("back"));
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open) { wasOpen.current = true; closedBy.current = null; return; }
    if (wasOpen.current && closedBy.current !== "outside" && closedBy.current !== "back") leaveEntry();
    wasOpen.current = false;
  }, [open, leaveEntry]);
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; height: number; side: Side } | null>(null);
  const { mounted, leaving } = useLeaving(open, panelRef);

  const dismiss = useCallback((reason: WorkbenchDismissReason) => {
    if (dismissed.current) return;
    dismissed.current = true;
    closedBy.current = reason;
    const active = document.activeElement;
    const restore = reason !== "outside" &&
      (active === document.body || active === anchorRef.current || (active !== null && panelRef.current?.contains(active)));
    dismissRef.current(reason);
    // Outside presses/focus changes belong to their target. Do not steal a caret or stop dictation.
    if (restore) anchorRef.current?.focus({ preventScroll: true });
  }, [anchorRef]);

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = anchorRef.current;
      const panel = panelRef.current;
      if (!anchor || !panel) return;
      const rect = anchor.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportLeft = viewport?.offsetLeft ?? 0;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportWidth = viewport?.width ?? window.innerWidth;
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const width = panel.getBoundingClientRect().width || Math.min(320, viewportWidth - 24);
      const left = Math.max(viewportLeft + 12, Math.min(rect.left, viewportLeft + viewportWidth - width - 12));
      const above = rect.top - viewportTop - 20;
      const below = viewportBottom - rect.bottom - 20;
      // Above unless only below holds it all: what it holds, plus its header.
      const want = (panel.lastElementChild?.scrollHeight ?? 0) + (panel.firstElementChild?.getBoundingClientRect().height ?? 0);
      const placeAbove = above >= want || (below < want && (above >= 160 || above >= below));
      // A sheet sits on the bottom edge whatever opened it: its room is the screen's, not the anchor's side.
      const sheet = sheetBelowDesk && viewportWidth < DESK_WIDTH;
      const room = sheet ? (viewport?.height ?? window.innerHeight) * 0.75 : placeAbove ? above : below;
      const side: Side = sheet ? "sheet" : placeAbove ? "above" : "below";
      const next = placeAbove
        ? { left, bottom: window.innerHeight - rect.top + 8, height: Math.max(80, room), side }
        : { left, top: rect.bottom + 8, height: Math.max(80, room), side };
      setPosition((previous) => previous?.left === next.left && previous?.top === next.top && previous?.bottom === next.bottom && previous?.height === next.height && previous?.side === next.side ? previous : next);
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    if (anchorRef.current) observer?.observe(anchorRef.current);
    if (panelRef.current) observer?.observe(panelRef.current);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
      observer?.disconnect();
    };
  }, [open, anchorRef, sheetBelowDesk]);

  useEffect(() => {
    if (!open) return;
    dismissed.current = false;
    const inside = (target: EventTarget | null) => target instanceof Node &&
      (panelRef.current?.contains(target) || anchorRef.current?.contains(target));
    const onPointer = (event: PointerEvent) => { if (!inside(event.target)) dismiss("outside"); };
    const onFocus = (event: FocusEvent) => { if (!inside(event.target)) dismiss("outside"); };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      dismiss("escape");
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("focusin", onFocus, true);
    // Bubble so an inner combobox/IME can consume Escape before the inspector sees it.
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("focusin", onFocus, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, anchorRef, dismiss]);

  if (!mounted) return null;
  return (
    <div ref={panelRef} role="dialog" aria-label={label} data-workbench-popover="" data-side={position?.side} data-leaving={leaving ? "" : undefined} inert={leaving || undefined}
      style={{ position: "fixed", left: position?.left, top: position?.top, bottom: position?.bottom }}
      className={cn("z-30 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl", sheetBelowDesk && PHONE_SHEET,
        sheetBelowDesk && !leaving && SHEET_ENTER, leaving && position?.side === "sheet" && SHEET_LEAVE, className)}>
      <PanelHeader title={label} onClose={() => dismiss("close")} sheetBelowDesk={sheetBelowDesk} dense={dense} />
      <div className={cn("max-h-[min(24rem,45dvh)] overflow-y-auto overscroll-contain", dense ? "p-3" : "p-4", sheetBelowDesk && "max-lg:px-0")} style={position ? { maxHeight: Math.max(48, position.height - 54) } : undefined}>{children}</div>
    </div>
  );
}
