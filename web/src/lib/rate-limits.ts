import { resetTime } from "@/lib/usage-limit";
import type { SessionTelemetry } from "@/lib/types";

type RateLimit = NonNullable<SessionTelemetry["rateLimits"]>[number];

export interface LimitRow {
  key: string;
  /** "5-hour limit", "Weekly limit". */
  label: string;
  /** 0 to 100 as reported; absent once the window it was read in has reset. */
  percent?: number;
  /** "resets 6:40 PM", "resets Mon 9:00 AM", or "Window not started" once it passed; absent when the agent named no reset. */
  detail?: string;
}

/** A plan window by its length: "5-hour", "Weekly", "2-day", "90-minute". */
export function windowLength(minutes: number): string {
  if (minutes === 10080) return "Weekly";
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  return minutes % 60 === 0 ? `${minutes / 60}-hour` : `${minutes}-minute`;
}

/** The plan windows the agent reported for this session, shortest first; none when it reported none. */
export function limitRows(limits: SessionTelemetry["rateLimits"], now = Date.now()): LimitRow[] {
  return [...(limits ?? [])]
    .sort((a, b) => (a.windowMinutes ?? Infinity) - (b.windowMinutes ?? Infinity))
    .map((limit: RateLimit) => {
      const label = limit.windowMinutes ? `${windowLength(limit.windowMinutes)} limit` : "Usage limit";
      const resets = limit.resetsAt === undefined ? undefined : limit.resetsAt * 1000;
      // The windows are the account's: a reading from before the reset says nothing about the new one.
      if (resets !== undefined && resets <= now) return { key: limit.name, label, detail: "Window not started" };
      return {
        key: limit.name, label, percent: Math.min(100, Math.max(0, limit.usedPercent)),
        ...(resets === undefined ? {} : { detail: `resets ${resetTime(resets, now)}` }),
      };
    });
}
