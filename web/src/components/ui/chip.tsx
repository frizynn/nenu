import { cn } from "@/lib/utils";
import { useLongPress } from "@/hooks/use-long-press";
import { StatusDot } from "@/components/status-badge";
import { TRIAGE_STATUS, type TriageKey } from "@/lib/triage";
import { STATUS_LABEL } from "@/lib/types";

interface ChipProps {
  label: string;
  active: boolean;
  /** Subtle ring marking the item focused in the desktop TUI. */
  ring?: boolean;
  /**
   * The most urgent thing happening inside this tab ({@link worstTriage}) — drawn as a leading
   * dot in the same palette as the pane rows, so a chip and a row can't mean different things by
   * the same colour. Omit (or pass null) when the container holds no agent at all: that's not the
   * same as idle, and a resting dot would claim otherwise.
   */
  status?: TriageKey | null;
  onClick: () => void;
  /**
   * Long-press (or right-click / Android contextmenu) opens actions for this chip — the tab's
   * rename/close sheet. Inert when unset, so the handlers are safe to spread unconditionally.
   */
  onLongPress?: () => void;
  /**
   * A plain tap when the chip is already `active` — opens actions instead of a no-op re-select,
   * mirroring the pane pill. Only meaningful alongside {@link onLongPress}.
   */
  onTapActive?: () => void;
}

// A tab in a quiet underline row, shared by a pane's tab bar and the workspace page: the active tab
// underlined, a dashed underline for the tab focused in the desktop TUI, and a leading status dot
// saying what's going on inside. A long-press opens the tab's actions when the parent wires them.
export function Chip({ label, active, ring, status, onClick, onLongPress, onTapActive }: ChipProps) {
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
        // A slim 36px underline row: the ::after reaches 8px (past the 2px underline) into the row's
        // bottom padding, so a thumb still gets a 44px target.
        "relative flex h-9 min-w-11 shrink-0 select-none items-center justify-center gap-1 whitespace-nowrap rounded-none border-b-2 border-transparent bg-transparent px-2.5 py-1 text-[13px] font-medium text-muted-foreground transition-colors [-webkit-touch-callout:none] after:absolute after:inset-x-0 after:top-0 after:-bottom-2.5 after:content-[''] hover:text-foreground sm:gap-1.5",
        active && "border-primary text-foreground",
        ring && !active && "border-dashed border-muted-foreground/40",
      )}
    >
      {status && (
        <>
          <StatusDot status={TRIAGE_STATUS[status]} className="size-2" />
          {/* The dot is colour-only; say it in words for screen readers. */}
          <span className="sr-only">{STATUS_LABEL[TRIAGE_STATUS[status]]}</span>
        </>
      )}
      {label}
    </button>
  );
}
