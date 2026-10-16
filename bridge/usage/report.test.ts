import { describe, expect, test } from "bun:test";
import { costOf, modelLabel } from "./prices.ts";
import { buildReport } from "./report.ts";
import type { AccountsFile } from "./scan-main.ts";
import type { Totals } from "./scan.ts";

// [rows, input, output, cacheWrite5m, cacheWrite1h, cacheRead, reasoning]
const M = 1_000_000;
const NOW = new Date("2026-01-14T15:00:00").getTime(); // a Wednesday

const totals: Totals = {
  v: 1, tz: "UTC", trackedFrom: "2026-01-14", logsFrom: "2025-12-20",
  days: {
    "2026-01-14": { "claude|claude:aaaaaaaaaaaaaaaa|claude-opus-5-5|app~111111": [3, M, M, 0, 0, M, 0] },
    "2026-01-12": { "codex|codex:cccccccccccccccc|gpt-6.1-sol|app~111111": [2, M, M, 0, 0, M, 0] },
    "2026-01-05": { "claude|claude:bbbbbbbbbbbbbbbb|claude-opus-5-5+fast|web~222222": [1, M, 0, 0, 0, 0, 0] },
    "2025-12-20": { "claude|claude:unassigned|mystery-model|web~222222": [1, M, 0, 0, 0, 0, 0] },
  },
  repos: { "app~111111": "app", "web~222222": "web" },
  codexLimits: {},
};
const accounts: AccountsFile = {
  v: 1, at: NOW,
  accounts: [
    { id: "claude:aaaaaaaaaaaaaaaa", agent: "claude", label: "Claude 1", source: "observed", active: true, activeSince: NOW - 3_600_000 },
    { id: "claude:bbbbbbbbbbbbbbbb", agent: "claude", label: "Claude 2", source: "observed", active: false },
    { id: "codex:cccccccccccccccc", agent: "codex", label: "ChatGPT", source: "codex", active: true },
  ],
  limits: [
    { agent: "claude", account: "claude:aaaaaaaaaaaaaaaa", observedAt: NOW - 60_000, source: "statusline", windows: [{ name: "five_hour", windowMinutes: 300, usedPercent: 10 }] },
    { agent: "claude", account: "claude:bbbbbbbbbbbbbbbb", observedAt: NOW - 600_000, source: "statusline", windows: [{ name: "five_hour", windowMinutes: 300, usedPercent: 50 }] },
  ],
};
const scan = { state: "idle" as const, firstPass: false, scannedAt: NOW };

describe("prices", () => {
  test("list prices per million, fast mode doubled, dated ids priced as their family", () => {
    expect(costOf("claude-opus-5-5", [1, M, M, M, M, M, 0])).toBeCloseTo(4 + 20 + 5 + 8 + 0.2);
    expect(costOf("claude-opus-5-5+fast", [1, M, M, 0, 0, 0, 0])).toBeCloseTo(2 * (4 + 20));
    expect(costOf("claude-haiku-4-5-20251001", [1, M, 0, 0, 0, 0, 0])).toBeCloseTo(1);
    expect(costOf("claude-haiku-5-5+long", [1, M, 0, 0, 0, 0, 0])).toBeCloseTo(0.5);
    expect(costOf("mystery-model", [1, M, 0, 0, 0, 0, 0])).toBeUndefined();
    expect([modelLabel("claude-opus-5-5"), modelLabel("claude-opus-5-5+fast"), modelLabel("gpt-6.1-sol"), modelLabel("claude-haiku-4-5-20251001")])
      .toEqual(["Opus 5.5", "Opus 5.5 · fast", "GPT-6.1 Sol", "Haiku 4.5"]);
  });
});

describe("the view's numbers", () => {
  const report = buildReport({ totals, accounts, splitByAccount: true, scan, now: NOW });
  const period = (key: string) => report.periods.find((p) => p.key === key)!;

  test("periods start today, on Monday and on the 1st", () => {
    expect(report.periods.map((p) => [p.key, p.from])).toEqual([["today", "2026-01-14"], ["week", "2026-01-12"], ["month", "2026-01-01"], ["all", "2025-12-20"]]);
    expect(period("today")).toMatchObject({ cost: 24.2, tokens: 3 * M, agents: { claude: { cost: 24.2, tokens: 3 * M } } });
    expect(period("week").agents.codex).toEqual({ cost: 12.1, tokens: 3 * M });
    expect(period("month").cost).toBe(44.3);
  });

  test("an unpriced model is counted in tokens and named", () => {
    expect(period("all").tokens).toBe(3 * M + 3 * M + M + M);
    expect(report.prices.unpriced).toEqual(["mystery-model"]);
  });

  test("models and projects by cost, worktrees already folded into their repo", () => {
    expect(period("month").byModel.map((r) => [r.label, r.cost])).toEqual([["Opus 5.5", 24.2], ["GPT-6.1 Sol", 12.1], ["Opus 5.5 · fast", 8]]);
    expect(period("month").byProject.map((r) => [r.label, r.cost])).toEqual([["app", 36.3], ["web", 8]]);
  });

  test("days carry their accounts with Split on, weeks their agents, levels the quartiles", () => {
    expect(report.days.map((d) => d.date)).toEqual(["2025-12-20", "2026-01-05", "2026-01-12", "2026-01-14"]);
    expect(report.days.at(-1)!.accounts).toEqual([{ id: "claude:aaaaaaaaaaaaaaaa", cost: 24.2, tokens: 3 * M }]);
    expect(report.weeks).toHaveLength(12);
    expect(report.weeks.at(-1)).toEqual({ start: "2026-01-12", agents: { claude: { cost: 24.2, tokens: 3 * M }, codex: { cost: 12.1, tokens: 3 * M } } });
    expect(report.levels.cost).toEqual([8, 12.1, 24.2]);
  });

  test("accounts with this month's spend, active first by agent", () => {
    expect(report.accounts.map((a) => [a.label, a.month.cost, a.active])).toEqual([["Claude 1", 24.2, true], ["Claude 2", 8, false], ["ChatGPT", 12.1, true]]);
  });

  test("an account filter narrows every number but the account list", () => {
    const one = buildReport({ totals, accounts, splitByAccount: true, scan, now: NOW, account: "claude:bbbbbbbbbbbbbbbb" });
    expect(one.account).toBe("claude:bbbbbbbbbbbbbbbb");
    expect(one.periods.find((p) => p.key === "month")!.cost).toBe(8);
    expect(one.days.map((d) => d.date)).toEqual(["2026-01-05"]);
    expect(one.accounts).toHaveLength(3);
  });

  test("Split off: no accounts, no filter, and only the newest limit per agent without its owner", () => {
    const off = buildReport({ totals, accounts, splitByAccount: false, scan, now: NOW, account: "claude:bbbbbbbbbbbbbbbb" });
    expect(off.account).toBeUndefined();
    expect(off.accounts).toEqual([]);
    expect(off.days.some((d) => d.accounts)).toBe(false);
    expect(off.limits).toEqual([{ agent: "claude", observedAt: NOW - 60_000, source: "statusline", windows: [{ name: "five_hour", windowMinutes: 300, usedPercent: 10 }] }]);
  });
});
