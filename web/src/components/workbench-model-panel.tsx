import { useEffect, useState, type ComponentProps, type RefObject } from "react";
import { AnsiOutput } from "@/components/ansi-output";
import { LocalModelPicker } from "@/components/local-model-picker";
import { EffortStepper } from "@/components/native-model-menu";
import { ChevronRight, Pending } from "@/components/ui/icon";
import { WorkbenchPopover } from "@/components/ui/workbench-popover";
import type { ModelCatalogRow } from "@/hooks/use-model-catalog";
import type { MenuBlock } from "@/lib/blocks";
import { adapterFor } from "@/lib/harness/registry";
import { catalogRowFor, modelDisplayName } from "@/lib/model-display";
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
  /** The effort the agent reports for this session, when it has one. */
  reportedEffort?: string;
  catalog: { rows: ModelCatalogRow[]; loading: boolean };
  disabled: boolean;
  closing: boolean;
  onDismiss: () => void;
  onApply: (name: string) => Promise<void>;
  onApplyError: () => void;
  onLoad: () => Promise<void>;
  onMenuAction: ComponentProps<typeof AnsiOutput>["onMenuAction"];
}

// Below the desk breakpoint the picker is a bottom sheet rather than a card floating over the thread
// and the composer: full width, pinned to the bottom edge above the home indicator, rising from it on
// the drawer curve a phone's own sheets use. It stays the same nonmodal popover underneath (outside
// tap, Escape, ✕ and a phone's Back dismiss it, and opening it never takes the composer's focus), so
// only the placement changes. The popover positions itself with inline left/top/bottom from its
// anchor; the important utilities are what lets a class win over that inline placement on a phone.
const PHONE_SHEET = [
  "max-lg:left-0! max-lg:right-0! max-lg:top-auto! max-lg:bottom-0! max-lg:w-full! max-lg:max-w-none!",
  "max-lg:rounded-b-none max-lg:rounded-t-2xl max-lg:border-x-0 max-lg:border-b-0 max-lg:pb-[env(safe-area-inset-bottom)]",
  "max-lg:duration-300 max-lg:ease-[cubic-bezier(0.32,0.72,0,1)] max-lg:animate-in max-lg:slide-in-from-bottom motion-reduce:animate-none",
].join(" ");

const ROW = "flex min-h-12 w-full items-center gap-3 border-t border-border px-4 text-left";

/** Owns model-picker presentation; the caller retains terminal ownership and freshness guards. */
export function WorkbenchModelPanel({ scope, open, anchorRef, agent, text, menu, modelPresent,
  reportedModel, reportedEffort, catalog, disabled, closing, onDismiss, onApply, onApplyError, onLoad, onMenuAction }: Props) {
  const [advanced, setAdvanced] = useState(false);
  const [loadingEffort, setLoadingEffort] = useState(false);
  useEffect(() => { setAdvanced(false); setLoadingEffort(false); }, [scope, open]);
  const locked = disabled || closing;
  const parsed = menu ? parseNativeModelMenu(menu.menu, menu.lines) : null;
  // The agent's own picker, while it is open, says which model runs and offers its effort arrows.
  const live = parsed?.kind === "model" ? parsed : null;
  const effort = live ? menu?.menu.nav.leftRight : undefined;
  // Where the agent sets effort (its adapter measured it): only arrows beside the list can be opened
  // from here; a list after the model, or an agent nobody measured, shows the value it reports.
  const effortIn = adapterFor(agent)?.modelEffort;
  const currentModel = live?.rows.find((row) => row.current)?.name ?? catalogRowFor(catalog.rows.map((row) => row.name), reportedModel);

  async function apply(name: string) {
    try { await onApply(name); }
    catch (error) { onApplyError(); throw error; }
  }

  // Effort is set in the agent's picker: open it, and its arrows take this row's place.
  function loadEffort() {
    setLoadingEffort(true);
    void onLoad().catch((error: unknown) => {
      setStatus(error instanceof Error ? error.message : "Could not load model settings", "error");
    }).finally(() => setLoadingEffort(false));
  }

  function loadAdvanced() {
    setAdvanced(true);
    void onLoad().catch((error: unknown) => {
      setAdvanced(false);
      setStatus(error instanceof Error ? error.message : "Could not load model settings", "error");
    });
  }

  return <WorkbenchPopover open={open} anchorRef={anchorRef} label="Model picker" onDismiss={onDismiss} phoneBack
    className={`w-[min(28rem,calc(100vw-2rem))] ${PHONE_SHEET}`}>
    {parsed?.kind === "reasoning" || (advanced && modelPresent)
      ? <AnsiOutput text={text} nativeOnly agent={agent} onMenuAction={onMenuAction} promptDisabled={locked} />
      : advanced ? <p role="status" className="p-3 text-footnote text-muted-foreground">Loading model settings…</p>
      : catalog.rows.length ?
        <LocalModelPicker rows={catalog.rows} currentModel={currentModel} currentLabel={reportedModel && modelDisplayName(reportedModel)}
          disabled={locked} onApply={apply} onClose={onDismiss} currentApplies={live !== null}
          more={<>
            {effort && menu ? <div className={ROW}>
              <span className="flex-1 text-body">Effort</span>
              <EffortStepper effort={effort} disabled={locked} onStep={(key) => onMenuAction?.({ keys: [key], nav: true }, menu.menu)} />
            </div>
            : reportedEffort && (!modelPresent && effortIn === "arrows"
              ? <button type="button" disabled={locked || loadingEffort} className={`${ROW} hover:bg-accent active:bg-accent disabled:text-disabled-foreground`} onClick={loadEffort}>
                <span className="flex-1 text-body">Effort</span>
                <span className="text-footnote capitalize text-muted-foreground">{reportedEffort}</span>
                {loadingEffort ? <Pending aria-label="Opening the agent's picker" className="size-4 shrink-0" /> : <ChevronRight aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />}
              </button>
              : <div className={ROW}>
                <span className="flex-1">
                  <span className="block text-body">Effort</span>
                  {effortIn === "after-model" && <span className="block text-footnote text-muted-foreground">Chosen after the model</span>}
                </span>
                <span className="text-footnote capitalize text-muted-foreground">{reportedEffort}</span>
              </div>)}
            <button type="button" disabled={locked} className="mb-1 min-h-11 w-full rounded-lg text-footnote text-muted-foreground hover:bg-accent"
              onClick={loadAdvanced}>More model settings</button>
          </>} />
      : <div className="p-3 text-footnote text-muted-foreground">
        <p role="status">{catalog.loading ? "Loading model catalogue…" : "Model catalogue unavailable."}</p>
        {!catalog.loading && <button type="button" disabled={disabled} className="mt-3 min-h-11 rounded-md border border-border px-3 text-foreground"
          onClick={() => { void onLoad().catch((error: unknown) => setStatus(error instanceof Error ? error.message : "Could not load models", "error")); }}>Load from agent</button>}
      </div>}
  </WorkbenchPopover>;
}
