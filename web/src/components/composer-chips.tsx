import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode, type RefObject } from "react";
import { ArrowLeft, Laptop, X, type IconComponent } from "@/components/ui/icon";

import { StateMark } from "@/components/status-badge";
import { usePresence } from "@/components/ui/presence";
import { WorkbenchPopover } from "@/components/ui/workbench-popover";
import { useBackCloses } from "@/hooks/use-back-closes";
import { useMediaQuery } from "@/hooks/use-media-query";
import { cn } from "@/lib/utils";

// The chips under the composer's box (issue: Cursor-style chips): what needs you and what works in
// this chat's background, one chip each in the row the model sits in, and the chip's panel floating
// over the thread. Only what asks for you or runs is a chip; finished work opens from the ⋯ menu, and
// no line of their own ever sits between the thread and the box (ADR 0108).
// Every mark is still: a working state is a dot, never a spinner, so an idle page draws nothing.

export type ChipId = "needs" | "working";

export interface ChipView {
  id: ChipId;
  label: string;
  /** Shown beside the label when above zero. */
  count: number;
  mark?: ReactNode;
  /** Asks nothing of you (finished work): off the line, its panel opened from the ⋯ menu. */
  tucked?: boolean;
  /** The ⋯ menu row's icon, for a chip that can be tucked. */
  icon?: IconComponent;
  content: ReactNode;
}

/** The chips drawn in the row: every one but those tucked into the ⋯ menu. */
export const rowChips = (chips: readonly ChipView[]) => chips.filter((chip) => !chip.tucked);

export const NEEDS_MARK = <StateMark state="needs" />;
export const WORKING_MARK = <StateMark state="working" />;

/** The chips a chat hands its composer, which one is open, and on a phone a process's details. */
export interface ChipLine {
  chips: readonly ChipView[];
  open: ChipId | null;
  onOpenChange: (id: ChipId | null) => void;
  detail?: { title: string; content: ReactNode; onBack: () => void } | null;
  /** Where focus goes when a panel closes with no chip in the row to take it (the ⋯ trigger). */
  returnFocus?: RefObject<HTMLElement | null>;
}

/** A press that belongs to something the panel opened, such as a confirmation or a diff over the page. */
const inLayerAbove = (target: Element) => target.closest('[role="dialog"], [role="alertdialog"], [data-workbench-popover]') !== null;

const FOCUSABLE = 'button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * The live chips, in the row under the box, and the open chip's panel floating over the thread from
 * the box's top edge (a tucked chip's panel, opened from the ⋯ menu, floats from the same place). The
 * panel belongs to the composer, not to the row, so a chip leaving the row keeps it as it was, and it
 * takes no height, so opening it moves neither the box nor the conversation. One panel at a time; the chip toggles it, and
 * ✕, Escape, a press outside it or, on a phone, Back close it. While open, Tab stays inside it, and
 * closing gives focus back to the chip, or to `returnFocus` when the chip is off the row. On a phone a process's details take the panel's place, named
 * by its header, with Back.
 */
export function ComposerChips({ chips, open, onOpenChange, detail, returnFocus }: ChipLine) {
  const buttons = useRef(new Map<ChipId, HTMLButtonElement>());
  const line = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLElement>(null);
  const shown = chips.find((chip) => chip.id === open);
  const phoneBack = useMediaQuery("(pointer: coarse)");
  // A phone's Back closes the panel. Closed by a row that opens another page, its entry stays:
  // stepping back then would race the navigation the row just started.
  const leaveEntry = useBackCloses("nenuChipPanel", Boolean(shown), phoneBack, () => closeRef.current("back"));
  // How the panel closes says what follows. Its own ✕, Escape or chip steps back over the entry it
  // pushed, so Back afterwards leaves the chat, and hands focus to the chip; a press outside leaves
  // both alone, since it may be starting a navigation or placing a caret; Back has already stepped.
  const closeRef = useRef<(how: "own" | "outside" | "back") => void>(() => {});
  closeRef.current = (how) => {
    if (!shown) return;
    if (how === "own") leaveEntry();
    onOpenChange(null);
    if (how === "outside") return;
    // A tucked chip has no button, and one whose work just ended has left the row.
    (buttons.current.get(shown.id) ?? returnFocus?.current)?.focus({ preventScroll: true });
  };

  // The panel opens with focus inside it, where the keyboard stays until it closes.
  useEffect(() => {
    if (!shown) return;
    panel.current?.focus({ preventScroll: true });
  }, [shown?.id]);

  useEffect(() => {
    if (!shown) return;
    const onPointer = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || line.current?.contains(target) || inLayerAbove(target)) return;
      closeRef.current("outside");
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || event.defaultPrevented) return;
      if (event.target instanceof Element && !line.current?.contains(event.target) && inLayerAbove(event.target)) return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current("own");
    };
    document.addEventListener("pointerdown", onPointer, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [Boolean(shown)]);

  const row = rowChips(chips);
  const close = () => closeRef.current("own");
  const trap = (event: ReactKeyboardEvent<HTMLElement>) => {
    if (event.key !== "Tab" || !panel.current) return;
    const stops = Array.from(panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest("[inert]"));
    if (stops.length === 0) { event.preventDefault(); return; }
    const first = stops[0]!;
    const last = stops[stops.length - 1]!;
    const active = document.activeElement;
    if (event.shiftKey && (active === first || active === panel.current)) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && active === last) { event.preventDefault(); first.focus(); }
  };
  // A closed panel stays drawn, out of reach, with what it last showed while it fades back the way it
  // came, in a control's length as every exit; under reduced motion it goes at once.
  const { mounted, closing, content } = usePresence(Boolean(shown), detail
    ? { title: detail.title, body: detail.content, back: detail.onBack }
    : { title: shown?.label, body: shown?.content, back: undefined }, panel);
  const { title, body, back } = content;
  return (
    <div ref={line} className="composer-chips">
      {mounted && (
        <section ref={panel} id="composer-chip-panel" role="dialog" aria-label={title} tabIndex={-1}
          className={cn("composer-chip-panel", closing && "animate-out fill-mode-forwards duration-120 ease-out fade-out zoom-out-98 slide-out-to-bottom-[6px] motion-reduce:animate-none")}
          data-leaving={closing ? "" : undefined} inert={closing || undefined} onKeyDown={trap}>
          <div className="composer-chip-panel-head">
            {back && <button type="button" aria-label="Back" onClick={back} className="composer-chip-icon"><ArrowLeft aria-hidden className="size-4" /></button>}
            <h2 className="min-w-0 flex-1 truncate">{title}</h2>
            <button type="button" aria-label="Close" onClick={close} className="composer-chip-icon"><X aria-hidden className="size-3.5" /></button>
          </div>
          <div className="composer-chip-panel-body">{body}</div>
        </section>
      )}
      {row.length > 0 && <div role="group" aria-label="Status" className="composer-chip-row">
        {row.map((chip) => (
          <button key={chip.id} ref={(node) => { if (node) buttons.current.set(chip.id, node); else buttons.current.delete(chip.id); }}
            type="button" className="composer-chip" data-chip={chip.id}
            aria-label={chip.count > 0 ? `${chip.label}, ${chip.count}` : chip.label}
            aria-expanded={chip.id === open} aria-haspopup="dialog" aria-controls={chip.id === open ? "composer-chip-panel" : undefined}
            onClick={() => (chip.id === open ? close() : onOpenChange(chip.id))}>
            {chip.mark}
            <span className="composer-chip-label">{chip.label}</span>
            {chip.count > 0 && <span className="composer-chip-count">{chip.count}</span>}
          </button>
        ))}
      </div>}
    </div>
  );
}

/** The machine Nenu reaches Herdr on, as the browser names it: a bare address whole, a host's first label. */
export function machineName(hostname = window.location.hostname): string {
  return /^[\d.]+$|:/.test(hostname) ? hostname : hostname.split(".")[0] || "local";
}

/**
 * Under the box: the machine the chat runs on (Herdr's name for it, with more than one). A wide box
 * says it, truncating it when the row is full. A narrow one (a phone: composer.css reads the box's own
 * width) gives the row to the model and the chips, and keeps it behind one tap, so it is never cut to
 * nothing.
 */
export function ComposerPlace({ machine }: { machine?: string }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const host = machine ?? machineName();
  return (
    <span className="composer-place">
      <span className="composer-place-whole">
        <span className="composer-place-item" title={host}><Laptop aria-hidden className="size-3.5 shrink-0" /><span className="truncate">{host}</span></span>
      </span>
      <span className="composer-place-tap">
        <button ref={anchor} type="button" className="composer-quiet hit-area gap-1.5" aria-label={`Where this runs: ${host}`} aria-haspopup="dialog" aria-expanded={open}
          onClick={() => setOpen(!open)}>
          <Laptop aria-hidden className="size-3.5 shrink-0" />
        </button>
        <WorkbenchPopover open={open} onDismiss={() => setOpen(false)} anchorRef={anchor} label="Where this runs">
          <dl className="composer-place-detail">
            <dt>Machine</dt><dd>{host}</dd>
          </dl>
        </WorkbenchPopover>
      </span>
    </span>
  );
}
