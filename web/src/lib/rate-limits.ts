import { resetTime } from "@/lib/usage-limit";
import type { SessionTelemetry } from "@/lib/types";

type RateLimit = NonNullable<SessionTelemetry["rateLimits"]>[number];

export interface LimitRow {
  key: string;
  /** "5-hour limit", "Weekly limit". */
  label: string;
  /** 0 to 100, rounded; 0 once the window it was read in has reset. */
  percent: number;
  /** "resets 6:40 PM", "resets Mon 9:00 AM", "reset" once it passed; absent when the agent named no reset. */
  reset?: string;
}

function limitLabel(limit: RateLimit): string {
  const minutes = limit.windowMinutes;
  if (!minutes) return "Usage limit";
  if (minutes === 10080) return "Weekly limit";
  return minutes % 1440 ? `${Math.round(minutes / 60)}-hour limit` : `${minutes / 1440}-day limit`;
}

/** The plan windows the agent reported for this session, shortest first; none when it reported none. */
export function limitRows(limits: SessionTelemetry["rateLimits"], now = Date.now()): LimitRow[] {
  return [...(limits ?? [])]
    .sort((a, b) => (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity))
    .map((limit) => {
      const resets = limit.resetsAt === undefined ? undefined : limit.resetsAt * 1000;
      // A reading from a window that has since reset says nothing about the new one.
      const over = resets !== undefined && resets <= now;
      return {
        key: limit.name,
        label: limitLabel(limit),
        percent: over ? 0 : Math.round(Math.min(100, Math.max(0, limit.usedPercent))),
        ...(resets === undefined ? {} : { reset: over ? "reset" : `resets ${resetTime(resets, now)}` }),
      };
    });
}
