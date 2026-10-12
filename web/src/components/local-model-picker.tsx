import { useId, useRef, useState, type ReactNode } from "react";
import { Check, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";

interface Props {
  rows: { name: string; description: string }[];
  currentModel?: string;
  disabled?: boolean;
  onApply: (name: string) => Promise<void>;
  onCancel: () => void;
  /** Shown between the list and the actions, so Use model stays the last thing above the edge. */
  more?: ReactNode;
}

// Row presentation adapted from T3 Code ModelListRow.tsx (MIT; THIRD_PARTY_NOTICES.md).
// Choosing a row edits only local state. The parent owns fresh-menu validation and transport.
// The chosen row carries one mark, a trailing check, as an iOS list does; a radio dot beside it said
// the same thing twice. Use model is the cards' one commit (Button's block: 44px on touch, the rows'
// radius and type) across the panel; on a phone, where the picker is a bottom sheet, Cancel gives
// way to the sheet's own close, and the sheet's body is full bleed: the rows' names and Use model
// start on the 16px gutter, where the sheet's title does.
export function LocalModelPicker({ rows, currentModel, disabled, onApply, onCancel, more }: Props) {
  const id = useId();
  const [selection, setSelection] = useState<string | undefined>(() =>
    rows.find((row) => row.name === currentModel)?.name ?? rows[0]?.name,
  );
  const selectionRef = useRef(selection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = rows.find((row) => row.name === selection)
    ?? rows.find((row) => row.name === currentModel)
    ?? rows[0];
  const locked = !!disabled || busy;

  function choose(index: number, focus = false) {
    if (locked || inFlight.current || !rows[index]) return;
    // Apply can follow another click before React commits the selected radio.
    selectionRef.current = rows[index].name;
    setSelection(rows[index].name);
    setError(null);
    if (focus) buttons.current[index]?.focus({ preventScroll: true });
  }

  async function apply() {
    const intended = rows.find((row) => row.name === selectionRef.current) ?? selected;
    if (locked || inFlight.current || !intended) return;
    inFlight.current = true;
    setBusy(true);
    setError(null);
    try {
      await onApply(intended.name);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not apply this model. Try again.");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="local-model-picker min-w-0 text-popover-foreground" aria-busy={busy}>
      <div role="radiogroup" aria-label="Available models" className="max-h-[min(24rem,45dvh)] overflow-y-auto overscroll-contain p-1.5 max-lg:px-1">
        {rows.map((row, index) => (
          <button
            key={row.name}
            ref={(node) => { buttons.current[index] = node; }}
            type="button"
            role="radio"
            aria-checked={selected?.name === row.name}
            aria-label={row.name}
            aria-describedby={row.description ? `${id}-description-${index}` : undefined}
            tabIndex={selected?.name === row.name ? 0 : -1}
            disabled={locked}
            onClick={() => choose(index)}
            onKeyDown={(event) => {
              let next: number;
              if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % rows.length;
              else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (index + rows.length - 1) % rows.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = rows.length - 1;
              else return;
              event.preventDefault();
              choose(next, true);
            }}
            className="group relative flex min-h-11 w-full min-w-0 items-center gap-3 rounded-lg px-3 py-2.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:text-disabled-foreground"
          >
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-body font-medium">{row.name}</span>
                {row.name === currentModel && <span className="shrink-0 rounded-sm border border-border px-1.5 text-micro text-muted-foreground">Current</span>}
              </span>
              {row.description && <span id={`${id}-description-${index}`} className="mt-0.5 block text-footnote text-muted-foreground">{row.description}</span>}
            </span>
            {selected?.name === row.name && <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />}
          </button>
        ))}
        {rows.length === 0 && <p className="px-3 py-3 text-footnote text-muted-foreground">No models available yet.</p>}
      </div>
      {error && <p role="alert" className="px-4 pb-3 text-footnote text-destructive [overflow-wrap:anywhere]">{error}</p>}
      {more}
      <div className="flex items-center gap-2 border-t border-border px-3 py-2 max-lg:px-4 max-lg:pt-3">
        <Button type="button" variant="ghost" onClick={onCancel} className="text-muted-foreground max-lg:hidden">Cancel</Button>
        <Button
          type="button"
          size="block"
          disabled={locked || !selected}
          aria-busy={busy || undefined}
          onClick={() => void apply()}
          className="flex-1"
        >
          {busy && <Loader2 aria-hidden="true" className="size-4 animate-spin motion-reduce:animate-none" />}
          {busy ? "Applying…" : "Use model"}
        </Button>
      </div>
    </div>
  );
}
