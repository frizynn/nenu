import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { decodeClaudeStatusline } from "../claude-telemetry.ts";
import type { SessionTelemetry } from "../journal/types.ts";
import type { AccountBook, Harness } from "./accounts.ts";
import type { CodexLimits } from "./scan.ts";
import type { AccountsFile } from "./scan-main.ts";

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

/** The newest Claude reading per account, from `<stateDir>/claude-status/<session>.json`. */
export function claudeStatuslineLimits(stateDir: string, book: AccountBook, configDir: string, now: number): AccountLimits[] {
  const dir = join(stateDir, "claude-status");
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return []; }
  const best = new Map<string, AccountLimits>();
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
    const account = typeof stored.account === "string" && /^claude:[0-9a-f]{16}$/.test(stored.account)
      ? stored.account
      : book.claude(configDir, decoded.sessionId, observedAt);
    const prev = best.get(account);
    if (prev && prev.observedAt >= observedAt) continue;
    best.set(account, {
      agent: "claude", account, observedAt, source: "statusline",
      windows: limits.map((l) => ({ name: windowName(l.windowMinutes ?? 0), windowMinutes: l.windowMinutes ?? 0, usedPercent: l.usedPercent, ...(l.resetsAt !== undefined ? { resetsAt: l.resetsAt } : {}) })),
    });
  }
  return [...best.values()];
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

/**
 * The weekly window of the Claude account in use, from the last scan's accounts file, for a session
 * whose own status line left it out. Only when one Claude account is signed in (two config dirs on
 * different accounts cannot say which one a session bills) and the window it was read in has not
 * reset; never a guess.
 */
export function accountWeekly(file: AccountsFile | undefined, now: number): NonNullable<SessionTelemetry["rateLimits"]>[number] | undefined {
  const active = file?.accounts.filter((a) => a.agent === "claude" && a.active) ?? [];
  if (active.length !== 1) return undefined;
  const reading = file!.limits.find((l) => l.account === active[0]!.id);
  const week = reading?.windows.find((w) => w.windowMinutes === 10080);
  if (!reading || !week || week.resetsAt === undefined || week.resetsAt * 1000 <= now) return undefined;
  return { name: "secondary", usedPercent: week.usedPercent, windowMinutes: 10080, resetsAt: week.resetsAt, observedAt: reading.observedAt };
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
