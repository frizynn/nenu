import { useRef, useState } from "react";
import { WorkbenchPopover } from "@/components/ui/workbench-popover";

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

/** The composer row's context ring: a 16px ring and its number, and nothing at all while unreported
 *  (a hollow ring said nothing; Compact stays one Commands row away). */
export function WorkbenchContextMeter({ reportedPercent, usedTokens, maxTokens, onCompact, compactDisabled, open: controlledOpen, onOpenChange }: {
  reportedPercent?: number;
  usedTokens: number | null;
  maxTokens: number | null;
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

  return <div className="relative">
    <button ref={anchorRef} type="button" className="composer-quiet hit-area gap-1.5" aria-label={label} title={label} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(!open)}>
      <svg viewBox="0 0 24 24" width={16} height={16} className="-rotate-90" aria-hidden="true">
        <circle cx="12" cy="12" r={radius} fill="none" stroke="color-mix(in oklab, var(--muted-foreground) 24%, transparent)" strokeWidth="3" />
        <circle cx="12" cy="12" r={radius} fill="none" stroke={usageColor} strokeWidth="3" strokeLinecap="round" strokeDasharray={circumference} strokeDashoffset={dashOffset} />
      </svg>
      <span className="tabular-nums">{Math.round(percentage)}%</span>
    </button>
    <WorkbenchPopover open={open} onDismiss={() => setOpen(false)} anchorRef={anchorRef} label="Context window">
      <div className="space-y-3 text-sm">
        {(used !== null || max !== null) && <div className="flex justify-between gap-4"><span>{used !== null ? "Tokens used" : "Context window"}</span><span className="tabular-nums">{used !== null ? formatContextTokens(used) : formatContextTokens(max)}{used !== null && max !== null ? ` / ${formatContextTokens(max)}` : ""}</span></div>}
        <div className="h-1.5 overflow-hidden rounded-full bg-muted" role="progressbar" aria-label="Context window usage" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(percentage)}><div className="h-full rounded-full" style={{ width: `${percentage}%`, backgroundColor: usageColor }} /></div>
        {onCompact && <div className="border-t border-border pt-3">
          <p className="mb-2 text-xs text-muted-foreground">Summarize this session to make room for the next messages.</p>
          <button type="button" disabled={compactDisabled} onClick={() => { setOpen(false); onCompact(); }} className="min-h-11 w-full rounded-lg bg-primary/10 px-3 text-sm font-medium text-primary hover:bg-primary/20 disabled:opacity-50">Compact context</button>
        </div>}
      </div>
    </WorkbenchPopover>
  </div>;
}
