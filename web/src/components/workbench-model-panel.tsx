import { useEffect, useState, type ComponentProps, type RefObject } from "react";
import { AnsiOutput } from "@/components/ansi-output";
import { LocalModelPicker } from "@/components/local-model-picker";
import { WorkbenchPopover } from "@/components/ui/workbench-popover";
import type { ModelCatalogRow } from "@/hooks/use-model-catalog";
import type { MenuBlock } from "@/lib/blocks";
import { parseNativeModelMenu } from "@/lib/native-model-menu";
import { setStatus } from "@/lib/status";

interface Props {
  scope: string;
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement | null>;
  agent?: string;
  text: string;
  menu?: MenuBlock;
  modelPresent: boolean;
  reportedModel?: string;
  catalog: { rows: ModelCatalogRow[]; loading: boolean };
  disabled: boolean;
  closing: boolean;
  onDismiss: () => void;
  onApply: (name: string) => Promise<void>;
  onApplyError: () => void;
  onLoad: () => Promise<void>;
  onMenuAction: ComponentProps<typeof AnsiOutput>["onMenuAction"];
}

/** Owns model-picker presentation; the caller retains terminal ownership and freshness guards. */
export function WorkbenchModelPanel({ scope, open, anchorRef, agent, text, menu, modelPresent,
  reportedModel, catalog, disabled, closing, onDismiss, onApply, onApplyError, onLoad, onMenuAction }: Props) {
  const [advanced, setAdvanced] = useState(false);
  useEffect(() => { setAdvanced(false); }, [scope, open]);
  const locked = disabled || closing;
  const parsed = menu ? parseNativeModelMenu(menu.menu, menu.lines) : null;

  async function apply(name: string) {
    try { await onApply(name); }
    catch (error) { onApplyError(); throw error; }
  }

  function loadAdvanced() {
    setAdvanced(true);
    void onLoad().catch((error: unknown) => {
      setAdvanced(false);
      setStatus(error instanceof Error ? error.message : "Could not load model settings", "error");
    });
  }

  // Below the desk the picker is a bottom sheet with a full-bleed body, so what is not the list keeps
  // the sheet's 16px gutter itself.
  return <WorkbenchPopover open={open} anchorRef={anchorRef} label="Model" onDismiss={onDismiss} sheetBelowDesk
    className="w-[min(28rem,calc(100vw-2rem))]">
    {parsed?.kind === "reasoning" || (advanced && modelPresent)
      ? <div className="max-lg:px-4"><AnsiOutput text={text} nativeOnly agent={agent} onMenuAction={onMenuAction} promptDisabled={locked} /></div>
      : advanced ? <p role="status" className="p-3 text-footnote text-muted-foreground max-lg:px-4">Loading model settings…</p>
      : catalog.rows.length ?
        <LocalModelPicker rows={catalog.rows} currentModel={parsed?.rows.find((row) => row.current)?.name ?? reportedModel}
          disabled={locked} onApply={apply} onCancel={onDismiss}
          more={<button type="button" disabled={locked} className="mb-1 min-h-11 w-full rounded-lg text-footnote text-muted-foreground hover:bg-accent"
            onClick={loadAdvanced}>Reasoning and default settings</button>} />
      : <div className="p-3 text-footnote text-muted-foreground max-lg:px-4">
        <p role="status">{catalog.loading ? "Loading model catalogue…" : "Model catalogue unavailable."}</p>
        {!catalog.loading && <button type="button" disabled={disabled} className="mt-3 min-h-11 rounded-md border border-border px-3 text-foreground"
          onClick={() => { void onLoad().catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Could not load models", "error")); }}>Load from agent</button>}
      </div>}
  </WorkbenchPopover>;
}
