import type { ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";

import { StatusDot } from "@/components/status-badge";
import type { NodeState } from "@/lib/org-tree";
import { cn } from "@/lib/utils";

const DOT_STATUS = { needs: "blocked", working: "working", idle: "idle" } as const;

/** A node's mark: red when it needs you, blue for review, the agent's dot otherwise, a grey check once resolved. */
export function NodeDot({ state, className = "size-2" }: { state: NodeState; className?: string }) {
  if (state === "resolved") return <Check aria-hidden className={cn("shrink-0 text-muted-foreground", className, "size-3")} />;
  if (state === "review") return <span aria-hidden className={cn("inline-flex shrink-0 rounded-full bg-primary", className)} />;
  return <StatusDot status={DOT_STATUS[state]} surface="bg-transparent" className={className} />;
}

export interface Fold {
  open: boolean;
  onToggle: () => void;
}

/** One node's row; `children` hangs the nodes a coordinator runs inside the same list item. */
export function TaskRow({ state, title, detail, age, current, onOpen, action, fold, children }: {
  state: NodeState;
  title: string;
  detail: string;
  age?: string;
  current: boolean;
  onOpen: () => void;
  /** A trailing control: close, or replace for the project coordinator. */
  action?: ReactNode;
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
          {age && <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{age}</span>}
        </button>
        {fold && <button type="button" className="task-fold" aria-label={`${title} threads`} aria-expanded={fold.open} onClick={fold.onToggle}>
          <ChevronRight aria-hidden className="size-4" />
        </button>}
        {action}
      </div>
      {children}
    </li>
  );
}
