import { modelDisplayName } from "@/lib/model-display";
import { ChevronDown, Cpu, Gauge } from "lucide-react";
import { Fragment, useRef, useState, type RefObject } from "react";
import { WorkbenchContextMeter } from "@/components/workbench-context-meter";
import { WorkbenchPopover } from "@/components/ui/workbench-popover";
import type { SessionTelemetry } from "@/lib/types";

export type WorkbenchPanel = "model" | "usage" | "context" | null;

interface Props {
  mode?: "model" | "metrics";
  telemetry?: SessionTelemetry;
  stale?: boolean;
  modelAvailable: boolean;
  disabled: boolean;
  onChooseModel: () => void;
  onCompact?: () => void;
  panel?: WorkbenchPanel;
  onPanelChange?: (panel: WorkbenchPanel) => void;
  modelOpen?: boolean;
  modelTriggerRef?: RefObject<HTMLButtonElement | null>;
}

function tokens(value: number | undefined): string {
  return value === undefined ? "Not reported" : value.toLocaleString();
}

export function WorkbenchTelemetry({ mode, telemetry, stale, modelAvailable, disabled, onChooseModel, onCompact, panel: controlledPanel, onPanelChange, modelOpen = false, modelTriggerRef }: Props) {
  const context = telemetry?.context;
  const [localPanel, setLocalPanel] = useState<WorkbenchPanel>(null);
  const panel = controlledPanel === undefined ? localPanel : controlledPanel;
  const usageRef = useRef<HTMLButtonElement>(null);
  const changePanel = (next: WorkbenchPanel) => {
    if (controlledPanel === undefined) setLocalPanel(next);
    onPanelChange?.(next);
  };
  const values: [string, number | undefined][] = [
    ["Input tokens", telemetry?.tokens?.input], ["Output tokens", telemetry?.tokens?.output],
    ["Cached input", telemetry?.tokens?.cachedInput], ["Total tokens", telemetry?.tokens?.total],
    ["Context used", context?.usedTokens], ["Context window", context?.windowTokens],
  ];
  const reported = values.filter((entry): entry is [string, number] => entry[1] !== undefined);
  const hasMetrics = reported.length > 0 || Boolean(telemetry?.rateLimits?.length);
  return (
    <div className="workbench-telemetry flex min-w-0 flex-1 flex-nowrap items-center gap-1 text-xs text-muted-foreground">
      {mode !== "metrics" && <button
        ref={modelTriggerRef}
        type="button"
        className="flex min-h-11 min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 text-foreground hover:bg-accent disabled:opacity-50"
        disabled={(disabled && !modelOpen) || !modelAvailable}
        onClick={() => {
          if (controlledPanel === undefined) setLocalPanel(null);
          onChooseModel();
        }}
        aria-label="Choose model"
        aria-expanded={modelOpen}
        aria-haspopup="dialog"
        title={modelAvailable ? "Open the agent's model picker" : "This agent does not expose a model picker"}
      >
        <Cpu className="size-3.5 shrink-0" />
        <span className="truncate" title={telemetry?.model}>{telemetry?.model ? modelDisplayName(telemetry.model) : "Model not reported"}</span>
        {telemetry?.effort && <span className="hidden shrink-0 text-muted-foreground sm:inline">{telemetry.effort}</span>}
        <ChevronDown className="size-3 shrink-0" />
      </button>}
      {mode !== "model" && <>
      <WorkbenchContextMeter usedTokens={context?.usedTokens ?? null} maxTokens={context?.windowTokens ?? null}
        onCompact={onCompact} compactDisabled={disabled} open={panel === "context"}
        onOpenChange={(open) => changePanel(open ? "context" : null)} />
      <div className="relative min-w-0">
        <button ref={usageRef} type="button" aria-expanded={panel === "usage"} aria-haspopup="dialog" onClick={() => changePanel(panel === "usage" ? null : "usage")} className="flex min-h-11 cursor-pointer items-center gap-1 rounded-md px-1.5 hover:bg-accent">
          <Gauge className="size-3.5" />
          <span>Usage{stale ? " · stale" : ""}</span>
        </button>
        <WorkbenchPopover open={panel === "usage"} onDismiss={() => changePanel(null)} anchorRef={usageRef} label="Last reported usage">
          {!hasMetrics ? <p>Usage is not available yet.</p> : <>
          {stale && <p className="mb-2 text-status-blocked">Refreshing failed. These values may be out of date.</p>}
          {reported.length > 0 && <dl className="grid grid-cols-2 gap-x-3 gap-y-2">
            {reported.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd className="text-right tabular-nums">{tokens(value)}</dd></Fragment>)}
            {telemetry?.tokens && <><dt>Scope</dt><dd className="text-right">{telemetry.tokens.scope === "session" ? "Session" : "Last message"}</dd></>}
          </dl>}
          {Boolean(telemetry?.rateLimits?.length) && <div className="mt-3 border-t border-border pt-3">
            {telemetry?.rateLimits?.map((limit) => (
              <div key={limit.name} className="mb-2">
                <div className="flex justify-between gap-2"><span>{limit.windowMinutes ? `${limit.windowMinutes / 60}h window` : limit.name}</span><span>{limit.usedPercent}% used</span></div>
                <progress aria-label={`${limit.name} rate limit used`} className="h-1 w-full" max={100} value={limit.usedPercent} />
                {limit.resetsAt !== undefined && <p className="mt-1 text-muted-foreground">Resets {new Date(limit.resetsAt * 1000).toLocaleString()}</p>}
              </div>
            ))}
          </div>}
          {telemetry?.observedAt && <p className="mt-2 text-muted-foreground">Reported {new Date(telemetry.observedAt).toLocaleString()}</p>}
          {telemetry?.fileTruncated && <p className="mt-2 text-status-blocked">Only the tail of this session log is available.</p>}
          </>}
        </WorkbenchPopover>
      </div>
      {telemetry?.tokens?.total !== undefined && <span className="hidden shrink-0 tabular-nums sm:inline">{tokens(telemetry.tokens.total)} tokens</span>}
      </>}
    </div>
  );
}
