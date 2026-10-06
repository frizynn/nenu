import { Check, MoreHorizontal, type LucideIcon } from "lucide-react";
import { forwardRef, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { WorkbenchPopover } from "@/components/ui/workbench-popover";
import { cn } from "@/lib/utils";

export interface ConversationAction {
  id: string;
  label: string;
  icon: LucideIcon;
  run: () => void;
  disabled?: boolean;
  /** An open dock or an armed mode, shown as a check. */
  on?: boolean;
}

export interface ConversationActionGroup {
  label: string;
  actions: ConversationAction[];
}

interface Props {
  groups: ConversationActionGroup[];
  recovery?: ReactNode;
}

/** The pane's one ⋯ menu: every secondary tool, grouped and named, so the header and composer stay one row. */
export const ConversationActions = forwardRef<HTMLButtonElement | null, Props>(function ConversationActions({ groups, recovery }, ref) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  useImperativeHandle(ref, () => trigger.current!, []);
  const run = (action: () => void) => { setOpen(false); action(); };
  return <>
    <button ref={trigger} type="button" aria-label="Conversation actions" aria-haspopup="dialog" aria-expanded={open}
      onClick={() => setOpen(!open)} className="flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground active:bg-muted lg:size-8">
      <MoreHorizontal aria-hidden="true" className="size-5 lg:size-4" />
    </button>
    <WorkbenchPopover open={open} onDismiss={() => setOpen(false)} anchorRef={trigger} label="Conversation actions" className="w-64 [&>div:first-child]:hidden [&>div:last-child]:p-1.5">
      <ActionGroups groups={groups} onRun={run} />
      {recovery && <details className="mt-1 border-t border-border/60 pt-1">
        <summary className="flex min-h-11 cursor-pointer items-center px-2.5 text-sm lg:min-h-8 lg:text-[13px]">Change connected conversation</summary>
        {recovery}
      </details>}
    </WorkbenchPopover>
  </>;
});

/** The menu's grouped rows; `onRun` decides what happens around an action (the menu closes first). */
export function ActionGroups({ groups, onRun }: { groups: ConversationActionGroup[]; onRun: (action: () => void) => void }) {
  return groups.filter((group) => group.actions.length > 0).map((group, index) => (
    <section key={group.label} aria-label={group.label} className={cn(index > 0 && "mt-1 border-t border-border/60 pt-1")}>
      <h4 className="px-2.5 pb-0.5 pt-1.5 text-[11px] font-medium text-muted-foreground">{group.label}</h4>
      {group.actions.map(({ id, label, icon: Icon, run, disabled, on }) => (
        <button key={id} type="button" disabled={disabled} aria-pressed={on === undefined ? undefined : on}
          onClick={() => onRun(run)}
          className="workbench-menu-item flex min-h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm hover:bg-accent active:bg-muted disabled:opacity-50 disabled:hover:bg-transparent lg:min-h-8 lg:text-[13px]">
          <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {on && <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />}
        </button>
      ))}
    </section>
  ));
}
