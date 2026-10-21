import * as React from "react";
import { ChevronLeft, X } from "@/components/ui/icon";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { usePresence } from "@/components/ui/presence";

/** A mouse or trackpad drives the page, so focusing a field raises no on-screen keyboard. */
export function finePointer(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches;
}

// Minimal modal focus handling (no deps, no full trap): on open move focus into the panel so
// keyboard / screen-reader users land inside the dialog; on close restore focus to whatever was
// focused before it opened. The panel must carry tabIndex={-1} to be a focus target, and draws no
// ring: it is where focus waits, not a control. Where focusing a field raises no on-screen keyboard,
// the field the sheet marks `data-autofocus` takes focus instead, so a search starts on the first
// keystroke; on a touch screen the keyboard stays down.
function useDialogFocus(open: boolean, panelRef: React.RefObject<HTMLElement | null>) {
  React.useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const field = finePointer() ? panelRef.current?.querySelector<HTMLElement>("[data-autofocus]") : null;
    (field ?? panelRef.current)?.focus({ preventScroll: true });
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus?.({ preventScroll: true });
    };
  }, [open, panelRef]);
}

// Every layer here leaves the way it came and stays mounted until its exit animation ends
// (presence.ts), out of reach (inert) while it goes. Reduced motion keeps one 120 ms fade of the whole
// layer and nothing that moves. Animations come from tw-animate-css (already imported).
const LAYER_MOTION = {
  open: "motion-reduce:animate-in motion-reduce:fade-in motion-reduce:duration-120",
  closing: "motion-reduce:animate-out motion-reduce:fade-out motion-reduce:duration-120 motion-reduce:fill-mode-forwards",
};
const BACKDROP_MOTION = {
  open: "animate-in fade-in",
  closing: "animate-out fade-out fill-mode-forwards",
};

/**
 * How a bottom sheet sits on a desk (1024 px and up, where the app shows its sidebar): `panel` is a
 * compact panel for a few actions, centred; `dialog` is a dialog for a list you search, held near
 * the top so its field stays put while the results change. Both keep the sheet's own surface, the
 * one the rows and headers other screens put inside a sheet are drawn for, and come in and go out as
 * the app's dialogs do, with a fade and a 0.98 scale. index.css caps the panel's height outside any
 * layer, so only an important utility can lower that cap.
 */
const DESKTOP = {
  panel: { viewport: "lg:justify-center", panel: "lg:max-w-80" },
  dialog: { viewport: "lg:justify-start lg:pt-[12dvh]", panel: "lg:max-w-160 lg:max-h-[80dvh]!" },
} as const;

/** What a sheet's header says: the title, and the way back to the step before when there is one. */
interface SheetStep {
  title: string | undefined;
  back: (() => void) | undefined;
}

const SheetStepContext = React.createContext<React.Dispatch<React.SetStateAction<SheetStep | null>> | null>(null);

/**
 * Names the sheet this renders in, and with `onBack` puts the chevron back before the title, for as
 * long as it is on screen: a step a sheet shows in place of its list (a rename, a confirmation) titles
 * the sheet's one header instead of drawing a second one. Gone, it hands the sheet its own title back.
 */
export function useSheetStep(title: string, onBack?: () => void) {
  const claim = React.useContext(SheetStepContext);
  const back = React.useRef(onBack);
  React.useLayoutEffect(() => {
    back.current = onBack;
  });
  const hasBack = onBack !== undefined;
  React.useLayoutEffect(() => {
    if (!claim) return;
    const step: SheetStep = { title, back: hasBack ? () => back.current?.() : undefined };
    claim(step);
    return () => claim((current) => (current === step ? null : current));
  }, [claim, title, hasBack]);
}

// A minimal bottom sheet — no Radix, no portals, no extra deps. Renders nothing once closed and
// gone. Dismisses on backdrop tap or Escape.
interface BottomSheetProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  /** A sheet with steps: the way back to the step before, a chevron before the title. */
  onBack?: () => void;
  children: React.ReactNode;
  className?: string;
  /** The body's own layout, for a sheet that lays its content out edge to edge. */
  bodyClassName?: string;
  /** The title, for a sheet that moves focus to it as its steps change. */
  headingRef?: React.Ref<HTMLHeadingElement>;
  /** Its shape from 1024 px; below that it is always the bottom sheet. */
  desktop?: keyof typeof DESKTOP;
}

export function BottomSheet({ open, onClose, title, onBack, children, className, bodyClassName, headingRef, desktop = "panel" }: BottomSheetProps) {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef({ startY: 0, atTop: false, engaged: false, dy: 0 });
  const [dragY, setDragY] = React.useState(0);
  const [step, setStep] = React.useState<SheetStep | null>(null);
  const titleId = React.useId();
  const { mounted, closing, content } = usePresence(open, { title, onBack, children }, viewportRef);
  const header = step ?? { title: content.title, back: content.onBack };
  useDialogFocus(open, panelRef);

  // Backdrop dismiss requires press AND release on the backdrop itself (the Radix
  // outside-pointerdown rule) — NOT just whatever the browser happens to synthesize a `click` on. A
  // long-press that opens this sheet has its finger still down at the moment the sheet mounts; the
  // browser's release click then lands on whatever is now under the finger, which is the backdrop —
  // and without this guard that click would immediately close the sheet it just opened. Arming only
  // on a backdrop `pointerdown` means a click that originated elsewhere (e.g. the pill's release)
  // never dismisses.
  const backdropArmed = React.useRef(false);
  React.useEffect(() => {
    if (open) backdropArmed.current = false;
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Drag-to-dismiss: pull the sheet down from the top to close it. The touchmove listener is
  // attached NON-PASSIVE so we can `preventDefault()` the downward pull — that's what suppresses
  // the browser's pull-to-refresh (otherwise a pull-down at the top would reload the whole app
  // instead of closing the sheet). A gesture that starts mid-scroll falls through to normal list
  // scrolling; only a pull that begins at the top engages the dismiss.
  React.useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    setDragY(0);
    const SLOP = 6; // ignore taps / tiny jitter before engaging the drag
    const CLOSE = 90; // px past which release closes instead of snapping back

    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!t) return;
      let atTop = panel.scrollTop <= 0;
      // A nested list owns its scroll gesture; the sheet must not turn a downward scroll into
      // dismissal. Inputs also own selection/drag gestures while editing.
      let target = e.target instanceof Element ? e.target : null;
      if (target?.closest("input, textarea, select, [contenteditable=true]")) atTop = false;
      while (target && target !== panel) {
        if (target.scrollTop > 0 && /auto|scroll/.test(getComputedStyle(target).overflowY)) atTop = false;
        target = target.parentElement;
      }
      drag.current = { startY: t.clientY, atTop, engaged: false, dy: 0 };
    };
    const onMove = (e: TouchEvent) => {
      const d = drag.current;
      if (!d.atTop) return;
      const t = e.touches[0];
      if (!t) return;
      const dy = t.clientY - d.startY;
      if (!d.engaged && dy > SLOP) d.engaged = true;
      if (d.engaged) {
        e.preventDefault();
        const off = Math.max(0, dy);
        d.dy = off;
        setDragY(off);
      }
    };
    const onEnd = () => {
      const off = drag.current.dy;
      drag.current = { startY: 0, atTop: false, engaged: false, dy: 0 };
      if (off > CLOSE) onClose();
      else setDragY(0);
    };

    panel.addEventListener("touchstart", onStart, { passive: true });
    panel.addEventListener("touchmove", onMove, { passive: false });
    panel.addEventListener("touchend", onEnd);
    panel.addEventListener("touchcancel", onEnd);
    return () => {
      panel.removeEventListener("touchstart", onStart);
      panel.removeEventListener("touchmove", onMove);
      panel.removeEventListener("touchend", onEnd);
      panel.removeEventListener("touchcancel", onEnd);
    };
  }, [open, onClose]);

  if (!mounted) return null;

  return (
    <div
      ref={viewportRef}
      className={cn(
        "sheet-viewport fixed inset-x-0 z-50 flex flex-col justify-end lg:items-center",
        DESKTOP[desktop].viewport,
        closing ? LAYER_MOTION.closing : LAYER_MOTION.open,
      )}
      role="dialog"
      aria-modal="true"
      aria-labelledby={header.title ? titleId : undefined}
      inert={closing}
    >
      {/* Backdrop: still dismisses on tap, but hidden from assistive tech — the ✕ in the header is
          the single accessible "Close", so the dialog isn't announced with a giant duplicate. Dismiss
          fires only when the pointer went DOWN on the backdrop too — see backdropArmed above. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className={cn(
          "absolute inset-0 bg-black/50 duration-180 ease-out motion-reduce:animate-none",
          closing ? BACKDROP_MOTION.closing : BACKDROP_MOTION.open,
        )}
        onPointerDown={() => {
          backdropArmed.current = true;
        }}
        onClick={() => {
          if (!backdropArmed.current) return;
          backdropArmed.current = false;
          onClose();
        }}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        style={{
          transform: dragY ? `translateY(${dragY}px)` : undefined,
          transition: drag.current.engaged ? "none" : undefined,
        }}
        className={cn(
          "sheet-bottom-panel relative z-10 w-full overflow-y-auto overscroll-contain rounded-t-2xl outline-none border-t border-border bg-background shadow-2xl duration-180 ease-out motion-reduce:animate-none",
          "pb-[calc(env(safe-area-inset-bottom)_+_1rem)]",
          "lg:rounded-2xl lg:border lg:pb-1 lg:shadow-[var(--shadow-float)]",
          // A released drag closes from where the finger left it: the exit runs from the panel's
          // own transform to fully below the screen.
          closing
            ? "animate-out slide-out-to-bottom fill-mode-forwards lg:fade-out lg:zoom-out-98 lg:slide-out-to-bottom-0"
            : "animate-in slide-in-from-bottom-4 lg:fade-in lg:zoom-in-98 lg:slide-in-from-bottom-0",
          DESKTOP[desktop].panel,
          className,
        )}
      >
        {/* The one header: the title at the start, the chevron back before it on a sheet with steps,
            the ✕ at the end. Both buttons reach 44px on a touch screen and hang into the 16px gutter,
            so the title starts where the rows below do. A long title (a confirmation naming a long
            tab) wraps whole rather than losing its question mark; the title's padding makes one line
            as tall as the buttons, so they stay beside its first line. */}
        <div className="sticky top-0 z-10 border-b border-border/60 bg-background/95 backdrop-blur-md">
          {/* Grab handle — pull down (from anywhere at the top) to dismiss. From 640 px a sheet may
              float as a dialog (its owner's or the desk's), where a handle promises a pull that
              isn't there. */}
          <div className="flex justify-center pt-2 pb-1 sm:hidden">
            <span className="h-1 w-9 rounded-full bg-muted-foreground/40" />
          </div>
          <div className="flex items-start gap-1 px-4 pb-2 sm:pt-3">
            {header.back && (
              <Button variant="ghost" size="icon" className="-ml-2 coarse:-ml-3" onClick={header.back} aria-label="Back">
                <ChevronLeft className="size-5" />
              </Button>
            )}
            <h2 ref={headingRef} id={header.title ? titleId : undefined} tabIndex={-1} className="min-w-0 flex-1 py-1 text-title [overflow-wrap:anywhere] outline-none coarse:py-2">
              {header.title}
            </h2>
            <Button variant="ghost" size="icon" className="-mr-2 coarse:-mr-3" onClick={onClose} aria-label="Close">
              <X className="size-5" />
            </Button>
          </div>
        </div>
        <div className={cn("px-4 py-3", bodyClassName)}>
          <SheetStepContext value={setStep}>{content.children}</SheetStepContext>
        </div>
      </div>
    </div>
  );
}

// A left-edge drawer — same no-deps approach as BottomSheet, but slides in from the side and fills
// the viewport height from the top. The phone's navigation opens here from the Nenu mark in the
// header's top-left corner, so it starts where the finger was instead of rising from the bottom.
interface SideSheetProps {
  open: boolean;
  onClose: () => void;
  /** The dialog's accessible name; shown as the heading unless `heading` replaces it. */
  title: string;
  /** A visible heading in place of the title text (the brand row); the title still names the dialog. */
  heading?: React.ReactNode;
  /** Optional action(s) rendered in the header, to the left of the close (✕) button. */
  headerAction?: React.ReactNode;
  children: React.ReactNode;
  footer?: React.ReactNode;
  className?: string;
}

export function SideSheet({
  open,
  onClose,
  title,
  heading,
  headerAction,
  children,
  footer,
  className,
}: SideSheetProps) {
  const viewportRef = React.useRef<HTMLDivElement>(null);
  const panelRef = React.useRef<HTMLDivElement>(null);
  const [dragX, setDragX] = React.useState(0);
  const dragging = React.useRef(false);
  const titleId = React.useId();
  const { mounted, closing, content } = usePresence(open, { heading, headerAction, children, footer }, viewportRef);
  useDialogFocus(open, panelRef);

  // Backdrop dismiss requires press AND release on the backdrop itself (the Radix
  // outside-pointerdown rule) — NOT just whatever the browser happens to synthesize a `click` on. A
  // long-press that opens this sheet has its finger still down at the moment the sheet mounts; the
  // browser's release click then lands on whatever is now under the finger, which is the backdrop —
  // and without this guard that click would immediately close the sheet it just opened. Arming only
  // on a backdrop `pointerdown` means a click that originated elsewhere (e.g. the pill's release)
  // never dismisses.
  const backdropArmed = React.useRef(false);
  React.useEffect(() => {
    if (open) backdropArmed.current = false;
  }, [open]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Swipe left to dismiss, as a native drawer closes. The gesture engages only once it is clearly
  // horizontal, so a vertical scroll of the list never moves the panel; the move listener is
  // non-passive so an engaged swipe can stop iOS from scrolling underneath it.
  React.useEffect(() => {
    const panel = panelRef.current;
    if (!open || !panel) return;
    setDragX(0);
    const SLOP = 8;
    const CLOSE = 72;
    let start: { x: number; y: number } | null = null;
    let engaged = false;
    let dx = 0;
    const onStart = (e: TouchEvent) => {
      const t = e.touches[0];
      const editing = e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable=true]");
      start = t && !editing ? { x: t.clientX, y: t.clientY } : null;
      engaged = false;
      dx = 0;
    };
    const onMove = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!start || !t) return;
      const x = t.clientX - start.x;
      const y = t.clientY - start.y;
      if (!engaged) {
        if (Math.abs(y) > SLOP && Math.abs(y) >= Math.abs(x)) return void (start = null);
        if (x > -SLOP || Math.abs(x) <= Math.abs(y)) return;
        engaged = true;
        dragging.current = true;
      }
      e.preventDefault();
      dx = Math.min(0, x);
      setDragX(dx);
    };
    const onEnd = () => {
      const shut = engaged && dx < -CLOSE;
      start = null;
      engaged = false;
      dragging.current = false;
      dx = 0;
      if (shut) onClose();
      else setDragX(0);
    };
    panel.addEventListener("touchstart", onStart, { passive: true });
    panel.addEventListener("touchmove", onMove, { passive: false });
    panel.addEventListener("touchend", onEnd);
    panel.addEventListener("touchcancel", onEnd);
    return () => {
      panel.removeEventListener("touchstart", onStart);
      panel.removeEventListener("touchmove", onMove);
      panel.removeEventListener("touchend", onEnd);
      panel.removeEventListener("touchcancel", onEnd);
    };
  }, [open, onClose]);

  if (!mounted) return null;

  return (
    <div
      ref={viewportRef}
      className={cn("sheet-viewport fixed inset-x-0 z-50 flex", closing ? LAYER_MOTION.closing : LAYER_MOTION.open)}
      role="dialog"
      aria-modal="true"
      aria-labelledby={content.heading ? undefined : titleId}
      aria-label={content.heading ? title : undefined}
      inert={closing}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        style={{
          transform: dragX ? `translateX(${dragX}px)` : undefined,
          transition: dragging.current ? "none" : undefined,
        }}
        className={cn(
          "side-sheet-panel relative z-10 flex h-full w-[86%] max-w-sm flex-col outline-none border-r border-border bg-background shadow-2xl duration-180 ease-out motion-reduce:animate-none",
          // A released swipe closes from where the finger left it, out past the left edge.
          closing ? "animate-out slide-out-to-left fill-mode-forwards" : "animate-in slide-in-from-left-4",
          className,
        )}
      >
        <div className="flex shrink-0 items-center gap-1 border-b border-border/60 px-2 pt-[env(safe-area-inset-top)]">
          <div className="flex min-h-13 min-w-0 flex-1 items-center pl-2">
            {content.heading ?? (
              <span id={titleId} className="text-sm font-semibold">
                {title}
              </span>
            )}
          </div>
          {content.headerAction}
          <Button
            variant="ghost"
            size="icon"
            className="size-11"
            onClick={onClose}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </div>
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain">{content.children}</div>
        {content.footer && (
          <div className="shrink-0 border-t border-border/60 px-3 py-2 pb-[calc(env(safe-area-inset-bottom)_+_0.5rem)]">
            {content.footer}
          </div>
        )}
      </div>
      {/* Backdrop: dismisses on tap but hidden from assistive tech — the header ✕ is the accessible
          "Close", so the drawer isn't announced with a giant duplicate close target. Dismiss fires
          only when the pointer went DOWN on the backdrop too — see backdropArmed above. */}
      <button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        className={cn("flex-1 bg-black/50 duration-180 ease-out motion-reduce:animate-none", closing ? BACKDROP_MOTION.closing : BACKDROP_MOTION.open)}
        onPointerDown={() => {
          backdropArmed.current = true;
        }}
        onClick={() => {
          if (!backdropArmed.current) return;
          backdropArmed.current = false;
          onClose();
        }}
      />
    </div>
  );
}
