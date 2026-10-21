import { useId, useLayoutEffect, useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { usePresence } from "@/components/ui/presence";
import { cn } from "@/lib/utils";

/**
 * A modal built on the native `<dialog>`: `showModal()` gives the focus trap, the inert page behind,
 * the top layer and Escape for free, and closing returns focus to the opener. Engines without
 * `showModal` (old WebViews, jsdom) still get an open, labelled dialog rather than nothing. It comes
 * in and goes out with a fade and a 0.98 scale in 150 ms, a 120 ms fade alone under reduced motion,
 * and stays open with the words it showed, inert, until its exit ends (presence.ts).
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
  const { mounted, closing, content } = usePresence(open, { title, description, children }, ref);

  // Before paint: the frame its exit ends in must not show it again with its entry classes back.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog || mounted === dialog.open) return;
    if (mounted) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    } else if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  }, [mounted]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={content.description ? descriptionId : undefined}
      // While it fades out it shows the buttons it had open, wired to that moment: out of reach, so a
      // second press cannot confirm what Escape just cancelled.
      inert={closing}
      // Escape fires `cancel`; keep React's `open` the single source of truth.
      onCancel={(event) => { event.preventDefault(); if (!closing) onClose(); }}
      // A press on the backdrop targets the <dialog> itself; the panel inside stops it.
      onClick={(event) => { if (!closing && event.target === event.currentTarget) onClose(); }}
      className={cn(
        "app-dialog duration-180 ease-out backdrop:duration-180 backdrop:ease-out motion-reduce:duration-120 motion-reduce:backdrop:duration-120",
        closing
          ? "animate-out fade-out zoom-out-98 fill-mode-forwards backdrop:animate-out backdrop:fade-out backdrop:fill-mode-forwards motion-reduce:zoom-out-100"
          : "animate-in fade-in zoom-in-98 backdrop:animate-in backdrop:fade-in motion-reduce:zoom-in-100",
        className,
      )}
    >
      {mounted && (
        <div className="p-5">
          <h2 id={titleId} className="text-base font-semibold">{content.title}</h2>
          {content.description && <div id={descriptionId} className="mt-1.5 text-sm leading-relaxed text-muted-foreground">{content.description}</div>}
          {content.children}
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
        <Button type="button" variant="destructive" size="lg" onClick={onConfirm} disabled={busy} aria-busy={busy || undefined}>{busy ? "Working…" : confirmLabel}</Button>
      </div>
    </Dialog>
  );
}
