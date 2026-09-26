import { AgentIcon } from "@/components/agent-icon";
import { useId, useRef, useState } from "react";
import { Check, ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import type { MenuModel } from "@/lib/blocks";
import { modelRowKeys, type NativeModelMenu as ParsedModelMenu } from "@/lib/native-model-menu";
import type { MenuBlockAction } from "./menu-block";

interface Props {
  agent?: string;
  menu: MenuModel;
  parsed: ParsedModelMenu;
  onAction: (action: MenuBlockAction) => void | Promise<void>;
  disabled?: boolean;
}

// Row styling adapted from T3 Code ModelListRow.tsx at 191a4ef (MIT; THIRD_PARTY_NOTICES.md).
// The catalogue and selection come exclusively from the currently observed agent menu.
export function NativeModelMenu({ agent, menu, parsed, onAction, disabled }: Props) {
  const id = useId();
  const [sending, setSending] = useState<string | null>(null);
  const inFlight = useRef(false);
  const locked = disabled || sending !== null;

  async function press(id: string, action: MenuBlockAction) {
    if (disabled || inFlight.current || action.keys.length === 0) return;
    inFlight.current = true;
    setSending(id);
    try {
      await onAction(action);
    } finally {
      inFlight.current = false;
      setSending(null);
    }
  }

  const choose = (index: number) => {
    // Relative offsets depend on the exact highlight we rendered, so use the FULL freshness guard.
    void press(`row-${index}`, { keys: modelRowKeys(parsed.selectedIndex, index, parsed.rows.length), nav: false });
  };
  const effort = menu.nav.leftRight;

  return (
    <section aria-label={menu.title} className="native-model-menu overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg">
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <AgentIcon agent={agent} className="size-5" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium">{parsed.kind === "reasoning" ? "Reasoning effort" : "Model"}</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{parsed.kind === "reasoning" ? menu.title.replace(/^Select Reasoning Level for /i, "") : "Choose a model, then apply your selection."}</p>
        </div>
      </div>

      <div role="radiogroup" aria-label={parsed.kind === "reasoning" ? "Reasoning levels" : "Available models"} className="max-h-[min(24rem,45dvh)] overflow-y-auto p-1.5">
        {parsed.rows.map((row, index) => (
          <button
            key={`${index}-${row.name}`}
            type="button"
            role="radio"
            aria-checked={row.selected}
            aria-label={`${row.name}${row.current ? ", Current" : ""}`}
            aria-describedby={row.description ? `${id}-description-${index}` : undefined}
            disabled={locked}
            onClick={() => choose(index)}
            onKeyDown={(event) => {
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              event.preventDefault();
              choose((index + (event.key === "ArrowDown" ? 1 : parsed.rows.length - 1)) % parsed.rows.length);
            }}
            className={`group relative flex min-h-11 w-full min-w-0 items-center gap-3 rounded-md px-2.5 py-2.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${row.selected ? "bg-foreground/[0.08] text-foreground" : ""}`}
          >
            <span className="flex size-4 shrink-0 items-center justify-center rounded-full border border-border" aria-hidden="true">
              {row.selected && <span className="size-2 rounded-full bg-foreground" />}
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-xs font-medium leading-snug">{row.name}</span>
                {row.current && <span className="shrink-0 rounded border border-border px-1 text-[10px] text-muted-foreground">Current</span>}
              </span>
              {row.description && <span id={`${id}-description-${index}`} className="mt-1 block text-xs leading-snug text-muted-foreground">{row.description}</span>}
            </span>
            {sending === `row-${index}` ? <Loader2 aria-label="Updating selection" className="size-3.5 shrink-0 animate-spin motion-reduce:animate-none" /> : row.selected && <Check aria-hidden="true" className="size-3.5 shrink-0 text-muted-foreground" />}
          </button>
        ))}
      </div>

      {effort && <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
        <span className="text-xs text-muted-foreground">Reasoning effort</span>
        <div className="inline-flex items-center rounded-md border border-border bg-muted/50 p-0.5">
          <button type="button" disabled={locked} aria-label={`Left — ${effort.verb} (${effort.label})`} onClick={() => void press("effort-left", { keys: ["Left"], nav: true })} className="flex min-h-9 min-w-9 items-center justify-center rounded hover:bg-accent disabled:opacity-50"><ChevronLeft aria-hidden="true" className="size-4" /></button>
          <span className="min-w-20 px-2 text-center text-xs font-medium">{effort.label.replace(/^[^\p{L}\p{N}]+/u, "").replace(/\s+effort$/i, "")}</span>
          <button type="button" disabled={locked} aria-label={`Right — ${effort.verb} (${effort.label})`} onClick={() => void press("effort-right", { keys: ["Right"], nav: true })} className="flex min-h-9 min-w-9 items-center justify-center rounded hover:bg-accent disabled:opacity-50"><ChevronRight aria-hidden="true" className="size-4" /></button>
        </div>
      </div>}

      <div className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-3 py-3">
        {[...menu.actions.filter((action) => action.cancel), ...menu.actions.filter((action) => !action.cancel)].map((action, index) => (
          <button key={index} type="button" disabled={locked} onClick={() => void press(`action-${index}`, { keys: action.keys, nav: false })} className={`inline-flex min-h-10 items-center justify-center gap-1.5 rounded-md px-3 text-xs font-medium disabled:opacity-50 ${action.cancel ? "mr-auto text-muted-foreground hover:bg-accent" : "border border-border bg-secondary text-foreground hover:bg-accent"}`}>
            {sending === `action-${index}` && <Loader2 aria-hidden="true" className="size-3 animate-spin motion-reduce:animate-none" />}{action.label}
          </button>
        ))}
      </div>
    </section>
  );
}
