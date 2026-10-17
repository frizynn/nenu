import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { X } from "@/components/ui/icon";
import { useBackCloses } from "@/hooks/use-back-closes";
import { useMediaQuery } from "@/hooks/use-media-query";
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
}

/** A controlled, nonmodal inspector. Opening it never takes the composer's focus or locks scroll. */
export function WorkbenchPopover({ open, onDismiss, anchorRef, label, children, className, phoneBack = false }: WorkbenchPopoverProps) {
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
  const [position, setPosition] = useState<{ left: number; top?: number; bottom?: number; height: number } | null>(null);

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
    <div ref={panelRef} role="dialog" aria-label={label} data-workbench-popover="" style={{ position: "fixed", left: position?.left, top: position?.top, bottom: position?.bottom }} className={cn("z-30 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-xl", className)}>
      <div className="flex items-center gap-3 border-b border-border py-1 pl-4 pr-1">
        <h3 className="min-w-0 flex-1 text-sm font-medium">{label}</h3>
        <button type="button" className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring" aria-label={`Close ${label.toLocaleLowerCase()}`} onClick={() => dismiss("close")}>
          <X aria-hidden="true" className="size-4" />
        </button>
      </div>
      <div className="max-h-[min(24rem,45dvh)] overflow-y-auto overscroll-contain p-4" style={position ? { maxHeight: Math.max(48, position.height - 54) } : undefined}>{children}</div>
    </div>
  );
}
