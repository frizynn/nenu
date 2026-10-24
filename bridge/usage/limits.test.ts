import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AccountBook, type SwitchLine } from "./accounts.ts";
import { claudeStatuslineReadings, newestWeekly, sessionAccounts, type AccountLimits } from "./limits.ts";

const now = Date.UTC(2026, 9, 24, 10);
const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const week = (usedPercent: number) => ({ used_percentage: usedPercent, resets_at: now / 1000 + 86_400 });

let stateDir = "";
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "nenu-limits-")); mkdirSync(join(stateDir, "claude-status")); });
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

const snapshot = (session: string, observedAt: number, rateLimits: Record<string, unknown>) =>
  writeFileSync(join(stateDir, "claude-status", `${session}.json`), JSON.stringify({ observedAt, payload: { session_id: session, rate_limits: rateLimits } }));
const line = (account: string, configDir: string, at: number, session?: string): SwitchLine =>
  ({ at, harness: "claude", account, configDir, ...(session ? { session } : {}) });

test("a reading belongs to the account every config dir names for its session, else to nobody", () => {
  snapshot(S1, now - 1000, { five_hour: { used_percentage: 40 } });
  snapshot(S2, now - 1000, { five_hour: { used_percentage: 60 } });
  const lines = [line("claude:aaaaaaaaaaaaaaaa", "/a", 0), line("claude:bbbbbbbbbbbbbbbb", "/b", 0), line("claude:cccccccccccccccc", "/a", 0, S2)];
  const book = new AccountBook(lines);
  // The dir its log sits in names it, as for its tokens. With no log found: one dir names it; two that
  // disagree leave it unassigned, never counted for each. A session's own line wins everywhere.
  const accounts = (dirs: string[], sessionDirs = new Map<string, string>()) =>
    Object.fromEntries(claudeStatuslineReadings(stateDir, book, dirs, sessionDirs, now).map((r) => [r.session, r.reading.account]));
  expect(accounts(["/a"])).toEqual({ [S1]: "claude:aaaaaaaaaaaaaaaa", [S2]: "claude:cccccccccccccccc" });
  expect(accounts(["/a", "/b"])).toEqual({ [S1]: "claude:unassigned", [S2]: "claude:cccccccccccccccc" });
  expect(accounts(["/a", "/b"], new Map([[S1, "/b"], [S2, "/b"]]))).toEqual({ [S1]: "claude:bbbbbbbbbbbbbbbb", [S2]: "claude:cccccccccccccccc" });
  expect(claudeStatuslineReadings(stateDir, book, [], new Map(), now)).toEqual([]);
});

test("each session's account comes from its newest reading, and an unnamed one is left out", () => {
  const reading = (account: string, observedAt: number): AccountLimits => ({ agent: "claude", account, observedAt, source: "statusline", windows: [] });
  expect(sessionAccounts([
    { session: S1, reading: reading("claude:aaaaaaaaaaaaaaaa", 1) },
    { session: S1, reading: reading("claude:bbbbbbbbbbbbbbbb", 2) },
    { session: S2, reading: reading("claude:unassigned", 3) },
  ])).toEqual({ [S1]: "claude:bbbbbbbbbbbbbbbb" });
});

test("an account's weekly window is its newest reading that had one, whatever came after", () => {
  const w = (usedPercent: number) => ({ name: "seven_day" as const, windowMinutes: 10080, usedPercent, resetsAt: 9 });
  const h = { name: "five_hour" as const, windowMinutes: 300, usedPercent: 50 };
  expect(newestWeekly([
    { agent: "claude", account: "claude:aaaaaaaaaaaaaaaa", observedAt: 1, source: "statusline", windows: [h, w(90)] },
    { agent: "claude", account: "claude:aaaaaaaaaaaaaaaa", observedAt: 3, source: "statusline", windows: [h] },
    { agent: "claude", account: "claude:aaaaaaaaaaaaaaaa", observedAt: 2, source: "hats", windows: [w(95)] },
    // A weekly window with no reset cannot say it still holds: it hides no older one that can.
    { agent: "claude", account: "claude:aaaaaaaaaaaaaaaa", observedAt: 2.5, source: "statusline", windows: [{ name: "seven_day", windowMinutes: 10080, usedPercent: 1 }] },
    { agent: "claude", account: "claude:unassigned", observedAt: 4, source: "statusline", windows: [w(10)] },
    { agent: "codex", account: "codex:aaaaaaaaaaaaaaaa", observedAt: 4, source: "codex", windows: [w(10)] },
  ])).toEqual({ "claude:aaaaaaaaaaaaaaaa": { usedPercent: 95, resetsAt: 9, observedAt: 2 } });
});

test("a snapshot from the live status line reaches Settings and the session map alike", () => {
  snapshot(S1, now - 1000, { five_hour: { used_percentage: 40 }, seven_day: week(99) });
  const book = new AccountBook([line("claude:aaaaaaaaaaaaaaaa", "/a", 0)]);
  const readings = claudeStatuslineReadings(stateDir, book, ["/a"], new Map(), now);
  expect(sessionAccounts(readings)).toEqual({ [S1]: "claude:aaaaaaaaaaaaaaaa" });
  expect(newestWeekly(readings.map((r) => r.reading))).toEqual({ "claude:aaaaaaaaaaaaaaaa": { usedPercent: 99, resetsAt: now / 1000 + 86_400, observedAt: now - 1000 } });
});
