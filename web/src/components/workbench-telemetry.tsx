import { modelDisplayName } from "@/lib/model-display";
import { Fragment, useState, type RefObject } from "react";
import { formatContextTokens, WorkbenchContextMeter } from "@/components/workbench-context-meter";
import type { SessionTelemetry } from "@/lib/types";

export type WorkbenchPanel = "model" | "usage" | "context" | null;

interface Props {
  /** "model": the picker chip and the context ring, for the composer's quiet row. "metrics": what the
   *  agent reported, inline, for the Context and usage dock. */
  mode: "model" | "metrics";
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

function windowName(limit: { name: string; windowMinutes?: number }): string {
  if (!limit.windowMinutes) return limit.name;
  return limit.windowMinutes === 10080 ? "Weekly" : `${limit.windowMinutes / 60}h window`;
}

/** A thin bar for a share of a window; it never stands alone, its number is beside it. */
function UsageBar({ value, label, danger = false }: { value: number; label: string; danger?: boolean }) {
  return (
    <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(value)}>
      <div className="h-full rounded-full" style={{ width: `${Math.min(100, Math.max(0, value))}%`, backgroundColor: danger ? "var(--destructive)" : "var(--primary)" }} />
    </div>
  );
}

/** Everything the agent reported about this session, read in place: no button between the dock and
 *  the numbers, and one plain sentence when there are none. */
function UsageDetails({ telemetry, stale }: { telemetry?: SessionTelemetry; stale?: boolean }) {
  const context = telemetry?.context;
  const values: [string, number | undefined][] = [
    ["Input tokens", telemetry?.tokens?.input], ["Output tokens", telemetry?.tokens?.output],
    ["Cached input", telemetry?.tokens?.cachedInput], ["Total tokens", telemetry?.tokens?.total],
  ];
  const reported = values.filter((entry): entry is [string, number] => entry[1] !== undefined);
  const used = context?.usedTokens;
  const max = context?.windowTokens;
  const percent = context?.usedPercent ?? (used !== undefined && max ? Math.min(100, (used / max) * 100) : undefined);
  const limits = telemetry?.rateLimits ?? [];
  const contextSize = used !== undefined ? `${formatContextTokens(used)}${max ? ` / ${formatContextTokens(max)}` : ""}` : max ? `${formatContextTokens(max)} window` : null;
  if (percent === undefined && contextSize === null && !reported.length && !limits.length) {
    return <p className="text-footnote text-muted-foreground">This agent hasn't reported usage yet.</p>;
  }
  return (
    <div className="space-y-4 text-footnote text-muted-foreground">
      {stale && <p className="text-destructive">Refreshing failed. These values may be out of date.</p>}
      {(percent !== undefined || contextSize !== null) && <div>
        <div className="flex justify-between gap-3">
          <span className="text-foreground">Context</span>
          <span className="tabular-nums">{[percent !== undefined ? `${Math.round(percent)}%` : null, contextSize].filter(Boolean).join(" · ")}</span>
        </div>
        {percent !== undefined && <UsageBar value={percent} label="Context window usage" danger={percent > 90} />}
      </div>}
      {limits.map((limit) => (
        <div key={limit.name}>
          <div className="flex justify-between gap-3">
            <span className="text-foreground">{windowName(limit)}</span>
            <span className="tabular-nums">{Math.round(limit.usedPercent)}% used</span>
          </div>
          <UsageBar value={limit.usedPercent} label={`${limit.name} rate limit used`} danger={limit.usedPercent > 90} />
          {limit.resetsAt !== undefined && <p className="mt-1">Resets {new Date(limit.resetsAt * 1000).toLocaleString()}</p>}
        </div>
      ))}
      {reported.length > 0 && <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">
        {reported.map(([label, value]) => <Fragment key={label}><dt>{label}</dt><dd className="text-right tabular-nums text-foreground">{tokens(value)}</dd></Fragment>)}
        {telemetry?.tokens && <><dt>Scope</dt><dd className="text-right text-foreground">{telemetry.tokens.scope === "session" ? "Session" : "Last message"}</dd></>}
      </dl>}
      {(telemetry?.observedAt || telemetry?.fileTruncated) && <div className="space-y-1">
        {telemetry?.observedAt && <p>Reported {new Date(telemetry.observedAt).toLocaleString()}</p>}
        {telemetry?.fileTruncated && <p>Only the tail of this session log is available.</p>}
      </div>}
    </div>
  );
}

export function WorkbenchTelemetry({ mode, telemetry, stale, modelAvailable, disabled, onChooseModel, onCompact, panel: controlledPanel, onPanelChange, modelOpen = false, modelTriggerRef }: Props) {
  const context = telemetry?.context;
  const [localPanel, setLocalPanel] = useState<WorkbenchPanel>(null);
  const panel = controlledPanel === undefined ? localPanel : controlledPanel;
  const changePanel = (next: WorkbenchPanel) => {
    if (controlledPanel === undefined) setLocalPanel(next);
    onPanelChange?.(next);
  };
  if (mode === "metrics") return <UsageDetails telemetry={telemetry} stale={stale} />;
  // With no model reported the chip names what a tap does, and where there is no picker to open
  // either it waits for the agent to report one: a bare "Model" read as a caption for nothing. An open
  // model panel keeps it either way: a native menu on screen opens the panel, and the chip anchors it.
  const model = telemetry?.model ? modelDisplayName(telemetry.model) : null;
  return (
    <div className="workbench-telemetry flex min-w-0 flex-1 flex-nowrap items-center gap-1 text-footnote text-muted-foreground">
      {(model || modelAvailable || modelOpen) && <button
        ref={modelTriggerRef}
        type="button"
        className="composer-quiet hit-area flex min-w-0 max-w-[13rem] items-center gap-2.5 md:max-w-[18rem]"
        disabled={(disabled && !modelOpen) || !modelAvailable}
        onClick={() => {
          if (controlledPanel === undefined) setLocalPanel(null);
          onChooseModel();
        }}
        aria-label="Choose model"
        aria-expanded={modelOpen}
        aria-haspopup="dialog"
        title={modelAvailable ? [telemetry?.model, telemetry?.effort].filter(Boolean).join(" · ") || "Open the agent's model picker" : "This agent does not expose a model picker"}
      >
        <span className="truncate">{model ?? "Choose model"}</span>
        {telemetry?.effort && <span className="shrink-0 capitalize">{telemetry.effort}</span>}
      </button>}
      {/* The composer row carries the context ring and its number (and its Compact action). */}
      <WorkbenchContextMeter reportedPercent={context?.usedPercent} usedTokens={context?.usedTokens ?? null} maxTokens={context?.windowTokens ?? null}
        onCompact={onCompact} compactDisabled={disabled} open={panel === "context"}
        onOpenChange={(open) => changePanel(open ? "context" : null)} />
    </div>
  );
}
