import { useId, useRef, useState, type ReactNode } from "react";
import { Check, Pending } from "@/components/ui/icon";

interface Props {
  rows: { name: string; description: string }[];
  /** The row of the model that runs now, when the agent says which. */
  currentModel?: string;
  /** What the agent calls that model (its version), said under its row instead of the description. */
  currentLabel?: string;
  disabled?: boolean;
  onApply: (name: string) => Promise<void>;
  /** Tapping the model that already runs just closes the picker… */
  onClose: () => void;
  /** …unless the agent's own picker is open: there the tap confirms it, and with it the effort the
   *  picker's arrows moved, which closing would discard. */
  currentApplies?: boolean;
  /** Under the list: the effort row and the way to the agent's own settings. */
  more?: ReactNode;
}

// Row presentation adapted from T3 Code ModelListRow.tsx (MIT; THIRD_PARTY_NOTICES.md).
// One tap is the whole choice, as in a phone's own menus: a row applies its model and the parent
// closes the picker once the agent took it. A failure stays here, said under the list, with every row
// live again to retry. The parent owns fresh-menu validation and transport. The model that runs is
// the one row with a check; while a row applies, its spinner stands where the check would.
export function LocalModelPicker({ rows, currentModel, currentLabel, disabled, onApply, onClose, currentApplies = false, more }: Props) {
  const id = useId();
  const [applying, setApplying] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const locked = !!disabled || applying !== null;
  const current = rows.find((row) => row.name === currentModel)?.name;

  async function choose(name: string) {
    if (locked || inFlight.current) return;
    if (name === current && !currentApplies) {
      onClose();
      return;
    }
    inFlight.current = true;
    setApplying(name);
    setError(null);
    try {
      await onApply(name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not apply this model. Try again.");
    } finally {
      inFlight.current = false;
      setApplying(null);
    }
  }

  // Arrows only move focus: in a menu that applies on activation, a selection that followed focus
  // would change the model on every keypress.
  function focusRow(index: number) {
    buttons.current[(index + rows.length) % rows.length]?.focus({ preventScroll: true });
  }

  return (
    <div className="local-model-picker min-w-0 text-popover-foreground" aria-busy={applying !== null}>
      <div role="menu" aria-label="Available models" className="p-1.5 max-lg:px-1">
        {rows.map((row, index) => {
          const detail = row.name === current && currentLabel && currentLabel !== row.name ? currentLabel : row.description;
          return (
            <button
              key={row.name}
              ref={(node) => { buttons.current[index] = node; }}
              type="button"
              role="menuitemradio"
              aria-checked={row.name === current}
              aria-label={row.name}
              aria-describedby={detail ? `${id}-detail-${index}` : undefined}
              tabIndex={(current ? row.name === current : index === 0) ? 0 : -1}
              disabled={locked}
              onClick={() => void choose(row.name)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") focusRow(index + 1);
                else if (event.key === "ArrowUp") focusRow(index - 1);
                else if (event.key === "Home") focusRow(0);
                else if (event.key === "End") focusRow(rows.length - 1);
                else return;
                event.preventDefault();
              }}
              className="group relative flex min-h-11 w-full min-w-0 touch-manipulation items-center gap-3 rounded-lg px-3 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring active:bg-accent disabled:text-disabled-foreground"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-body font-medium">{row.name}</span>
                {detail && <span id={`${id}-detail-${index}`} className="block truncate text-footnote text-muted-foreground">{detail}</span>}
              </span>
              {applying === row.name
                ? <Pending aria-label="Applying" className="size-4 shrink-0" />
                : row.name === current && <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />}
            </button>
          );
        })}
        {rows.length === 0 && <p className="px-3 py-3 text-footnote text-muted-foreground">No models available yet.</p>}
      </div>
      {error && <p role="alert" className="px-4 pb-3 text-footnote text-destructive [overflow-wrap:anywhere]">{error}</p>}
      {more}
    </div>
  );
}
