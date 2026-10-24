import { expect, test } from "bun:test";
import { accountWeekly } from "./limits.ts";
import type { AccountsFile } from "./scan-main.ts";

const now = Date.UTC(2026, 9, 24, 10);
const later = now / 1000 + 3 * 86_400;
const file = (over: Partial<AccountsFile> = {}): AccountsFile => ({
  v: 1, at: now,
  accounts: [
    { id: "claude:aaaa", agent: "claude", label: "Claude 1", source: "observed", active: true },
    { id: "claude:bbbb", agent: "claude", label: "Claude 2", source: "observed", active: false },
    { id: "codex:cccc", agent: "codex", label: "ChatGPT", source: "codex", active: true },
  ],
  limits: [
    { agent: "claude", account: "claude:aaaa", observedAt: now - 45 * 3_600_000, source: "statusline",
      windows: [{ name: "five_hour", windowMinutes: 300, usedPercent: 38, resetsAt: now / 1000 - 60 }, { name: "seven_day", windowMinutes: 10080, usedPercent: 99, resetsAt: later }] },
    { agent: "claude", account: "claude:bbbb", observedAt: now, source: "statusline", windows: [{ name: "seven_day", windowMinutes: 10080, usedPercent: 5, resetsAt: later }] },
  ],
  ...over,
});

test("the signed-in Claude account's weekly window, with when it was read", () => {
  expect(accountWeekly(file(), now)).toEqual({ name: "secondary", usedPercent: 99, windowMinutes: 10080, resetsAt: later, observedAt: now - 45 * 3_600_000 });
});

test("nothing when it cannot say which account, or the account has no current weekly reading", () => {
  expect(accountWeekly(undefined, now)).toBeUndefined();
  const both = file();
  both.accounts[1]!.active = true;
  expect(accountWeekly(both, now)).toBeUndefined();
  const none = file();
  none.accounts[0]!.active = false;
  expect(accountWeekly(none, now)).toBeUndefined();
  // The window it was read in has reset: that share says nothing about the new week.
  expect(accountWeekly(file(), later * 1000 + 1)).toBeUndefined();
  const fiveHourOnly = file();
  fiveHourOnly.limits[0]!.windows.pop();
  expect(accountWeekly(fiveHourOnly, now)).toBeUndefined();
});
