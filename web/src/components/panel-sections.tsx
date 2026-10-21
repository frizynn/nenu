import { useState, type ReactNode } from "react";

import { Fold } from "@/components/fold";
import { ArrowDown, ArrowUp, ChevronRight, ListFilter } from "@/components/ui/icon";
import { arrange, arranged, foldSection, hideSection, moveSection, usePanelLayout } from "@/lib/panel-layout";
import { cn } from "@/lib/utils";

/** One section of a chat's panel: its head, which folds it, and what it holds. */
export interface PanelSection {
  id: string;
  label: string;
  /** Beside the label, folded or not: how many it holds, or what is alive in it. */
  badge?: ReactNode;
  /** A control at the head's end (New thread, the Changes tab), drawn while the section is open. */
  action?: ReactNode;
  body: ReactNode;
}

/**
 * A chat panel's sections, each folding under its head, in the order the operator left them on this
 * device (lib/panel-layout). Arrange lists them folded, each with its place and Hide or Show, and a
 * Reset; a hidden section is drawn nowhere else. `kind` names whose layout this is: every panel of
 * that kind shares it.
 */
export function PanelSections({ kind, sections, footer }: { kind: string; sections: readonly PanelSection[]; footer?: ReactNode }) {
  const { layout, set, reset } = usePanelLayout(kind);
  const [arranging, setArranging] = useState(false);
  const defaults = sections.map((section) => section.id);
  const order = arrange(defaults, layout);
  const byId = new Map(sections.map((section) => [section.id, section]));
  const hidden = sections.filter((section) => layout.hidden.includes(section.id)).length;

  return (
    <div className="flex flex-col gap-3">
      {order.map((id, index) => {
        const section = byId.get(id)!;
        const off = layout.hidden.includes(id);
        if (off && !arranging) return null;
        const open = !arranging && !layout.folded.includes(id);
        return (
          <section key={id} aria-label={section.label} className="overview-card" data-hidden={off || undefined}>
            <header className="overview-card-head panel-section-head">
              <button type="button" className="panel-section-toggle" aria-expanded={arranging ? undefined : open} disabled={arranging}
                onClick={() => set(foldSection(layout, id, open))}>
                {!arranging && <ChevronRight aria-hidden className={cn("desk-fold panel-section-chevron size-3.5", open && "rotate-90")} />}
                <span className="truncate">{section.label}</span>
                {section.badge}
              </button>
              {arranging ? <span className="flex shrink-0 items-center gap-0.5">
                <button type="button" className="panel-section-tool" aria-label={`Move ${section.label} up`} disabled={index === 0}
                  onClick={() => set(moveSection(defaults, layout, id, -1))}><ArrowUp aria-hidden className="size-3.5" /></button>
                <button type="button" className="panel-section-tool" aria-label={`Move ${section.label} down`} disabled={index === order.length - 1}
                  onClick={() => set(moveSection(defaults, layout, id, 1))}><ArrowDown aria-hidden className="size-3.5" /></button>
                <button type="button" className="panel-section-tool panel-section-show" aria-pressed={!off} aria-label={`${off ? "Show" : "Hide"} ${section.label}`}
                  onClick={() => set(hideSection(layout, id, !off))}>{off ? "Show" : "Hide"}</button>
              </span> : open && section.action}
            </header>
            <Fold value={open}>{() => <div className="panel-section-body">{section.body}</div>}</Fold>
          </section>
        );
      })}
      <div className="flex flex-wrap items-center gap-1 px-1">
        {arranging ? <>
          <button type="button" className="quiet-action" onClick={() => setArranging(false)}>Done</button>
          {arranged(layout) && <button type="button" className="quiet-action" onClick={reset}>Reset</button>}
        </> : <button type="button" className="quiet-action" onClick={() => setArranging(true)}>
          <ListFilter aria-hidden className="size-3.5" />Arrange{hidden > 0 && <span className="text-muted-foreground">· {hidden} hidden</span>}
        </button>}
        {!arranging && footer}
      </div>
    </div>
  );
}
