import { StatusDot } from "@/components/status-badge";
import { clockTime } from "@/lib/format";
import type { ActivityBucket, HerdCounts } from "@/lib/home-stats";
import { TRIAGE_STATUS, type TriageKey } from "@/lib/triage";
import { cn } from "@/lib/utils";

const HERD_LEGEND: ReadonlyArray<{ key: TriageKey; label: string; fill: string }> = [
  { key: "needs", label: "Needs you", fill: "bg-status-blocked" },
  { key: "ready", label: "Ready", fill: "bg-status-done" },
  { key: "working", label: "Working", fill: "bg-status-working" },
  // Resting agents stay quiet as a fill, the way StatusDot draws them hollow.
  { key: "recent", label: "Idle", fill: "bg-status-idle/35" },
];

/** Agents by state: the count, one stacked bar, and a legend that names every segment. */
export function HerdCard({ counts, workspaces }: { counts: HerdCounts; workspaces: number }) {
  const parts = HERD_LEGEND.filter((part) => counts[part.key] > 0);
  const described = HERD_LEGEND.map((part) => `${counts[part.key]} ${part.label.toLowerCase()}`).join(", ");
  return (
    <section aria-labelledby="home-herd" className="home-card">
      <div className="home-card-head">
        <h2 id="home-herd">Agents</h2>
        <span>{workspaces} {workspaces === 1 ? "workspace" : "workspaces"}</span>
      </div>
      <p className="mt-3 text-[32px] leading-none font-semibold tracking-tight tabular-nums">{counts.total}</p>
      <div role="img" aria-label={counts.total ? described : "No agents running"} className="mt-4 flex h-2 gap-0.5">
        {parts.length ? parts.map((part) => (
          <span key={part.key} className={cn("h-full rounded-full", part.fill)} style={{ flexGrow: counts[part.key] }} />
        )) : <span className="h-full flex-1 rounded-full bg-muted" />}
      </div>
      <ul className="mt-4 flex flex-wrap gap-x-5 gap-y-2">
        {HERD_LEGEND.map((part) => (
          <li key={part.key} className="flex items-center gap-2 text-[13px]">
            <StatusDot status={TRIAGE_STATUS[part.key]} surface="bg-card" className="size-2" />
            <span className="text-muted-foreground">{part.label}</span>
            <span className="font-medium tabular-nums">{counts[part.key]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

const CHART_H = 72;

/**
 * When agents last changed state, by hour. One series, so no legend: the heading names it and the
 * caption says exactly what is counted, because the snapshot keeps one timestamp per agent, not a log.
 */
export function ActivityCard({ buckets }: { buckets: ActivityBucket[] }) {
  const peak = Math.max(0, ...buckets.map((bucket) => bucket.count));
  const width = 100 / buckets.length;
  const range = (bucket: ActivityBucket) => `${clockTime(bucket.start)}–${clockTime(bucket.start + 3_600_000)}`;
  const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0);
  return (
    <section aria-labelledby="home-activity" className="home-card">
      <div className="home-card-head">
        <h2 id="home-activity">Activity</h2>
        <span>last {buckets.length} h</span>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        {total ? "When each agent last changed state" : `No agent changed state in the last ${buckets.length} hours`}
      </p>
      <svg role="img" aria-label={buckets.filter((b) => b.count).map((b) => `${range(b)}: ${b.count}`).join("; ") || "No activity"}
        viewBox={`0 0 100 ${CHART_H}`} preserveAspectRatio="none" className="mt-3 block h-[72px] w-full overflow-visible">
        {buckets.map((bucket, index) => {
          const h = peak ? Math.max(2, (bucket.count / peak) * (CHART_H - 4)) : 0;
          return (
            <g key={bucket.start}>
              <title>{`${range(bucket)} · ${bucket.count} ${bucket.count === 1 ? "agent" : "agents"}`}</title>
              <rect x={index * width} y={0} width={width} height={CHART_H} fill="transparent" />
              {bucket.count > 0
                ? <rect className="home-bar" x={index * width + width * 0.18} y={CHART_H - h} width={width * 0.64} height={h} rx={0.8} />
                : <rect className="home-bar-empty" x={index * width + width * 0.18} y={CHART_H - 1} width={width * 0.64} height={1} />}
            </g>
          );
        })}
      </svg>
      <div aria-hidden className="mt-2 flex justify-between text-[11px] text-muted-foreground tabular-nums">
        <span>{clockTime(buckets[0]!.start)}</span>
        {peak > 0 && <span>peak {peak}</span>}
        <span>now</span>
      </div>
    </section>
  );
}
