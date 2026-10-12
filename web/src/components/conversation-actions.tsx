import { Check, MoreHorizontal, type LucideIcon } from "lucide-react";
import { forwardRef, useImperativeHandle, useRef, useState, type ReactNode } from "react";
import { SectionLabel } from "@/components/ui/section-label";
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
  /** The pane's folder, as a quiet line at the foot of the menu: the header names the place instead. */
  folder?: string;
}

/** The pane's one ⋯ menu: the pane's views, grouped and named when there is more than one group. */
export const ConversationActions = forwardRef<HTMLButtonElement | null, Props>(function ConversationActions({ groups, recovery, folder }, ref) {
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
        <summary className="flex min-h-11 cursor-pointer items-center px-2.5 text-body lg:min-h-8 lg:text-footnote">Change connected conversation</summary>
        {recovery}
      </details>}
      {folder && <p className="mt-1 truncate border-t border-border/60 px-2.5 pt-2 pb-1 font-mono text-footnote text-muted-foreground" title={folder}>{folder}</p>}
    </WorkbenchPopover>
  </>;
});

/** The menu's grouped rows; `onRun` decides what happens around an action (the menu closes first). */
export function ActionGroups({ groups, onRun }: { groups: ConversationActionGroup[]; onRun: (action: () => void) => void }) {
  const shown = groups.filter((group) => group.actions.length > 0);
  // A lone group needs no heading; the menu's own name says what it holds.
  return shown.map((group, index) => (
    <section key={group.label} aria-label={group.label} className={cn(index > 0 && "mt-1 border-t border-border/60 pt-1")}>
      {shown.length > 1 && <h4 className="px-2.5 pb-0.5 pt-1.5"><SectionLabel>{group.label}</SectionLabel></h4>}
      {group.actions.map(({ id, label, icon: Icon, run, disabled, on }) => (
        <button key={id} type="button" disabled={disabled} aria-pressed={on === undefined ? undefined : on}
          onClick={() => onRun(run)}
          className="workbench-menu-item group flex min-h-11 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-body hover:bg-accent active:bg-muted disabled:text-disabled-foreground disabled:hover:bg-transparent lg:min-h-8 lg:text-footnote">
          <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground group-disabled:text-disabled-foreground" />
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {on && <Check aria-hidden="true" className="size-4 shrink-0 text-primary" />}
        </button>
      ))}
    </section>
  ));
}
