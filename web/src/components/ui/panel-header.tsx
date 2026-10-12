import { X } from "@/components/ui/icon";

import { cn } from "@/lib/utils";

/**
 * The one header of a compact panel, a composer dock or a popover: its name, the same words as the
 * row that opened it, then a 44px close. The title is a bar's (17/600 on a phone, the desk bar's 15
 * from 1024); a sheet keeps its larger one. The caller's inset puts the title where its rows start.
 */
export function PanelHeader({ title, onClose, className }: { title: string; onClose: () => void; className?: string }) {
  return (
    <div className={cn("flex min-w-0 items-center gap-3 border-b border-border py-1 pl-4 pr-1", className)}>
      <h3 className="min-w-0 flex-1 truncate text-headline font-semibold lg:text-subhead lg:tracking-normal">{title}</h3>
      <button type="button" onClick={onClose} aria-label={`Close ${title}`}
        className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
        <X aria-hidden="true" className="size-4" />
      </button>
    </div>
  );
}
