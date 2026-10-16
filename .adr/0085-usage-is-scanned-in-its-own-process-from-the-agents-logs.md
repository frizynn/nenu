# 0085. Usage is scanned in its own short-lived process, from the agents' own logs

- **Status:** Accepted (2026-10-16).
- **Trail:** `bridge/usage/scan.ts` · `bridge/usage/bytes.ts` · `bridge/usage/scan-main.ts` ·
  `bridge/usage/runtime.ts` · `bridge/usage/accounts.ts` · `bridge/usage/report.ts` ·
  `bridge/usage/prices.ts` · `bridge/routes/usage.ts`

## Context

Settings → Usage shows the operator's Claude Code and Codex tokens, their API-equivalent cost per
day, agent, account, model and repo, and each account's plan limits. Off by default, and off must be
exactly what Nenu did before: no process, no read of any log, no timer, the same bridge memory.

The numbers have to come from somewhere every operator has. Measured and read on one machine with a
large history (3,550 logs, 13.7 GB, the longest line 13.6 MB):

- **The logs themselves.** Claude Code writes one row per content block of a response, all with the
  same `message.id` + `requestId` (close to half the rows are repeats), and copies some messages
  into subagent or resumed transcripts (about one in two hundred). Codex writes cumulative totals per session,
  names the account (`creator_account_id`) and the plan limits in every `token_count`, and moves old
  rollouts to `archived_sessions/`. Claude Code deletes transcripts after 30 days (`cleanupPeriodDays`).
- **OpenTelemetry** from either CLI carries tokens, cost and the account, but only after the operator
  edits each config dir's settings, Nenu runs an OTLP receiver, and only from then on; it has no
  history and no 5-minute/1-hour cache split. Hooks carry no usage. Herdr's socket has none.
- **Where to scan.** The same scan, three ways, three runs each (`/usr/bin/time -l`, warm cache):

| | Wall | CPU | Peak RSS | Bridge RSS 60 s later |
| --- | --- | --- | --- | --- |
| Inside the bridge (Bun) | 5.9–6.5 s | 4.4–4.6 s | 144–161 MB | **+127 to +143 MB** |
| Its own Bun process | 6.5–9.8 s | 4.6–4.8 s | 141–167 MB | +1 to +3 MB |
| A Rust binary, 4 threads | 2.1–2.4 s | 2.6–2.7 s | 13 MB | +2 to +4 MB |

  JavaScriptCore keeps the pages of a scan's short-lived strings and objects, even after a full GC
  (176 MB before and after `Bun.gc(true)`). The same loop without decoding rows stays at 34 MB.
- `mmap` lost to `read` on macOS (17.3 s against 5.9 s on one thread) and counts the mapped file as
  RSS. Reading four files at a time helps (the scan waits on the disk); more threads did not.

## Decision

1. **Read the agents' own logs**, Claude Code transcripts and Codex rollouts, and nothing that needs
   the operator to reconfigure an agent. Plan limits come from what is already on disk: Nenu's
   status-line snapshots and the rollouts. Never a credential, never a usage endpoint.
2. **Scan in a short-lived Bun process at background priority** (`taskpolicy -b` on macOS, `nice -n
   19` on Linux) that writes daily totals and per-log offsets under `<stateDir>/usage/` and exits.
   The bridge only reads the small totals to answer `GET /api/usage`.
3. **Read only new bytes, and rows in place.** Offsets per log (whole lines only; a Codex rollout by
   its id so archiving does not double it), directory listings reused while their mtime holds, rows
   found by byte markers and their numbers read without decoding the row. Claude rows are deduplicated
   by message id + request id across files, in a typed-array table kept 90 days.
4. **Run on demand and on a finished turn, never on a timer or a watch**: when tracking is turned on,
   when the view asks and the last scan is over a minute old, and when Herdr reports a turn ended and
   the last scan is over six hours old, so logs are counted before Claude Code deletes them.
5. **Keep tokens, price at read time.** A dated price table with its sources; a price change needs no
   rescan.
6. **Attribute Claude usage from a shared switch log**, one line per "account X became active" per
   config dir or session, in the format hats writes. Nenu writes its own sightings in that format,
   and reads hats' log and claude-swap's when present; without any of them, one config dir is one
   account. The account is fixed at scan time, because transcripts do not record it and are deleted.

## Consequences

- Off costs nothing measurable; on, the bridge holds no scan memory. The first scan of a large
  history takes seconds at background priority (5.6 s, 116 MB peak on the machine above); a later
  one reads only what was appended (10 ms of scanning, 50 ms with process start).
- The transcript format is internal to Claude Code and changes between versions. A row the byte
  path cannot vouch for is parsed whole; a row that does not parse is counted as skipped.
- Which copy of a duplicated message is kept follows read order; copies can differ slightly in
  output tokens (0.06 % of one day's output on the machine above).
- An account switch between two scans is attributed at the next scan unless hats or claude-swap
  logged it. Turning on Split by account later cannot re-attribute logs already deleted.
- A native scanner would be three times faster with a tenth of the memory, but Nenu is installed as
  a git checkout run by Bun: shipping per-platform binaries, building with cargo on the operator's
  machine, or committing binaries, and keeping a Bun fallback that must agree with it, costs more than
  a one-time first scan saves. Revisit if first scans of real histories grow past what background
  priority hides, or if Nenu starts shipping binaries for another reason.
- Telemetry stays a possible second source of accounts for operators who already export it.
