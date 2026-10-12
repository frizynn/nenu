import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { PanelHeader } from "@/components/ui/panel-header";
import { cn } from "@/lib/utils";

export type WorkbenchDismissReason = "outside" | "escape" | "close";

interface WorkbenchPopoverProps {
  open: boolean;
  onDismiss: (reason: WorkbenchDismissReason) => void;
  anchorRef: RefObject<HTMLElement | null>;
  label: string;
  children: ReactNode;
  className?: string;
  /** Below the desk, draw it as a bottom sheet (see PHONE_SHEET). */
  sheetBelowDesk?: boolean;
}

// Below the desk breakpoint a `sheetBelowDesk` popover is a bottom sheet rather than a card floating
// over the thread and the composer: full width, pinned to the bottom edge above the home indicator,
// sliding up. It stays the same nonmodal popover underneath (outside tap, Escape and ✕ dismiss it, and
// opening it never takes the composer's focus), so only the placement changes, with a sheet's title.
// The popover positions itself with inline left/top/bottom from its anchor; the important utilities
// are what lets a class win over that inline placement on a phone. The body there is full bleed: its
// rows own the 16px gutter, so they start where the sheet's title does.
const PHONE_SHEET = [
  "max-lg:left-0! max-lg:right-0! max-lg:top-auto! max-lg:bottom-0! max-lg:w-full! max-lg:max-w-none!",
  "max-lg:rounded-b-none max-lg:rounded-t-2xl max-lg:border-x-0 max-lg:border-b-0 max-lg:pb-[env(safe-area-inset-bottom)]",
  "max-lg:duration-200 max-lg:animate-in max-lg:slide-in-from-bottom-4 motion-reduce:animate-none",
].join(" ");

/** A controlled, nonmodal inspector. Opening it never takes the composer's focus or locks scroll. */
export function WorkbenchPopover({ open, onDismiss, anchorRef, label, children, className, sheetBelowDesk = false }: WorkbenchPopoverProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const dismissed = useRef(false);
  const dismissRef = useRef(onDismiss);
  dismissRef.current = onDismiss;
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; height: number } | null>(null);

  const dismiss = useCallback((reason: WorkbenchDismissReason) => {
    if (dismissed.current) return;
    dismissed.current = true;
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
      const next = above >= 160 || above >= below
        ? { left, bottom: window.innerHeight - rect.top + 8, height: Math.max(80, above) }
        : { left, top: rect.bottom + 8, height: Math.max(80, below) };
      setPosition((previous) => previous?.left === next.left && previous?.top === next.top && previous?.bottom === next.bottom && previous?.height === next.height ? previous : next);
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
  }, [open, anchorRef]);

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

  if (!open) return null;
  return (
    <div ref={panelRef} role="dialog" aria-label={label} data-workbench-popover="" style={{ position: "fixed", left: position?.left, top: position?.top, bottom: position?.bottom }} className={cn("z-30 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl", sheetBelowDesk && PHONE_SHEET, className)}>
      <PanelHeader title={label} onClose={() => dismiss("close")} sheetBelowDesk={sheetBelowDesk} />
      <div className={cn("max-h-[min(24rem,45dvh)] overflow-y-auto overscroll-contain p-4", sheetBelowDesk && "max-lg:px-0")} style={position ? { maxHeight: Math.max(48, position.height - 54) } : undefined}>{children}</div>
    </div>
  );
}
