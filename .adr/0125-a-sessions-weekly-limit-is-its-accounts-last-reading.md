# 0125. A session's missing weekly limit is its own account's last reading, never the account signed in now

- **Status:** Accepted (2026-10-24). Requested by the operator; the source was delegated.
- **Trail:** `bridge/usage/limits.ts` (`claudeStatuslineReadings`, `sessionAccounts`, `newestWeekly`) ·
  `bridge/usage/scan-main.ts` · `bridge/usage/runtime.ts` (`sessionWeekly`) · `bridge/routes/pane.ts` ·
  `bridge/claude-telemetry.ts` (`withWeekly`) · `web/src/lib/rate-limits.ts`

## Context

The panel under a chat's context ring lists the context, the 5-hour limit and the weekly limit, from
the session's own status-line report. On the operator's host (2026-10-24), Claude Code was sending
only `five_hour`: across 1,287 snapshots, the newest `seven_day` was 45 hours old. The operator asked
for the weekly limit in that panel anyway.

Settings → Usage already keeps the limits per account. Its scan attributes each reading to an account
through the switch log (ADR 0085), and only at scan time. The first version of this fallback took the
weekly window of "the one Claude account signed in", which looks equivalent. It is not:

- hats can switch a single session to another account;
- a session that started before a switch keeps the reading of the account it billed, while "signed in
  now" names the new one;
- a second config dir with no account of its own lets the other dir's account pass as the only one.

Each of these shows another account's number as if it were this session's.

## Decision

1. **The scan names each session's account**, the way it counts that session's tokens: through the
   config dir its log sits in, at its newest reading, where a session's own switch line wins. A
   session whose log was not found is named only when every config dir names the same account for it.
   Otherwise it is left unnamed.
2. **The scan keeps each account's newest weekly window from any reading** (status line, hats,
   claude-swap), not only from its newest reading, since that one usually lacks the window.
3. **A pane read fills the gap only from those two**, and only when four things hold: tracking is on,
   the session was named, its account has a weekly window, and that window has not reset. Otherwise
   the row stays out. A weekly window the session reported itself always wins.
4. **The panel says how old the reading is** ("Last read 1d ago") once it is over two minutes old.

The bridge now reads `<stateDir>/usage/accounts.json` on pane reads, re-parsed only when the scan
rewrites it. It still reads no log; scanning stays in its own process (ADR 0085).

## Consequences

- A session started after the last scan has no weekly row until the next scan names it. That is the
  price of never showing a guess.
- The account behind a reading is as fresh as the last scan, the same as everything Settings → Usage
  shows. The age on the row is the age of the reading, not of that attribution.
- If Claude Code sends `seven_day` again, the session's own report is used, and this fallback goes
  quiet without any change.
