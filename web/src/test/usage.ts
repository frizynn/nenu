import type { UsageAccount, UsageDay, UsageLimits, UsageOn, UsagePeriod } from "@/lib/types";

// A synthetic GET /api/usage for the usage tests: Wednesday 14 Oct 2026, logs from 1 Sep, two Claude
// accounts and one Codex account. Names and numbers are made up.

export const TODAY = "2026-10-14";
/** 14:00 on that day, UTC (the tests run in UTC). */
export const NOW = Date.parse("2026-10-14T14:00:00Z");

const amount = (cost: number, tokens: number) => ({ cost, tokens });

export const day = (date: string, cost: number, tokens: number, extra: Partial<UsageDay> = {}): UsageDay =>
  ({ date, cost, tokens, agents: { claude: amount(cost, tokens) }, ...extra });

export function period(key: UsagePeriod["key"], from: string, cost: number, tokens: number, extra: Partial<UsagePeriod> = {}): UsagePeriod {
  return {
    key, from, cost, tokens, input: tokens / 10, output: tokens / 20, cacheWrite: tokens / 10, cacheRead: tokens * 0.75,
    agents: { claude: amount(cost * 0.9, tokens * 0.9), codex: amount(cost * 0.1, tokens * 0.1) },
    byModel: [
      { id: "claude-opus-5-5", label: "Opus 5.5", agent: "claude", ...amount(cost * 0.9, tokens * 0.9) },
      { id: "gpt-6.1-sol", label: "GPT-6.1 Sol", agent: "codex", ...amount(cost * 0.1, tokens * 0.1) },
    ],
    byProject: [
      { id: "checkout~1", label: "Checkout", agent: "claude", ...amount(cost * 0.6, tokens * 0.6) },
      { id: "docs~2", label: "Docs site", agent: "claude", ...amount(cost * 0.3, tokens * 0.3) },
      { id: "_rest", label: "3 other folders", agent: "claude", ...amount(cost * 0.1, tokens * 0.1) },
    ],
    ...extra,
  };
}

export const ACCOUNTS: UsageAccount[] = [
  { id: "claude:aaaaaaaaaaaaaaaa", agent: "claude", label: "Studio", source: "observed", active: true, month: amount(300, 9e8) },
  { id: "claude:bbbbbbbbbbbbbbbb", agent: "claude", label: "Work", source: "observed", active: false, month: amount(150, 4e8) },
  { id: "codex:cccccccccccccccc", agent: "codex", label: "ChatGPT", source: "codex", active: true, month: amount(50, 1e8) },
  { id: "claude:unassigned", agent: "claude", label: "Unassigned", source: "none", active: false, month: amount(20, 5e7) },
];

const resets = (iso: string) => Date.parse(iso) / 1000;
export const LIMITS: UsageLimits[] = [
  { agent: "claude", account: ACCOUNTS[0]!.id, observedAt: NOW - 30_000, source: "statusline", windows: [
    { name: "five_hour", windowMinutes: 300, usedPercent: 10, resetsAt: resets("2026-10-14T17:40:00Z") },
  ] },
  { agent: "claude", account: ACCOUNTS[1]!.id, observedAt: NOW - 2 * 86_400_000, source: "statusline", windows: [
    { name: "five_hour", windowMinutes: 300, usedPercent: 40, resetsAt: resets("2026-10-12T15:00:00Z") },
    { name: "seven_day", windowMinutes: 10080, usedPercent: 9, resetsAt: resets("2026-10-20T21:00:00Z") },
  ] },
  { agent: "codex", account: ACCOUNTS[2]!.id, observedAt: NOW - 11 * 3_600_000, source: "codex", plan: "plus", windows: [
    { name: "seven_day", windowMinutes: 10080, usedPercent: 0, resetsAt: resets("2026-10-22T14:22:00Z") },
  ] },
];

export function usageOn(extra: Partial<UsageOn> = {}): UsageOn {
  return {
    on: true, splitByAccount: false,
    scan: { state: "idle", firstPass: false, scannedAt: NOW - 60_000 },
    timeZone: "UTC", today: TODAY,
    coverage: { logsFrom: "2026-09-01", trackedFrom: "2026-10-01" },
    periods: [
      period("today", TODAY, 79, 2.5e8),
      period("week", "2026-10-12", 9574, 2.83e10),
      period("month", "2026-10-01", 16921, 5.45e10),
      period("all", "2026-09-01", 20000, 6e10),
    ],
    days: [
      day("2026-09-01", 50, 1e8),
      day("2026-10-05", 400, 1e9),
      day("2026-10-12", 1200, 3e9),
      day("2026-10-13", 2760, 8.9e9, { agents: { claude: amount(2700, 8.7e9), codex: amount(60, 2e8) } }),
      day(TODAY, 79, 2.5e8),
    ],
    weeks: Array.from({ length: 12 }, (_, i) => {
      const start = new Date(Date.UTC(2026, 6, 27 + i * 7)).toISOString().slice(0, 10);
      return { start, agents: i < 6 ? {} : { claude: amount(1000 * (i - 5), 1e9), codex: amount(100, 1e8) } };
    }),
    levels: { cost: [79, 400, 1200], tokens: [2.5e8, 1e9, 3e9] },
    accounts: [], limits: [{ ...LIMITS[0]!, account: undefined }, { ...LIMITS[2]!, account: undefined }],
    prices: { checked: "2026-10-16", unpriced: [] },
    ...extra,
  };
}

/** The same data with Split by account on. */
export const usageSplit = (extra: Partial<UsageOn> = {}) => usageOn({ splitByAccount: true, accounts: ACCOUNTS, limits: LIMITS, ...extra });
