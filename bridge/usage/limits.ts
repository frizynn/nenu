import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { decodeClaudeStatusline } from "../claude-telemetry.ts";
import { UNASSIGNED, type AccountBook, type Harness } from "./accounts.ts";
import type { CodexLimits } from "./scan.ts";

// Plan limits per account, from what is already on disk: Nenu's status-line snapshots (Claude), the
// rollouts (Codex, collected by the scan), and, for accounts not in use, hats' `limits.json` or
// claude-swap's cache. Only percentages, reset times and when they were read; never a credential,
// never a usage endpoint.

export interface LimitWindow { name: "five_hour" | "seven_day" | "other"; windowMinutes: number; usedPercent: number; resetsAt?: number }
export interface AccountLimits {
  agent: Harness;
  account: string;
  observedAt: number;
  source: "statusline" | "codex" | "hats" | "claude-swap";
  plan?: string;
  windows: LimitWindow[];
}

const windowName = (minutes: number): LimitWindow["name"] => (minutes === 300 ? "five_hour" : minutes === 10080 ? "seven_day" : "other");
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
const pct = (v: unknown) => { const n = num(v); return n !== undefined && n <= 100 ? n : undefined; };

/** Snapshots read are those written in the last 8 days: older ones describe windows long reset. */
const SNAPSHOT_MAX_AGE_MS = 8 * 86_400_000;

/** One status-line snapshot and the session that wrote it. */
export interface StatuslineReading { session: string; reading: AccountLimits }

/**
 * Every Claude reading of the last 8 days, from `<stateDir>/claude-status/<session>.json`, with the
 * account its session billed then: the one every config dir names for that session at that time (a
 * session's own switch line names it whatever the dir). Config dirs that disagree cannot say which one
 * the session ran in, so its reading is unassigned rather than counted once for each.
 */
export function claudeStatuslineReadings(stateDir: string, book: AccountBook, configDirs: readonly string[], now: number): StatuslineReading[] {
  const dir = join(stateDir, "claude-status");
  let names: string[];
  try { names = configDirs.length ? readdirSync(dir).filter((n) => n.endsWith(".json")) : []; } catch { return []; }
  const out: StatuslineReading[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let mtime: number;
    try { mtime = statSync(path).mtimeMs; } catch { continue; }
    if (now - mtime > SNAPSHOT_MAX_AGE_MS) continue;
    let stored: { observedAt?: unknown; payload?: unknown; account?: unknown };
    try { stored = JSON.parse(readFileSync(path, "utf8")); } catch { continue; }
    const observedAt = num(stored.observedAt);
    if (observedAt === undefined) continue;
    const decoded = decodeClaudeStatusline(stored.payload, observedAt);
    const limits = decoded?.telemetry.rateLimits;
    if (!decoded || !limits?.length) continue;
    const named = new Set(configDirs.map((configDir) => book.claude(configDir, decoded.sessionId, observedAt)));
    const account = typeof stored.account === "string" && /^claude:[0-9a-f]{16}$/.test(stored.account)
      ? stored.account
      : named.size === 1 ? [...named][0]! : UNASSIGNED.claude;
    out.push({
      session: decoded.sessionId,
      reading: {
        agent: "claude", account, observedAt, source: "statusline",
        windows: limits.map((l) => ({ name: windowName(l.windowMinutes ?? 0), windowMinutes: l.windowMinutes ?? 0, usedPercent: l.usedPercent, ...(l.resetsAt !== undefined ? { resetsAt: l.resetsAt } : {}) })),
      },
    });
  }
  return out;
}

/** Each session's account, from its newest reading; a session no account can be named for is left out. */
export function sessionAccounts(readings: readonly StatuslineReading[]): Record<string, string> {
  const newest = new Map<string, AccountLimits>();
  for (const { session, reading } of readings) {
    if ((newest.get(session)?.observedAt ?? -1) < reading.observedAt) newest.set(session, reading);
  }
  const out: Record<string, string> = {};
  for (const [session, reading] of newest) if (reading.account !== UNASSIGNED.claude) out[session] = reading.account;
  return out;
}

export interface WeeklyReading { usedPercent: number; resetsAt?: number; observedAt: number }

/**
 * The newest weekly window per Claude account, from whichever reading had one. Claude's status line
 * leaves the window out of many reports, so the newest reading of an account is often without it.
 */
export function newestWeekly(all: readonly AccountLimits[]): Record<string, WeeklyReading> {
  const out: Record<string, WeeklyReading> = {};
  for (const l of all) {
    const week = l.agent === "claude" && l.account !== UNASSIGNED.claude ? l.windows.find((w) => w.name === "seven_day") : undefined;
    if (!week || (out[l.account]?.observedAt ?? -1) >= l.observedAt) continue;
    out[l.account] = { usedPercent: week.usedPercent, ...(week.resetsAt !== undefined ? { resetsAt: week.resetsAt } : {}), observedAt: l.observedAt };
  }
  return out;
}

export function codexLimits(byAccount: Record<string, CodexLimits>): AccountLimits[] {
  return Object.entries(byAccount).map(([account, l]) => ({
    agent: "codex", account, observedAt: l.observedAt, source: "codex", ...(l.plan ? { plan: l.plan } : {}),
    windows: l.windows.map((w) => ({ name: windowName(w.windowMinutes), ...w })),
  }));
}

/** hats' `limits.json`: `{v:1, accounts:[{harness, account, observedAt, windows:[{name, usedPercent, resetsAt}]}]}`. */
export function hatsLimits(text: string): AccountLimits[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return []; }
  const accounts = (raw as { v?: unknown; accounts?: unknown }).v === 1 ? (raw as { accounts?: unknown }).accounts : undefined;
  if (!Array.isArray(accounts)) return [];
  const out: AccountLimits[] = [];
  for (const a of accounts as Array<Record<string, unknown>>) {
    const agent = a.harness;
    if ((agent !== "claude" && agent !== "codex") || typeof a.account !== "string" || !/^[0-9a-f]{16}$/.test(a.account)) continue;
    const observedAt = num(a.observedAt);
    if (observedAt === undefined || !Array.isArray(a.windows)) continue;
    const windows: LimitWindow[] = [];
    for (const w of a.windows as Array<Record<string, unknown>>) {
      const used = pct(w.usedPercent);
      const minutes = w.name === "five_hour" ? 300 : w.name === "seven_day" ? 10080 : undefined;
      if (used === undefined || minutes === undefined) continue;
      windows.push({ name: windowName(minutes), windowMinutes: minutes, usedPercent: used, ...(num(w.resetsAt) !== undefined ? { resetsAt: num(w.resetsAt)! } : {}) });
    }
    if (windows.length) out.push({ agent, account: `${agent}:${a.account}`, observedAt, source: "hats", windows });
  }
  return out;
}

/**
 * claude-swap's `cache/usage.json`: per slot, `lastGood.{five_hour,seven_day}.{pct,resets_at}` and
 * `fetchedAt`. The file also holds each account's email; nothing but those fields is read.
 */
export function claudeSwapLimits(text: string): AccountLimits[] {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return []; }
  const accounts = (raw as { accounts?: unknown }).accounts;
  if (!accounts || typeof accounts !== "object") return [];
  const out: AccountLimits[] = [];
  for (const [slot, value] of Object.entries(accounts as Record<string, Record<string, unknown>>)) {
    if (!/^\d{1,3}$/.test(slot)) continue;
    const good = value?.lastGood as Record<string, Record<string, unknown> | undefined> | undefined;
    const fetched = num(value?.fetchedAt);
    if (!good || fetched === undefined) continue;
    const windows: LimitWindow[] = [];
    for (const [name, minutes] of [["five_hour", 300], ["seven_day", 10080]] as const) {
      const w = good[name];
      const used = pct(w?.pct);
      if (used === undefined) continue;
      const resets = typeof w?.resets_at === "string" ? Date.parse(w.resets_at.replace(/(\.\d{3})\d+/, "$1")) : NaN;
      windows.push({ name, windowMinutes: minutes, usedPercent: used, ...(Number.isFinite(resets) ? { resetsAt: Math.round(resets / 1000) } : {}) });
    }
    // fetchedAt is seconds in claude-swap 0.26; a value that already looks like ms is kept.
    if (windows.length) out.push({ agent: "claude", account: `claude:swap-${slot}`, observedAt: fetched < 1e12 ? fetched * 1000 : fetched, source: "claude-swap", windows });
  }
  return out;
}

/** The newest reading per account across sources. */
export function newestPerAccount(all: AccountLimits[]): AccountLimits[] {
  const best = new Map<string, AccountLimits>();
  for (const l of all) {
    const prev = best.get(l.account);
    if (!prev || prev.observedAt < l.observedAt) best.set(l.account, l);
  }
  return [...best.values()];
}
