import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { ArrowUpDown, Check, ChevronDown } from "@/components/ui/icon";
import { usePresence } from "@/components/ui/presence";
import { cn } from "@/lib/utils";
import { ORDER_LABEL, type WorkspaceOrder, type WorkspaceOrderMode } from "@/lib/workspace-order";

const MODES = Object.keys(ORDER_LABEL) as WorkspaceOrderMode[];

/**
 * How Home's workspaces are sorted: a quiet button that names the order on screen and opens a short
 * menu of the orders to choose from. Custom is listed once the operator has dragged one; dragging is
 * Reorder's, beside it, never a row of this menu. The menu grows from its button and fades back to
 * it (180 ms in, 120 ms out), and closes on a choice, Escape, a press outside or the focus leaving it.
 */
export function WorkspaceOrderMenu({ order, onChoose, className }: {
  order: WorkspaceOrder;
  onChoose: (mode: WorkspaceOrderMode) => void;
  className?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const items = useRef<Array<HTMLButtonElement | null>>([]);
  const { mounted, closing } = usePresence(open, null, layer);
  const modes = MODES.filter((mode) => mode !== "custom" || order.mode === "custom" || order.custom.length > 0);
  const checked = Math.max(0, modes.indexOf(order.mode));
  const label = ORDER_LABEL[order.mode];

  useEffect(() => {
    if (!open) return;
    // Into the menu, as a menu button does; a finger's tap draws no ring for it.
    items.current[checked]?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (layer.current?.contains(target) || trigger.current?.contains(target))) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
    // Focus moves in once per opening, not again when the order it shows changes under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Back to the button before the closing layer goes inert, or Safari drops the focus on the page.
  const close = () => {
    trigger.current?.focus({ preventScroll: true });
    setOpen(false);
  };
  const focusItem = (index: number) => items.current[(index + modes.length) % modes.length]?.focus({ preventScroll: true });
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    // Tab leaves from the button, so it lands on the control after it.
    if (event.key === "Tab") return close();
    const index = items.current.findIndex((item) => item === document.activeElement);
    if (event.key === "ArrowDown") focusItem(index + 1);
    else if (event.key === "ArrowUp") focusItem(index - 1);
    else if (event.key === "Home") focusItem(0);
    else if (event.key === "End") focusItem(modes.length - 1);
    else if (event.key === "Escape") close();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className={cn("relative shrink-0", className)}>
      <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-label={`Order: ${label}`} onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(event) => { if (event.key === "ArrowDown" && !open) { event.preventDefault(); setOpen(true); } }}
        className="quiet-action">
        <ArrowUpDown aria-hidden className="size-3.5 shrink-0" />
        <span className="whitespace-nowrap">{label}</span>
        <ChevronDown aria-hidden className="-ml-0.5 size-3 shrink-0" />
      </button>
      {mounted && (
        <div ref={layer} id={id} role="menu" aria-label="Order" inert={closing} onKeyDown={onMenuKey}
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (next instanceof Node && !layer.current?.contains(next) && !trigger.current?.contains(next)) setOpen(false);
          }}
          className={cn("absolute left-0 top-full z-30 mt-1.5 w-48 origin-top-left rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg ease-out",
            closing
              ? "animate-out fade-out zoom-out-95 fill-mode-forwards duration-120 motion-reduce:zoom-out-100"
              : "animate-in fade-in zoom-in-95 duration-180 motion-reduce:zoom-in-100")}>
          {modes.map((mode, index) => (
            <button key={mode} ref={(node) => { items.current[index] = node; }} type="button" role="menuitemradio"
              aria-checked={mode === order.mode} tabIndex={index === checked ? 0 : -1}
              onClick={() => { onChoose(mode); close(); }}
              className="flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-subhead outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-11">
              <Check aria-hidden className={cn("size-4 shrink-0 text-foreground", mode !== order.mode && "invisible")} />
              <span className="min-w-0 flex-1 truncate">{ORDER_LABEL[mode]}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
