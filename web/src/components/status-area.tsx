import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type Ref } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router";
import { CircleAlert, TriangleAlert, CircleCheck, Info, X } from "@/components/ui/icon";

import { cn } from "@/lib/utils";
import { clearStatus, pauseStatus, resumeStatus, useStatus, type StatusMessage, type StatusTone } from "@/lib/status";

const TONE: Record<StatusTone, string> = {
  info: "text-muted-foreground",
  success: "text-status-done",
  warn: "text-status-working",
  error: "text-status-blocked",
};
const ICONS = { info: Info, success: CircleCheck, warn: TriangleAlert, error: CircleAlert } as const;

/** A dismissed toast stays drawn this long while it fades and drifts 8px back up. */
export const TOAST_EXIT_MS = 150;
/** Under reduced motion the exit is an opacity fade only, and shorter. */
export const TOAST_EXIT_REDUCED_MS = 120;
/** An upward drag past this dismisses; anything shorter springs back. */
const SWIPE_DISMISS_PX = 24;
/** Below this a press is still a tap, so the toast's own link keeps working. */
const DRAG_SLOP_PX = 6;

const reducedMotion = () => typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * One app-wide, nonmodal notification surface. On a phone it drops in over the header, under the
 * status bar, so it never covers the transcript or the card it is reporting on. On a desk it sits
 * top-right under the 52px header: bottom-right measured on top of the composer's Send and model
 * row, and an error stays until dismissed. A swipe up or its ✕ dismisses it, and a notice with a
 * destination is a control that opens it.
 */
export function StatusArea() {
  const status = useStatus();
  // The notice on screen. It outlives its message by the exit, so a dismissal fades rather than cuts.
  const [shown, setShown] = useState(status);
  if (status && status !== shown) setShown(status);
  const leaving = !status && shown !== null;
  useEffect(() => {
    if (!leaving) return;
    const timer = setTimeout(() => setShown(null), reducedMotion() ? TOAST_EXIT_REDUCED_MS : TOAST_EXIT_MS);
    return () => clearTimeout(timer);
  }, [leaving]);

  const card = useRef<HTMLDivElement>(null);
  const hovered = useRef(false);
  const focused = useRef(false);
  useEffect(() => {
    hovered.current = card.current?.matches(":hover") ?? false;
    focused.current = card.current?.contains(document.activeElement) ?? false;
    if (!status) return;
    const sync = () => {
      if (document.hidden || hovered.current || focused.current) pauseStatus(status.id);
      else resumeStatus(status.id);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => document.removeEventListener("visibilitychange", sync);
  }, [status]);

  const syncInteraction = () => {
    if (!status) return;
    if (document.hidden || hovered.current || focused.current) pauseStatus(status.id);
    else resumeStatus(status.id);
  };
  return createPortal(
    <section aria-label="Notifications" data-notification-viewport=""
      className="pointer-events-none fixed inset-x-0 top-[calc(var(--app-viewport-top,0px)+env(safe-area-inset-top,0px)+0.5rem)] z-50 flex justify-center px-2 lg:top-[calc(var(--app-viewport-top,0px)+env(safe-area-inset-top,0px)+4rem)] lg:justify-end lg:px-6">
      {shown && <Toast key={shown.id} ref={card} message={shown} leaving={leaving}
        onHover={(on) => { hovered.current = on; syncInteraction(); }}
        onFocusChange={(on) => { focused.current = on; syncInteraction(); }} />}
    </section>, document.body,
  );
}

function Toast({ message, leaving, ref, onHover, onFocusChange }: {
  message: StatusMessage;
  leaving: boolean;
  ref: Ref<HTMLDivElement>;
  onHover: (on: boolean) => void;
  onFocusChange: (on: boolean) => void;
}) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const start = useRef<{ id: number; y: number } | null>(null);
  // The release reads the last move, which may not have rendered yet.
  const lastOffset = useRef(0);
  const dragged = useRef(false);
  const Icon = ICONS[message.tone];
  const textBox = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  useLayoutEffect(() => {
    const el = textBox.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Touch only: a mouse drag over the text is a selection, and the desk has Dismiss and the timer.
  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" || leaving) return;
    start.current = { id: event.pointerId, y: event.clientY };
    dragged.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current?.id !== event.pointerId) return;
    const dy = event.clientY - start.current.y;
    if (!dragged.current && Math.abs(dy) < DRAG_SLOP_PX) return;
    dragged.current = true;
    setDragging(true);
    // Up follows the finger; down resists, since there is nowhere to go but onto the content.
    lastOffset.current = dy < 0 ? dy : dy / (1 + dy / 40);
    setOffset(lastOffset.current);
  };
  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (start.current?.id !== event.pointerId) return;
    start.current = null;
    setDragging(false);
    if (lastOffset.current < -SWIPE_DISMISS_PX) clearStatus(message.id);
    else { lastOffset.current = 0; setOffset(0); }
  };

  // A scroller is where the browser decides a touch is its pan, so the card's own touch-none stops at
  // it. Text that fits takes touch-none too, so a swipe that starts on it dismisses. Text that
  // overflows (a long raw error, which never times out) keeps the finger's scroll, and the swipe is
  // taken from the icon and the card's edges.
  const text = <div ref={textBox} className={cn("max-h-[min(16rem,40dvh)] min-w-0 flex-1 overflow-y-auto overscroll-contain [overflow-wrap:anywhere]", overflows ? "touch-pan-y" : "touch-none")}>
    <p className="whitespace-pre-wrap text-subhead font-semibold">{message.text}</p>
    {message.description && <p className="mt-0.5 whitespace-pre-wrap text-footnote text-muted-foreground">{message.description}</p>}
  </div>;
  const icon = <Icon aria-hidden="true" className={cn("mt-0.5 size-4 shrink-0", TONE[message.tone])} />;

  return (
    <div ref={ref} role={message.tone === "error" ? "alert" : "status"} aria-atomic="true"
      data-leaving={leaving ? "" : undefined} inert={leaving}
      onMouseEnter={() => onHover(true)}
      onMouseLeave={() => onHover(false)}
      onFocus={() => onFocusChange(true)}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) onFocusChange(false); }}
      onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerEnd} onPointerCancel={onPointerEnd}
      onClickCapture={(event) => {
        if (!dragged.current) return;
        dragged.current = false;
        event.preventDefault();
        event.stopPropagation();
      }}
      style={offset ? { translate: `0 ${leaving ? offset - 8 : offset}px`, transitionDuration: dragging ? "0ms" : undefined } : undefined}
      className={cn(
        "pointer-events-auto relative w-full max-w-[22.375rem] touch-none rounded-xl border border-border bg-popover text-popover-foreground shadow-(--shadow-float) lg:w-90 lg:max-w-none",
        "animate-in fade-in duration-120 ease-out motion-safe:slide-in-from-top-2 motion-reduce:duration-120",
        "transition-[opacity,translate] data-leaving:opacity-0 motion-safe:data-leaving:-translate-y-2",
      )}>
      {message.to ? (
        <Link to={message.to} onClick={() => clearStatus(message.id)}
          className="flex min-h-13 items-start gap-3 rounded-xl py-3.5 pl-4 pr-12">
          {icon}{text}
        </Link>
      ) : (
        <div className="flex min-h-13 items-start gap-3 py-3.5 pl-4 pr-12">{icon}{text}</div>
      )}
      {/* Every notice closes where it sits, one that opens a chat included. */}
      <button type="button" aria-label="Dismiss notification" onClick={() => clearStatus(message.id)}
        className="absolute right-1 top-1 flex size-11 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:text-foreground">
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
