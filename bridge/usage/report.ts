import type {
  UsageAccount, UsageAgent, UsageAmount, UsageDay, UsageLimits, UsageOn, UsagePeriod, UsagePeriodKey, UsageRow, UsageScan, UsageWeek,
} from "../types.ts";
import type { AccountsFile } from "./scan-main.ts";
import type { Totals } from "./scan.ts";
import { costOf, modelLabel, PRICES_CHECKED } from "./prices.ts";

// Totals on disk → the view's numbers. Runs in the bridge per request: a year of totals is a few
// thousand keys, so this is a millisecond loop over parsed JSON, and nothing stays in memory after.

const DAY_MS = 86_400_000;
const MAP_DAYS = 371; // 53 weeks
const WEEKS = 12;
const TOP_PROJECTS = 8;

export const localDate = (ms: number): string => {
  const t = new Date(ms);
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, "0")}-${String(t.getDate()).padStart(2, "0")}`;
};
/** Noon of a local date, so adding days never trips over a DST hour. */
const noon = (date: string) => new Date(`${date}T12:00:00`).getTime();
const addDays = (date: string, n: number) => localDate(noon(date) + n * DAY_MS);
const mondayOf = (date: string) => addDays(date, -((new Date(noon(date)).getDay() + 6) % 7));
const cents = (n: number) => Math.round(n * 100) / 100;

type Acc = { cost: number; tokens: number; input: number; output: number; cacheWrite: number; cacheRead: number };
const zero = (): Acc => ({ cost: 0, tokens: 0, input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
const amount = (a: { cost: number; tokens: number }): UsageAmount => ({ cost: cents(a.cost), tokens: a.tokens });

export interface ReportInput {
  totals: Totals;
  accounts: AccountsFile | undefined;
  splitByAccount: boolean;
  scan: UsageScan;
  now: number;
  /** Only honoured with Split by account on. */
  account?: string;
}

export function buildReport(input: ReportInput): UsageOn {
  const { totals, now } = input;
  const today = localDate(now);
  const filter = input.splitByAccount ? input.account : undefined;
  const from: Record<UsagePeriodKey, string> = { today, week: mondayOf(today), month: `${today.slice(0, 8)}01`, all: "" };
  const mapFrom = addDays(today, -(MAP_DAYS - 1));
  const weeksFrom = addDays(mondayOf(today), -7 * (WEEKS - 1));
  const unpriced = new Set<string>();

  const periods = new Map<UsagePeriodKey, { sum: Acc; agents: Map<UsageAgent, Acc>; models: Map<string, Acc & { agent: UsageAgent }>; repos: Map<string, Acc & { agent: UsageAgent }> }>();
  for (const key of ["today", "week", "month", "all"] as const) periods.set(key, { sum: zero(), agents: new Map(), models: new Map(), repos: new Map() });
  const days = new Map<string, { sum: Acc; agents: Map<UsageAgent, Acc>; accounts: Map<string, Acc> }>();
  const weeks = new Map<string, Map<UsageAgent, Acc>>();
  const monthByAccount = new Map<string, Acc>();
  const bump = (a: Acc, cost: number, v: number[]) => {
    a.cost += cost; a.input += v[1]!; a.output += v[2]!; a.cacheWrite += v[3]! + v[4]!; a.cacheRead += v[5]!;
    a.tokens += v[1]! + v[2]! + v[3]! + v[4]! + v[5]!;
  };
  const at = <K, V>(m: Map<K, V>, k: K, make: () => V) => m.get(k) ?? (m.set(k, make()), m.get(k)!);

  for (const [day, keys] of Object.entries(totals.days)) {
    if (day > today) continue;
    for (const [key, v] of Object.entries(keys)) {
      const [agent, account, model, repo] = key.split("|") as [UsageAgent, string, string, string];
      const cost = costOf(model, v);
      if (cost === undefined) unpriced.add(model);
      const c = cost ?? 0;
      if (day >= from.month) bump(at(monthByAccount, account, zero), c, v);
      if (filter && account !== filter) continue;
      for (const [p, start] of Object.entries(from) as [UsagePeriodKey, string][]) {
        if (day < start) continue;
        const per = periods.get(p)!;
        bump(per.sum, c, v);
        bump(at(per.agents, agent, zero), c, v);
        bump(at(per.models, `${agent}|${model.replace(/\+long$/, "")}`, () => ({ ...zero(), agent })), c, v);
        bump(at(per.repos, `${agent === "codex" && repo === "?" ? "codex" : repo}`, () => ({ ...zero(), agent })), c, v);
      }
      if (day >= mapFrom) {
        const d = at(days, day, () => ({ sum: zero(), agents: new Map(), accounts: new Map() }));
        bump(d.sum, c, v);
        bump(at(d.agents, agent, zero), c, v);
        bump(at(d.accounts, account, zero), c, v);
      }
      if (day >= weeksFrom) bump(at(at(weeks, mondayOf(day), () => new Map<UsageAgent, Acc>()), agent, zero), c, v);
    }
  }

  const byCost = <T extends { cost: number }>(a: T, b: T) => b.cost - a.cost;
  const agentsOf = (m: Map<UsageAgent, Acc>) => Object.fromEntries([...m].map(([k, a]) => [k, amount(a)])) as Partial<Record<UsageAgent, UsageAmount>>;
  const periodList: UsagePeriod[] = (["today", "week", "month", "all"] as const).map((key) => {
    const p = periods.get(key)!;
    const projects = [...p.repos].map(([id, a]): UsageRow => ({ id, label: id === "codex" ? "Codex" : totals.repos[id] ?? id.replace(/~[0-9a-f]+$/, ""), agent: a.agent, ...amount(a) })).sort(byCost);
    const rest = projects.slice(TOP_PROJECTS);
    return {
      key, from: from[key] || (totals.logsFrom ?? today),
      ...amount(p.sum), input: p.sum.input, output: p.sum.output, cacheWrite: p.sum.cacheWrite, cacheRead: p.sum.cacheRead,
      agents: agentsOf(p.agents),
      byModel: [...p.models].map(([id, a]): UsageRow => ({ id: id.slice(id.indexOf("|") + 1), label: modelLabel(id.slice(id.indexOf("|") + 1)), agent: a.agent, ...amount(a) })).sort(byCost),
      byProject: rest.length
        ? [...projects.slice(0, TOP_PROJECTS), { id: "_rest", label: `${rest.length} more`, agent: rest[0]!.agent, cost: cents(rest.reduce((s, r) => s + r.cost, 0)), tokens: rest.reduce((s, r) => s + r.tokens, 0) }]
        : projects,
    };
  });

  const dayList: UsageDay[] = [...days].sort(([a], [b]) => (a < b ? -1 : 1)).map(([date, d]) => ({
    date, ...amount(d.sum), agents: agentsOf(d.agents),
    ...(input.splitByAccount && !filter ? { accounts: [...d.accounts].map(([id, a]) => ({ id, ...amount(a) })).sort(byCost) } : {}),
  }));
  const weekList: UsageWeek[] = [];
  for (let i = 0; i < WEEKS; i++) {
    const start = addDays(weeksFrom, 7 * i);
    weekList.push({ start, agents: agentsOf(weeks.get(start) ?? new Map()) });
  }
  const quartiles = (values: number[]): [number, number, number] => {
    const s = values.filter((v) => v > 0).sort((a, b) => a - b);
    const q = (p: number) => (s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))]! : 0);
    return [q(0.25), q(0.5), q(0.75)];
  };

  const file = input.accounts;
  const accounts: UsageAccount[] = (file?.accounts ?? []).map((a) => ({
    id: a.id, agent: a.agent, label: a.label, source: a.source, active: a.active,
    ...(a.activeSince ? { activeSince: a.activeSince } : {}), ...(a.activeUntil ? { activeUntil: a.activeUntil } : {}),
    month: amount(monthByAccount.get(a.id) ?? zero()),
  })).sort((a, b) => (a.agent === b.agent ? b.month.cost - a.month.cost : a.agent === "claude" ? -1 : 1));
  const raw = file?.limits ?? [];
  const limits: UsageLimits[] = input.splitByAccount
    ? raw.map((l) => ({ ...l }))
    : (["claude", "codex"] as const).flatMap((agent) => {
      // Split off: the newest reading per agent, without saying whose it is.
      const newest = raw.filter((l) => l.agent === agent && l.source !== "hats" && l.source !== "claude-swap").sort((a, b) => b.observedAt - a.observedAt)[0];
      if (!newest) return [];
      const { account: _hidden, ...rest } = newest;
      return [rest];
    });

  return {
    on: true,
    splitByAccount: input.splitByAccount,
    scan: input.scan,
    timeZone: totals.tz,
    today,
    coverage: { ...(totals.logsFrom ? { logsFrom: totals.logsFrom } : {}), trackedFrom: totals.trackedFrom },
    ...(filter ? { account: filter } : {}),
    periods: periodList,
    days: dayList,
    weeks: weekList,
    levels: { cost: quartiles(dayList.map((d) => d.cost)), tokens: quartiles(dayList.map((d) => d.tokens)) },
    accounts: input.splitByAccount ? accounts : [],
    limits,
    prices: { checked: PRICES_CHECKED, unpriced: [...unpriced].sort() },
  };
}
