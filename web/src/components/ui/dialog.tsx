import { useEffect, useId, useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * A modal built on the native `<dialog>`: `showModal()` gives the focus trap, the inert page behind,
 * the top layer and Escape for free, and closing returns focus to the opener. Engines without
 * `showModal` (old WebViews, jsdom) still get an open, labelled dialog rather than nothing.
 */
export function Dialog({ open, onClose, title, description, children, className }: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || open === dialog.open) return;
    if (open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descriptionId : undefined}
      // Escape fires `cancel`; keep React's `open` the single source of truth.
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      // A press on the backdrop targets the <dialog> itself; the panel inside stops it.
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      className={cn("app-dialog", className)}
    >
      {open && (
        <div className="p-5">
          <h2 id={titleId} className="text-base font-semibold">{title}</h2>
          {description && <div id={descriptionId} className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{description}</div>}
          {children}
        </div>
      )}
    </dialog>
  );
}

/** An in-app replacement for `window.confirm`, with room for the failure the action reports. */
export function ConfirmDialog({ open, title, description, confirmLabel, busy = false, error, onConfirm, onCancel }: {
  open: boolean;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Dialog open={open} onClose={onCancel} title={title} description={description}>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button type="button" variant="ghost" size="lg" onClick={onCancel} disabled={busy}>Cancel</Button>
        <Button type="button" variant="destructive" size="lg" onClick={onConfirm} disabled={busy}>{busy ? "Working…" : confirmLabel}</Button>
      </div>
    </Dialog>
  );
}
