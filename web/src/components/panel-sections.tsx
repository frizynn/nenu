import { useEffect, useRef, useState, type ReactNode } from "react";

import { Fold } from "@/components/fold";
import { Button } from "@/components/ui/button";
import { ArrowDown, ArrowUp, ChevronRight, ListFilter } from "@/components/ui/icon";
import { arrange, arranged, foldSection, hideSection, moveSection, usePanelLayout } from "@/lib/panel-layout";
import { cn } from "@/lib/utils";

/** One section of a chat's panel: its head, which folds it, and what it holds. */
export interface PanelSection {
  id: string;
  label: string;
  /** Beside the label, folded or not: how many it holds, or what is alive in it. */
  badge?: ReactNode;
  /** Beside the label only while folded: what the open section says in its own rows. */
  brief?: ReactNode;
  /** It asks something of the operator (Waiting on you): it can fold, never hide. */
  urgent?: boolean;
  /** A control at the head's end (New thread, the Changes tab), drawn while the section is open. */
  action?: ReactNode;
  body: ReactNode;
}

/**
 * A chat panel's sections, each folding under its head, in the order the operator left them on this
 * device (lib/panel-layout). Arrange lists them folded, each with its place and Hide or Show, and a
 * Reset; a hidden section is drawn nowhere else, so one that asks something of the operator is never
 * hidden. `kind` names whose layout this is: every panel of that kind shares it.
 */
export function PanelSections({ kind, sections, footer }: { kind: string; sections: readonly PanelSection[]; footer?: ReactNode }) {
  const { layout, set, reset } = usePanelLayout(kind);
  const [arranging, setArranging] = useState(false);
  const defaults = sections.map((section) => section.id);
  const order = arrange(defaults, layout);
  const byId = new Map(sections.map((section) => [section.id, section]));
  const hiddenIds = new Set(sections.filter((section) => !section.urgent && layout.hidden.includes(section.id)).map((section) => section.id));
  // A control that a press unmounts, moves or disables hands the keyboard to its stand-in: Arrange and
  // Done to each other, a move to the same arrow, or the other one at an end.
  const box = useRef<HTMLDivElement>(null);
  const [focus, setFocus] = useState<{ key: string; or?: string } | null>(null);
  useEffect(() => {
    if (!focus) return;
    const find = (key?: string) => key ? box.current?.querySelector<HTMLButtonElement>(`[data-focus="${CSS.escape(key)}"]`) : null;
    const target = find(focus.key);
    (target && !target.disabled ? target : find(focus.or))?.focus();
    setFocus(null);
  }, [focus]);
  const move = (id: string, step: -1 | 1) => {
    set(moveSection(defaults, layout, id, step));
    setFocus({ key: `${step < 0 ? "up" : "down"}:${id}`, or: `${step < 0 ? "down" : "up"}:${id}` });
  };

  return (
    <div ref={box} className="flex flex-col gap-3">
      {order.map((id, index) => {
        const section = byId.get(id)!;
        const off = hiddenIds.has(id);
        if (off && !arranging) return null;
        const open = !arranging && !layout.folded.includes(id);
        return (
          <section key={id} aria-label={section.label} className="overview-card" data-hidden={off || undefined}>
            <header className="overview-card-head panel-section-head">
              {/* The chevron sits at the head's end, so the label starts where the section's rows do. */}
              <button type="button" className="panel-section-toggle" aria-expanded={arranging ? undefined : open} disabled={arranging}
                onClick={() => set(foldSection(layout, id, open))}>
                <span className="truncate">{section.label}</span>
                {section.badge}
                {!open && section.brief}
                {!arranging && <ChevronRight aria-hidden className={cn("desk-fold panel-section-chevron size-3.5", open && "rotate-90")} />}
              </button>
              {arranging ? <span className="flex shrink-0 items-center gap-0.5">
                <button type="button" className="panel-section-tool" aria-label={`Move ${section.label} up`} disabled={index === 0}
                  data-focus={`up:${id}`} onClick={() => move(id, -1)}><ArrowUp aria-hidden className="size-3.5" /></button>
                <button type="button" className="panel-section-tool" aria-label={`Move ${section.label} down`} disabled={index === order.length - 1}
                  data-focus={`down:${id}`} onClick={() => move(id, 1)}><ArrowDown aria-hidden className="size-3.5" /></button>
                {/* What asks for you keeps Hide's place empty, so every row's arrows line up. */}
                {section.urgent ? <span aria-hidden className="panel-section-tool panel-section-show invisible">Hide</span>
                  : <button type="button" className="panel-section-tool panel-section-show" aria-label={`${off ? "Show" : "Hide"} ${section.label}`}
                    onClick={() => set(hideSection(layout, id, !off))}>{off ? "Show" : "Hide"}</button>}
              </span> : open && section.action}
            </header>
            <Fold value={open}>{() => <div className="panel-section-body">{section.body}</div>}</Fold>
          </section>
        );
      })}
      <div className="flex flex-wrap items-center gap-1 px-1">
        {arranging ? <>
          <Button type="button" size="sm" variant="secondary" className="desk-head-action-quiet" data-focus="done"
            onClick={() => { setArranging(false); setFocus({ key: "arrange" }); }}>Done</Button>
          {arranged(layout) && <button type="button" className="quiet-action" onClick={() => { reset(); setFocus({ key: "done" }); }}>Reset</button>}
          <span className="px-1 text-footnote text-muted-foreground">Move or hide sections on this device.</span>
        </> : <button type="button" className="quiet-action" data-focus="arrange" onClick={() => { setArranging(true); setFocus({ key: "done" }); }}>
          <ListFilter aria-hidden className="size-3.5" />Arrange{hiddenIds.size > 0 && <span className="text-muted-foreground">· {hiddenIds.size} hidden</span>}
        </button>}
      </div>
      {/* What acts on the coordinator itself, Close among it, sits on a line of its own. */}
      {footer && !arranging && <div className="flex flex-wrap items-center gap-1 px-1">{footer}</div>}
    </div>
  );
}
