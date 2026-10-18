import { useState, type ReactNode } from "react";
import { Check, ChevronRight, Info, ChatCircle, Ellipsis, type IconComponent } from "@/components/ui/icon";

import { ActionRow } from "@/components/action-sheet-rows";
import { StatusDot } from "@/components/status-badge";
import { BottomSheet } from "@/components/ui/sheet";
import { useMediaQuery } from "@/hooks/use-media-query";
import type { NodeState } from "@/lib/org-tree";
import { cn } from "@/lib/utils";

const DOT_STATUS = { needs: "blocked", working: "working", idle: "idle" } as const;

/** A node's mark: red when it needs you, blue for review, a green ring while only its merge is left, the
 *  agent's dot otherwise, a grey check once resolved. */
export function NodeDot({ state, className = "size-2" }: { state: NodeState; className?: string }) {
  if (state === "resolved") return <Check aria-hidden data-node-state="resolved" className={cn("shrink-0 text-muted-foreground", className, "size-3")} />;
  if (state === "review") return <span aria-hidden className={cn("inline-flex shrink-0 rounded-full bg-primary", className)} />;
  if (state === "merging") return <span aria-hidden data-node-state="merging" className={cn("inline-flex shrink-0 rounded-full border border-status-done", className)} />;
  return <StatusDot status={DOT_STATUS[state]} surface="bg-transparent" className={className} />;
}

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
  /** What a tap opens, which the touch sheet names: the node's chat, or its detail page. */
  opens?: "chat" | "details";
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
          <NodeDot state={state} className="mt-1.5 size-2" />
          <span className="min-w-0 flex-1">
            <span className={cn("block break-words text-sm font-medium", state === "resolved" && "text-muted-foreground")}>{title}</span>
            <span className="block truncate text-xs text-muted-foreground">{detail}</span>
          </span>
          {age && <span className="task-age shrink-0 text-xs tabular-nums text-muted-foreground">{age}</span>}
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
function RowActions({ title, opens, onOpen, actions }: { title: string; opens: "chat" | "details"; onOpen: () => void; actions: RowAction[] }) {
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
        <ActionRow icon={<OpenIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />} label={opens === "chat" ? "Open chat" : "Open details"} onClick={() => run(onOpen)} />
        {actions.map((action) => <ActionRow key={action.name} icon={<action.icon aria-hidden className="size-4 shrink-0" />} label={action.menuLabel} destructive={action.destructive ?? true} onClick={() => run(action.run)} />)}
      </div>
    </BottomSheet>
  </>;
}
