import { cn } from "@/lib/utils";
import { useLongPress } from "@/hooks/use-long-press";
import { StatusDot } from "@/components/status-badge";
import { TRIAGE_STATUS, type TriageKey } from "@/lib/triage";
import { STATUS_LABEL } from "@/lib/types";

interface ChipProps {
  label: string;
  /** Flat tabs inside a conversation; overview chips retain their filled treatment. */
  quiet?: boolean;
  active: boolean;
  /** Subtle ring marking the item focused in the desktop TUI. */
  ring?: boolean;
  /**
   * The most urgent thing happening inside this space/tab ({@link worstTriage}) — drawn as a leading
   * dot in the same palette the herd list uses, so a chip and a row can't mean different things by
   * the same colour. Omit (or pass null) when the container holds no agent at all: that's not the
   * same as idle, and a resting dot would claim otherwise.
   */
  status?: TriageKey | null;
  onClick: () => void;
  /**
   * Long-press (or right-click / Android contextmenu) opens actions for this chip — e.g. the tab
   * rename sheet. Inert when unset (the space strip's chips don't wire it), so the handlers are safe
   * to spread unconditionally.
   */
  onLongPress?: () => void;
  /**
   * A plain tap when the chip is already `active` — opens actions instead of a no-op re-select,
   * mirroring the pane pill. Only meaningful alongside {@link onLongPress}.
   */
  onTapActive?: () => void;
}

// Pill button shared by the space and tab strips: active fill, an optional desktop-focus ring, and
// a leading status dot saying what's going on inside. Tab chips additionally wire a long-press to
// open their rename sheet (space chips leave it unset — the handlers stay inert).
//
// The dot leads the label rather than riding the corner as a badge: a corner badge needs a ring in
// the chip's own fill, and the chip has two fills (active/inactive). Inline, it just works, and it
// matches how the space rows and section headings already read.
export function Chip({ quiet = false, label, active, ring, status, onClick, onLongPress, onTapActive }: ChipProps) {
  const longPress = useLongPress(onLongPress);

  // A long-press already suppresses the ensuing click (via longPress.onClickCapture), so this only
  // ever sees a genuine tap. Tapping the already-active chip opens actions (when wired) rather than a
  // dead re-select.
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
      className={cn(
        // select-none + -webkit-touch-callout:none stop iOS Safari's selection loupe / touch callout,
        // whose native long-press gesture otherwise fires pointercancel and kills the hold timer.
        "relative flex shrink-0 select-none items-center gap-1 [-webkit-touch-callout:none] whitespace-nowrap rounded-full px-2 py-1 text-xs font-medium transition-colors active:scale-95 sm:gap-1.5 sm:px-3 sm:py-1.5 sm:text-sm",
        quiet
          ? "min-h-11 min-w-11 rounded-none border-b-2 border-transparent bg-transparent text-muted-foreground hover:text-foreground"
          : active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-muted/70",
        quiet && active && "border-primary text-foreground",
        quiet && ring && !active && "border-dashed border-muted-foreground/40",
        !quiet && ring && !active && "ring-1 ring-inset ring-primary/40",
      )}
    >
      {status && (
        <>
          {/* A hollow resting dot is filled with the chip's own fill, which differs when active. */}
          <StatusDot
            status={TRIAGE_STATUS[status]}
            surface={quiet ? "bg-background" : active ? "bg-primary" : "bg-muted"}
            className="size-2"
          />
          {/* The dot is colour-only; say it in words for screen readers. */}
          <span className="sr-only">{STATUS_LABEL[TRIAGE_STATUS[status]]}</span>
        </>
      )}
      {label}
    </button>
  );
}
