import { MoreHorizontal, ScrollText, Search, Settings2 } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";
import { WorkbenchPopover } from "@/components/ui/workbench-popover";

interface Props {
  onFind?: () => void;
  onHistory?: () => void;
  onDisplay: () => void;
  files?: ReactNode;
  recovery?: ReactNode;
}

/** Secondary tools stay named and discoverable without displacing the view switch. */
export function ConversationActions({ onFind, onHistory, onDisplay, files, recovery }: Props) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const run = (action: () => void) => { setOpen(false); action(); };
  const item = "flex min-h-11 w-full items-center gap-3 rounded-lg px-3 text-left text-sm hover:bg-accent active:bg-muted";
  return <>
    <button ref={trigger} type="button" aria-label="Conversation actions" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen(!open)} className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent active:bg-muted">
      <MoreHorizontal aria-hidden="true" className="size-5" />
    </button>
    <WorkbenchPopover open={open} onDismiss={() => setOpen(false)} anchorRef={trigger} label="Conversation actions">
      {onFind && <button type="button" className={item} onClick={() => run(onFind)}><Search aria-hidden="true" className="size-4" />Find in output</button>}
      {files}
      {onHistory && <button type="button" className={item} onClick={() => run(onHistory)}><ScrollText aria-hidden="true" className="size-4" />Conversation history</button>}
      <button type="button" className={item} onClick={() => run(onDisplay)}><Settings2 aria-hidden="true" className="size-4" />Display settings</button>
      {recovery && <details className="mt-2 border-t pt-2">
        <summary className="min-h-11 cursor-pointer content-center px-3 text-sm">Change connected conversation</summary>
        {recovery}
      </details>}
    </WorkbenchPopover>
  </>;
}
