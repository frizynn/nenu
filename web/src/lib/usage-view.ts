import { timeAgo } from "./format";
import type { UsageAccount, UsageAgent, UsageDay, UsageLimitWindow, UsageLimits, UsageOn } from "./types";
import { realAccounts, usd } from "./usage";

// The usage page's model: the activity map's 371 squares, the limit windows as the page words them,
// and the numbers' formats. Pure, and loaded with the page only.

const compact = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });
/** 250M, 28.3B, 1.2K. */
export const tokens = (n: number) => compact.format(n);
/** A phone's stat: $16.9k from ten thousand dollars up. */
export const usdShort = (n: number) => (n >= 10_000 ? `$${compact.format(n).replace("K", "k")}` : usd(n));

export const AGENT_NAME: Record<UsageAgent, string> = { claude: "Claude Code", codex: "Codex" };
/** Each agent's colour on the page (routes/usage.css): Claude Code orange, Codex teal. */
export const AGENT_DOT: Record<UsageAgent, string> = { claude: "usage-claude", codex: "usage-codex" };

// ── Days ───────────────────────────────────────────────────────────────────────────────────────
// Days are the bridge's calendar dates (cut in its zone), so they are counted as UTC days here and
// never shifted into the phone's zone.

const DAY_MS = 86_400_000;
const dateOf = (n: number) => new Date(n * DAY_MS).toISOString().slice(0, 10);
// Month and weekday names are spelled here: Intl's en-GB writes "Sept" in some engines and "Sep" in others.
const MONTHS = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split(" ");
const WEEKDAYS = "Sun Mon Tue Wed Thu Fri Sat".split(" ");
const utc = (date: string) => new Date(`${date}T00:00:00Z`);
const dayNumber = (date: string) => utc(date).getTime() / DAY_MS;
/** "Wed 14 Oct". */
export const dayName = (date: string, d = utc(date)) => `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
/** "1 Sep". */
export const shortDate = (date: string, d = utc(date)) => `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
/** "Oct 12", a week's Monday under its bar. */
export const weekName = (date: string, d = utc(date)) => `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
/** "October", the month a period starts in. */
export const monthName = (date: string) => utc(date).toLocaleString("en-US", { month: "long", timeZone: "UTC" });

export type Level = 0 | 1 | 2 | 3 | 4;
const level = (v: number, [a, b, c]: [number, number, number]): Level => (v <= 0 ? 0 : v <= a ? 1 : v <= b ? 2 : v <= c ? 3 : 4);

export interface MapCell {
  date: string;
  /** The day's usage, when it had any. */
  day?: UsageDay;
  /** By cost, then by tokens. */
  levels: [Level, Level];
  /** Before the oldest log: unknown, not zero. */
  striped: boolean;
  /** Date and amount, as a screen reader says the square. */
  label: string;
}

export interface MapModel {
  /** 53 Monday-first weeks, oldest first, ending in today's week; null after today. */
  cells: Array<MapCell | null>;
  /** The columns where a month starts, with its name. */
  months: Array<{ col: number; label: string }>;
  /** Today's square. */
  today: number;
  activeDays: number;
  busiest?: string;
  /** The oldest log's day, written "1 Sep". */
  since?: string;
  striped: boolean;
}

export const WEEKS = 53;

export function buildMap({ days, today, levels, coverage }: Pick<UsageOn, "days" | "today" | "levels" | "coverage">): MapModel {
  const end = dayNumber(today);
  const monday = end - ((new Date(end * DAY_MS).getUTCDay() + 6) % 7);
  const first = monday - (WEEKS - 1) * 7;
  const byDate = new Map(days.map((d) => [d.date, d]));
  const logsFrom = coverage.logsFrom;
  let busiest: UsageDay | undefined;
  let activeDays = 0;
  let striped = false;
  const cells: Array<MapCell | null> = [];
  for (let n = first; n < first + WEEKS * 7; n++) {
    if (n > end) {
      cells.push(null);
      continue;
    }
    const date = dateOf(n);
    const day = byDate.get(date);
    const gone = !day && logsFrom !== undefined && date < logsFrom;
    striped ||= gone;
    if (day && (day.cost > 0 || day.tokens > 0)) {
      activeDays++;
      if (!busiest || day.cost > busiest.cost) busiest = day;
    }
    const amount = gone ? "no logs left" : day && (day.cost > 0 || day.tokens > 0) ? `${usd(day.cost)}, ${tokens(day.tokens)} tokens` : "no usage";
    cells.push({
      date, day, striped: gone,
      levels: [level(day?.cost ?? 0, levels.cost), level(day?.tokens ?? 0, levels.tokens)],
      label: `${dayName(date)} ${date.slice(0, 4)}: ${amount}`,
    });
  }
  const months: MapModel["months"] = [];
  for (let col = 0; col < WEEKS; col++) {
    const date = dateOf(first + col * 7);
    if (col > 0 && date.slice(5, 7) === dateOf(first + (col - 1) * 7).slice(5, 7)) continue;
    months.push({ col, label: MONTHS[Number(date.slice(5, 7)) - 1]! });
  }
  // The first column's month is named only when it has room before the next one.
  if (months.length > 1 && months[1]!.col - months[0]!.col < 3) months.shift();
  return { cells, months, today: end - first, activeDays, busiest: busiest?.date, since: logsFrom && shortDate(logsFrom), striped };
}

// ── Limits ─────────────────────────────────────────────────────────────────────────────────────

export interface WindowView {
  name: string;
  pct: number;
  /** When it resets and how old the reading is. */
  detail: string;
  /** Claude Code had not reported this window yet. */
  missing?: boolean;
}

const WINDOW_NAME: Record<UsageLimitWindow["name"], string> = { five_hour: "5-hour", seven_day: "Weekly", other: "" };
const windowName = (w: UsageLimitWindow) => WINDOW_NAME[w.name] || (w.windowMinutes % 1440 ? `${Math.round(w.windowMinutes / 60)}-hour` : `${w.windowMinutes / 1440}-day`);

const two = (n: number) => String(n).padStart(2, "0");
/** "17:40", or "Thu 22 Oct, 14:22" on another day, in this device's zone. */
function resetTime(ms: number, now: number): string {
  const d = new Date(ms);
  const time = `${two(d.getHours())}:${two(d.getMinutes())}`;
  return d.toDateString() === new Date(now).toDateString() ? time : `${WEEKDAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${time}`;
}

export function windowView(w: UsageLimitWindow, observedAt: number, now: number): WindowView {
  const seen = now - observedAt < 120_000 ? "now" : `seen ${timeAgo(observedAt, now)}`;
  const resets = w.resetsAt === undefined ? undefined : w.resetsAt * 1000;
  // A window that reset since the reading starts again with the next message.
  if (resets === undefined || resets <= now) return { name: windowName(w), pct: 0, detail: "Window not started" };
  const soon = resets - now < 3_600_000 ? ` · in ${Math.ceil((resets - now) / 60_000)} min` : "";
  return { name: windowName(w), pct: Math.round(w.usedPercent), detail: `Resets ${resetTime(resets, now)}${soon} · ${seen}` };
}

export interface LimitBlock {
  key: string;
  agent: UsageAgent;
  title: string;
  active: boolean;
  plan?: string;
  windows: WindowView[];
  /** Said when a window is at 90 % or more. */
  alert?: string;
}

const accountTitle = (agent: UsageAgent, account?: UsageAccount) => (account ? `${AGENT_NAME[agent]} · ${account.label}` : AGENT_NAME[agent]);
/** The window that binds first: the fullest. */
const binding = (views: WindowView[]) => views.reduce<WindowView | undefined>((a, v) => (!a || v.pct > a.pct ? v : a), undefined);

function views(l: UsageLimits, now: number): WindowView[] {
  const out = l.windows.map((w) => windowView(w, l.observedAt, now));
  if (l.agent === "claude" && !l.windows.some((w) => w.name === "seven_day")) {
    out.push({ name: "Weekly", pct: 0, detail: "Claude Code reports it after the next reply", missing: true });
  }
  return out;
}

/** The accounts other than those shown, of one agent, with the room each has: the most room first. */
function others(data: UsageOn, agent: UsageAgent, shown: Set<string>, now: number) {
  return realAccounts(data.accounts)
    .filter((a) => a.agent === agent && !shown.has(a.id))
    .map((account) => {
      const limits = data.limits.find((l) => l.account === account.id);
      const windows = limits ? views(limits, now).filter((v) => !v.missing) : [];
      return { account, windows, top: binding(windows) };
    })
    .sort((a, b) => (a.top?.pct ?? 101) - (b.top?.pct ?? 101));
}

/** The plan-limit blocks to draw: the accounts in use (or the one picked), each agent's newest reading with Split off. */
export function limitBlocks(data: UsageOn, scope: string | undefined, now: number): { blocks: LimitBlock[]; more: Array<{ agent: UsageAgent; count: number; best?: string }> } {
  const byId = new Map(data.accounts.map((a) => [a.id, a]));
  const shownLimits = scope
    ? data.limits.filter((l) => l.account === scope)
    : data.splitByAccount
      ? data.limits.filter((l) => l.account && byId.get(l.account)?.active)
      : data.limits;
  const shown = new Set(shownLimits.map((l) => l.account ?? ""));
  const blocks = [...shownLimits]
    .sort((a, b) => (a.agent === b.agent ? 0 : a.agent === "claude" ? -1 : 1))
    .map((l) => {
      const account = l.account ? byId.get(l.account) : undefined;
      const windows = views(l, now);
      const full = windows.find((v) => !v.missing && v.pct >= 90);
      let alert: string | undefined;
      if (full) {
        const room = data.splitByAccount ? others(data, l.agent, shown, now).find((o) => o.top && o.top.pct < 50) : undefined;
        alert = `Close to the ${full.name.toLowerCase()} limit.${room ? ` ${room.account.label} has room: ${room.windows.map((v) => `${v.name.toLowerCase()} ${v.pct}%`).join(", ")}.` : ""}`;
      }
      return {
        key: `${l.agent}:${l.account ?? ""}`, agent: l.agent, title: accountTitle(l.agent, account), active: Boolean(account?.active),
        plan: l.plan && l.plan[0]!.toUpperCase() + l.plan.slice(1), windows, alert,
      };
    });
  const more = scope || !data.splitByAccount ? [] : (["claude", "codex"] as const).flatMap((agent) => {
    const rest = others(data, agent, shown, now);
    const best = rest.find((o) => o.top);
    return rest.length ? [{ agent, count: rest.length, best: best?.top && `${best.account.label} ${best.top.name.toLowerCase()} ${best.top.pct}%` }] : [];
  });
  return { blocks, more };
}
