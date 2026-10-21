import { useState, type ReactNode } from "react";
import { ChevronRight, Info, ChatCircle, Ellipsis, type IconComponent } from "@/components/ui/icon";

import { ActionRow } from "@/components/action-sheet-rows";
import { StateMark as NodeDot } from "@/components/status-badge";
import { BottomSheet } from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { NodeState } from "@/lib/org-tree";
import { cn } from "@/lib/utils";

/** A node's mark (status-badge.tsx): one glyph per state, the same in every list. */
export { NodeDot };

export interface Fold {
  open: boolean;
  onToggle: () => void;
}

/** Something a row does besides opening, asking first: Close and Replace stop an agent, Move asks where. */
export interface RowAction {
  /** The word a desk shows on hover ("Close"). */
  label: string;
  /** Its accessible name, which names the row ("Close Build"). */
  name: string;
  /** Its row in the touch sheet, with an ellipsis since a dialog follows ("Close thread…"). */
  menuLabel: string;
  icon: IconComponent;
  run: () => void;
  /** Whether its touch sheet row reads as destructive; it does unless the action stops nothing. */
  destructive?: boolean;
}

/** One node's row; `children` hangs the nodes a coordinator runs inside the same list item. */
export function TaskRow({ state, title, detail, age, current, onOpen, opens = "details", actions = [], fold, children }: {
  state: NodeState;
  title: string;
  detail: string;
  age?: string;
  current: boolean;
  onOpen: () => void;
  /** What a tap opens, which the touch sheet names: the node's chat, its detail, or a coordinator's page (with a ›). */
  opens?: "chat" | "details" | "page";
  /** Close, or replace for the project coordinator. */
  actions?: RowAction[];
  /** Present on a resolved coordinator, whose threads fold under it. */
  fold?: Fold;
  children?: ReactNode;
}) {
  return (
    <li aria-current={current ? "true" : undefined}>
      <div className="task-row">
        <button type="button" className="task-main" onClick={onOpen}>
          {/* The mark centres on the title's first line, whichever mark it is (a dot or the check). */}
          <span className="flex h-6 shrink-0 items-center"><NodeDot state={state} /></span>
          <span className="min-w-0 flex-1">
            <span className={cn("block break-words text-body font-medium", state === "resolved" && "text-muted-foreground")}>{title}</span>
            <span className="block truncate text-footnote text-muted-foreground">{detail}</span>
          </span>
          {age && <span className="task-age shrink-0 text-footnote leading-6 tabular-nums text-muted-foreground">{age}</span>}
          {opens === "page" && <ChevronRight aria-hidden className="size-4 shrink-0 self-center text-muted-foreground" />}
        </button>
        {fold && <button type="button" className="task-fold" aria-label={`${title} threads`} aria-expanded={fold.open} onClick={fold.onToggle}>
          <ChevronRight aria-hidden className="size-4" />
        </button>}
        {actions.length > 0 && <RowActions title={title} opens={opens} onOpen={onOpen} actions={actions} />}
      </div>
      {children}
    </li>
  );
}

/** Where a row's words would wait for a hover that never comes: no hover at all, or a finger first. */
const NO_HOVER = "(hover: none), (pointer: coarse)";

/**
 * A row's actions. A desk names them in words over the row's age while the pointer rests on it (or a
 * key reaches them); a screen that cannot hover keeps a ⋯ that opens them in an action sheet with
 * the row's own Open first. Only resolved work wears a check.
 */
function RowActions({ title, opens, onOpen, actions }: { title: string; opens: "chat" | "details" | "page"; onOpen: () => void; actions: RowAction[] }) {
  const touch = useMediaQuery(NO_HOVER);
  const [sheet, setSheet] = useState(false);
  if (!touch) {
    return (
      <span className="task-actions">
        {actions.map((action) => <button key={action.name} type="button" className="task-action" aria-label={action.name} onClick={action.run}>{action.label}</button>)}
      </span>
    );
  }
  const run = (then: () => void) => { setSheet(false); then(); };
  const OpenIcon = opens === "chat" ? ChatCircle : Info;
  return <>
    <button type="button" className="task-more" aria-label={`${title} actions`} aria-haspopup="dialog" aria-expanded={sheet} onClick={() => setSheet(true)}>
      <Ellipsis aria-hidden className="size-5" />
    </button>
    <BottomSheet open={sheet} onClose={() => setSheet(false)} title={title}>
      <div className="flex flex-col gap-1">
        <ActionRow icon={<OpenIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />} label={opens === "chat" ? "Open chat" : opens === "page" ? "Open coordinator" : "Open details"} onClick={() => run(onOpen)} />
        {actions.map((action) => <ActionRow key={action.name} icon={<action.icon aria-hidden className="size-4 shrink-0" />} label={action.menuLabel} destructive={action.destructive ?? true} onClick={() => run(action.run)} />)}
      </div>
    </BottomSheet>
  </>;
}
