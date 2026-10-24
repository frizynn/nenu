import { useRef, useState } from "react";
import { WorkbenchPopover } from "@/components/ui/workbench-popover";
import { limitRows } from "@/lib/rate-limits";
import type { SessionTelemetry } from "@/lib/types";

// Adapted from T3 Code ContextWindowMeter.tsx and contextWindow.ts at 191a4ef.
// MIT, Copyright (c) 2026 T3 Tools Inc. See THIRD_PARTY_NOTICES.md.
export function formatContextTokens(value: number | null): string {
  if (value === null || !Number.isFinite(value) || value < 0) return "Unknown";
  if (value < 1_000) return `${Math.round(value)}`;
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`;
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
}

/** How full the context is, 0 to 100: the share the agent reported, else used over the window; null while unknown. */
export function contextPercent(context: { usedPercent?: number; usedTokens?: number | null; windowTokens?: number | null } | undefined): number | null {
  const { usedPercent, usedTokens, windowTokens } = context ?? {};
  if (usedPercent !== undefined && Number.isFinite(usedPercent) && usedPercent >= 0 && usedPercent <= 100) return usedPercent;
  const used = usedTokens != null && Number.isFinite(usedTokens) && usedTokens >= 0 ? usedTokens : null;
  const max = windowTokens != null && Number.isFinite(windowTokens) && windowTokens > 0 ? windowTokens : null;
  return used !== null && max !== null ? Math.min(100, (used / max) * 100) : null;
}

/** One line of the ring's panel: what it measures, its share and detail, and a thin bar under it. */
function MeterRow({ label, value, percent, bar }: { label: string; value: (string | null | undefined)[]; percent: number; bar: string }) {
  return <div>
    <div className="flex items-baseline justify-between gap-3"><span>{label}</span><span className="tabular-nums text-muted-foreground">{value.filter(Boolean).join(" · ")}</span></div>
    <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label={bar} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percent)}>
      <div className="h-full rounded-full" style={{ width: `${percent}%`, backgroundColor: percent > 90 ? "var(--destructive)" : "var(--primary)" }} />
    </div>
  </div>;
}

/** The composer row's context ring: a 16px ring and its number, and nothing at all while unreported
 *  (a hollow ring said nothing; Compact stays one Commands row away). */
export function WorkbenchContextMeter({ reportedPercent, usedTokens, maxTokens, rateLimits, onCompact, compactDisabled, open: controlledOpen, onOpenChange }: {
  reportedPercent?: number;
  usedTokens: number | null;
  maxTokens: number | null;
  /** The plan windows the agent reported (5-hour, weekly), drawn under the context; none, no rows. */
  rateLimits?: SessionTelemetry["rateLimits"];
  onCompact?: () => void;
  compactDisabled?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = controlledOpen ?? localOpen;
  const anchorRef = useRef<HTMLButtonElement>(null);
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  };
  const used = usedTokens !== null && Number.isFinite(usedTokens) && usedTokens >= 0 ? usedTokens : null;
  const max = maxTokens !== null && Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : null;
  const percentage = contextPercent({ usedPercent: reportedPercent, usedTokens: used, windowTokens: max });
  if (percentage === null) return null;
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference - (percentage / 100) * circumference;
  const label = `Context window ${Math.round(percentage)}% used`;
  const usageColor = percentage > 90 ? "var(--destructive)" : "var(--primary)";
  const size = used !== null ? `${formatContextTokens(used)}${max !== null ? ` / ${formatContextTokens(max)}` : ""}` : max !== null ? `${formatContextTokens(max)} window` : null;

  return <div className="workbench-context relative">
    <button ref={anchorRef} type="button" className="composer-quiet hit-area gap-1.5" aria-label={label} title={label} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
      <svg viewBox="0 0 24 24" width={16} height={16} className="-rotate-90" aria-hidden="true">
        <circle cx="12" cy="12" r={radius} fill="none" stroke="color-mix(in oklab, var(--muted-foreground) 24%, transparent)" strokeWidth="3" />
        <circle cx="12" cy="12" r={radius} fill="none" stroke={usageColor} strokeWidth="3" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={dashOffset} />
      </svg>
      <span className="workbench-context-number tabular-nums">{Math.round(percentage)}%</span>
    </button>
    <WorkbenchPopover open={open} onDismiss={() => setOpen(false)} anchorRef={anchorRef} label="Context window" className="w-72 [&>div:first-child]:pl-3 [&_h3]:text-subhead [&>div:last-child]:p-3">
      <div className="space-y-2.5 text-footnote">
        <MeterRow label="Context" value={[`${Math.round(percentage)}%`, size]} percent={percentage} bar="Context window usage" />
        {limitRows(rateLimits).map((row) => <MeterRow key={row.key} label={row.label} value={[`${row.percent}%`, row.reset]} percent={row.percent} bar={`${row.label} used`} />)}
        {onCompact && <button type="button" disabled={compactDisabled} onClick={() => { setOpen(false); onCompact(); }} className="hit-area mt-0.5 min-h-9 w-full rounded-lg bg-primary/10 px-3 text-footnote font-medium text-primary hover:bg-primary/20 disabled:opacity-50">Compact context</button>}
      </div>
    </WorkbenchPopover>
  </div>;
}
