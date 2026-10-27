import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

import { ChevronDown, type IconComponent } from "@/components/ui/icon";
import { usePresence } from "@/components/ui/presence";
import { cn } from "@/lib/utils";

/** A menu's row: a check where it is chosen, then its words, and anything after them at the end. */
export const quietMenuItem = "flex min-h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-subhead outline-none hover:bg-hover focus-visible:bg-hover focus-visible:ring-2 focus-visible:ring-ring coarse:min-h-11";

const ITEMS = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

/**
 * A quiet button that names what is chosen and opens a short menu under it. The menu grows from its
 * button and fades back to it (180 ms in, 120 ms out); it closes on Escape, a press outside, the focus
 * leaving it, or a row that calls `close`. Opening moves the focus to the menu's search field when it
 * has one (`data-autofocus`) and a fine pointer opened it (a finger gets no keyboard unasked), else
 * the chosen row, else the first; the arrows, Home and End walk the rows, and Up from the first row
 * returns to the search field.
 */
export function QuietMenu({ icon: Icon, label, ariaLabel, menuLabel, align = "start", className, menuClassName, disabled, children }: {
  icon: IconComponent;
  label: ReactNode;
  ariaLabel: string;
  menuLabel: string;
  align?: "start" | "end";
  className?: string;
  menuClassName?: string;
  disabled?: boolean;
  children: (close: () => void) => ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const layer = useRef<HTMLDivElement>(null);
  const { mounted, closing } = usePresence(open, null, layer);
  const items = () => [...(layer.current?.querySelectorAll<HTMLElement>(ITEMS) ?? [])];

  useEffect(() => {
    if (!open) return;
    // Into the menu, as a menu button does; a finger's tap draws no ring for it.
    const rows = items();
    const fine = typeof window.matchMedia === "function" && window.matchMedia("(pointer: fine)").matches;
    const search = fine ? layer.current?.querySelector<HTMLElement>("[data-autofocus]") : null;
    (search ?? rows.find((row) => row.getAttribute("aria-checked") === "true") ?? rows[0])?.focus({ preventScroll: true });
    const outside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (layer.current?.contains(target) || trigger.current?.contains(target))) return;
      setOpen(false);
    };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [open]);

  // Back to the button before the closing layer goes inert, or Safari drops the focus on the page.
  const close = () => {
    trigger.current?.focus({ preventScroll: true });
    setOpen(false);
  };
  const onMenuKey = (event: KeyboardEvent<HTMLDivElement>) => {
    // Tab leaves from the button, so it lands on the control after it; Shift+Tab stops on the button.
    if (event.key === "Tab") {
      close();
      if (event.shiftKey) event.preventDefault();
      return;
    }
    const rows = items();
    const index = rows.findIndex((row) => row === document.activeElement);
    const focus = (at: number) => rows[(at + rows.length) % rows.length]?.focus({ preventScroll: true });
    // Home and End move the caret while the search field has the focus.
    const typing = event.target instanceof HTMLInputElement;
    const search = layer.current?.querySelector<HTMLElement>("[data-autofocus]");
    if (event.key === "ArrowDown") focus(index + 1);
    else if (event.key === "ArrowUp" && index === 0 && search) search.focus({ preventScroll: true });
    // From the search field (no row focused) Up goes to the last row.
    else if (event.key === "ArrowUp") focus(index === -1 ? rows.length - 1 : index - 1);
    else if (event.key === "Home" && !typing) focus(0);
    else if (event.key === "End" && !typing) focus(rows.length - 1);
    else if (event.key === "Escape") close();
    else return;
    event.preventDefault();
    event.stopPropagation();
  };

  return (
    <div className={cn("relative shrink-0", className)}>
      <button ref={trigger} type="button" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined}
        aria-label={ariaLabel} disabled={disabled} onClick={() => (open ? close() : setOpen(true))}
        onKeyDown={(event) => { if (event.key === "ArrowDown" && !open) { event.preventDefault(); setOpen(true); } }}
        className="quiet-action disabled:pointer-events-none disabled:opacity-50">
        <Icon aria-hidden className="size-3.5 shrink-0" />
        <span className="whitespace-nowrap">{label}</span>
        <ChevronDown aria-hidden className="-ml-0.5 size-3 shrink-0" />
      </button>
      {mounted && (
        <div ref={layer} id={id} role="menu" aria-label={menuLabel} inert={closing} onKeyDown={onMenuKey}
          onBlur={(event) => {
            const next = event.relatedTarget;
            if (next instanceof Node && !layer.current?.contains(next) && !trigger.current?.contains(next)) setOpen(false);
          }}
          className={cn("absolute top-full z-30 mt-1.5 w-48 rounded-xl border border-border bg-popover p-1 text-popover-foreground shadow-lg ease-out",
            align === "end" ? "right-0 origin-top-right" : "left-0 origin-top-left",
            closing
              ? "animate-out fade-out zoom-out-95 fill-mode-forwards duration-120 motion-reduce:zoom-out-100"
              : "animate-in fade-in zoom-in-95 duration-180 motion-reduce:zoom-in-100",
            menuClassName)}>
          {children(close)}
        </div>
      )}
    </div>
  );
}
