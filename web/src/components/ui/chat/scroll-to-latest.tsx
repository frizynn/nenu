import { ArrowDown } from "@/components/ui/icon";

import { cn } from "@/lib/utils";

interface ScrollToLatestProps {
  onClick: () => void;
  /** A question waits at the tail: the way back says so. */
  waiting?: boolean;
  /** Messages that arrived below while the reader was away; null when too many to count. */
  count?: number | null;
  /** Something below changed with no message to count (a turn ended, output moved): a dot. */
  changed?: boolean;
  /** The quiet circle sits at the row's end, as in Messages; centred otherwise. A pill is always centred. */
  corner?: boolean;
}

// The way back to the live tail, floating over the list (a floating layer, so it takes the float
// shadow), drawn in its own row so the caller only places the row. With nothing new it is a quiet
// circle, 44 px on touch and 36 with a mouse. New messages fill it with ink, the primary action's
// pair (white on the blue accent misses AA in dark), and say how many; a question at the tail names
// itself, its dot the one red. Changing shape remounts it, so it enters again where it lands
// instead of jumping across the column.
export function ScrollToLatest({ onClick, waiting = false, count = 0, changed = false, corner = false }: ScrollToLatestProps) {
  const pill = waiting || count === null || count > 0;
  const fresh = pill && !waiting;
  return (
    <div className={cn("pointer-events-none flex", corner && !pill ? "justify-end" : "justify-center")}>
      <button key={pill ? "pill" : "circle"} type="button" onClick={onClick} aria-label={pill ? undefined : changed ? "Scroll to latest, updated" : "Scroll to latest"}
        className={cn(
          "pointer-events-auto relative flex h-9 shrink-0 items-center justify-center rounded-full shadow-(--shadow-float) transition-[scale,background-color] duration-120 ease-out active:scale-[0.97] animate-in fade-in slide-in-from-bottom-1 coarse:h-11 motion-reduce:animate-none motion-reduce:transition-none",
          pill ? "gap-1.5 px-4 text-footnote font-medium" : "w-9 coarse:w-11",
          fresh ? "bg-foreground text-background hover:bg-foreground/90" : "border bg-popover text-popover-foreground hover:bg-hover",
        )}>
        {pill && <><span className="sr-only">Scroll to latest,</span>{" "}</>}
        {waiting
          ? <><span aria-hidden className="size-2 rounded-full bg-status-blocked" />Waiting on you<ArrowDown aria-hidden="true" className="size-4" /></>
          : fresh
            ? <>{count === null ? "New messages" : `${count} new`}<ArrowDown aria-hidden="true" className="size-4" /></>
            : <>
              <ArrowDown aria-hidden="true" className="size-4 coarse:size-5" />
              {changed && <span aria-hidden className="absolute right-0 top-0 size-2.5 rounded-full bg-primary ring-2 ring-background" />}
            </>}
      </button>
    </div>
  );
}
