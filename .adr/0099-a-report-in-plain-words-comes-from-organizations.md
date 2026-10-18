# 0099. A report in plain words comes from Organizations

- **Status:** Accepted (2026-10-19). Extends [ADR 0089](./0089-a-coordinators-summary-groups-its-work-by-outcome.md).
- **Trail:** `bridge/org-report.ts` (`parsePlainSummary`) · `bridge/org-cli.ts` (`explainThread`) ·
  `bridge/routes/org.ts` (`/api/org/thread/explain`) · `bridge/projects.ts` (`threadSummary`) ·
  `web/src/components/coordinator-summary.tsx` (`ReportWords`)

## Context

A report's `## Summary` is written by the agent for its coordinator, so it is full of ticket
numbers, commits and test names. The operator reads it on a phone without having followed the work,
and could not tell what had changed or what was being asked of them. Herdr Organizations
([frizynn/herdr-organizations#52](https://github.com/frizynn/herdr-organizations/pull/52)) added a summary agent: a command the operator names in its `config.toml` (a small model through
`claude -p`, or Codex) that rewrites a report in plain words, `thread explain`, and `plain_summary`
and the `explain` action in `--json`.

## Decision

1. **Nenu never calls a model for this itself.** It shows what Organizations' summary agent wrote
   and asks Organizations for one. Which model, its cost, its timeout and whether it runs on its
   own (`mode = "auto"`) are Organizations' settings, kept in one place for every client.
2. **The plain words lead once they were written for this report.** A summary of an older report
   (`current: false`) is not shown. The agent's own words stay one tap away ("Agent's words").
3. **"In plain words" shows only where Organizations offers it** (`actions` lists `explain`) and
   only to a device that may write: a press spends a model call, so it is a write route.
4. **Both texts are model-written** and drawn as text, like the summary (ADR 0089). They are read
   with the summaries, never put in the snapshot.

## Consequences

- With no summary agent configured, nothing changes: no button and no plain words.
- A press waits up to 150 s. The bridge waits past the agent's own 120 s timeout, so the
  operator sees Organizations' reason instead of a bridge timeout.
- A failed call shows its reason under the agent's words. Pressing again asks again.
