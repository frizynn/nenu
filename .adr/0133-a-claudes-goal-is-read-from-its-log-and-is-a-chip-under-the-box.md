# 0133. A Claude's goal is read from its log and is a chip under the box

- **Status:** Accepted (2026-10-28). Reported by the operator on 2.10.3, over a desk chat whose Claude
  had an active `/goal`: "esta sesion tiene un goal y no se ve". Amends [ADR 0067](./0067-the-clis-own-state-decides-the-screen-is-the-fallback.md)
  (a resting Claude with a goal keeps its transcript watched) and [ADR 0108](./0108-the-line-above-the-box-holds-only-live-work.md)
  (Goal keeps its word in a narrow box).
- **Trail:** `bridge/agent-state-sources.ts` (`claudeGoalRow`, `ClaudeTurnScan.goal`) ·
  `bridge/agent-state.ts` (`lastClaudeGoal`, `goalOf`) · `web/src/components/composer-chips.tsx`
  (`GOAL_MARK`, `GoalDetail`) · `web/src/styles/composer.css` (`.composer-chip-detail`) ·
  `bridge/test-support/agent-state/*goal*` · `scripts/e2e/run.ts chip-line` (the `goal` moment)

## Context

Claude Code runs `/goal` itself and logs no operator turn for it (the fix in 2.10.3 stopped Nenu
drawing one). The terminal shows `◎ /goal active (2h)` above its input box; Nenu showed nothing.

Measured on four real transcripts (Claude 2.1.296–2.1.310) and read in 2.1.310's code:

- Every goal event is a `goal_status` attachment: a `sentinel` row when it is set, set again over
  another goal (no row for the one replaced), cleared with `/goal clear` or `stop` (`met: true`), or
  restated after a compaction; one row per check of the condition (`met: false` with a reason); and
  `met: true` with iterations once it holds. `failed: true` marks an impossible goal (code only).
- Claude restores a goal on `--resume` from the newest such row: active unless `met` or `failed`.
- A compaction restates an active goal right after its boundary row (measured twice), and a goal
  met before one is not restated.
- Checks are sparse: on the operator's pane the newest goal row sat 1.3 MB from the end of a 66 MB
  log, behind hours of turns, out of reach of the tails ADR 0067 and ADR 0120 read.

## Decision

1. **The goal is Claude's own record, read as Claude reads it**: the newest goal row, active unless
   met or failed. The screen's `/goal active` is never read for it.
2. **The bridge finds it once per session** by reading the log backwards a megabyte at a time, until
   the first goal row or compaction boundary (2 to 188 ms on twelve real logs up to 95 MB), then
   follows the tail's own goal rows, and attaches it to the pane's `turn` as `goal`.
3. **A resting Claude with a goal keeps its transcript watched**, so a goal cleared at rest goes at
   once; the watch closes when the goal does.
4. **It is a chip in the row under the box**: Claude's ◎ in grey and the word Goal. In a wide box the
   condition follows, cut to fit room the row has left, never pushing another control; the full
   condition is the chip's tooltip and its panel. In a narrow box the chip keeps its word, because it
   has no count: a bare ◎ says nothing. Under 300 px it is the mark alone.

## Consequences

- Nothing sits above the box for a goal: it asks nothing of the operator, so it is not the one line
  ADR 0108 allows there.
- A goal is a chip as long as it holds, which can be days. It is grey and still, as every mark that
  asks nothing.
- Codex has its own `/goal`, not covered: no Codex goal was measured. Add it once one is.
- Revisit if Claude starts writing the goal into its session file, which would make the backward read
  unnecessary.
