# 0090. A coordinator's STATUS.md is drawn as written, at the top of its page

- **Status:** Accepted (2026-10-16). Amended by [ADR 0091](./0091-your-asks-and-a-coordinators-card-come-from-organizations-fields.md):
  under a coordinator's card the file starts closed. Requested by the operator. Builds on
  [ADR 0088](./0088-a-projects-library-is-read-through-one-contained-route.md) (what the snapshot leaves
  out) and [ADR 0089](./0089-a-coordinators-summary-groups-its-work-by-outcome.md) (the coordinator's page).
- **Trail:** `bridge/org-report.ts` (`status_file`) · `bridge/projects.ts` · `web/src/components/coordinator-status.tsx` ·
  `web/src/components/markdown-text.tsx` (`TextTokensContext`) · `scripts/e2e/coordinator-status.ts`

## Context

The operator asks his coordinators many things in chat, and agent notices bury the questions. Herdr
Organizations now has each coordinator keep one Markdown file, STATUS.md, with what he asked and where
it stands, what needs his decision and what was decided, and prints it as `status_file`
(`{path, text, updated}`, up to 8,000 characters) on the project, for the root coordinator, and on each
coordinator node. It is named `status_file` because `status` is already the lifecycle of both. He wants
to open Nenu and read it without opening a chat. What is in progress and what is done is not in the
file: Organizations computes it from the threads, and the Summary (ADR 0089) draws it.

## Decision

1. **Drawn as the agent wrote it.** The text goes through the transcript's Markdown renderer, so it is
   text nodes, links open in a new tab and no HTML runs. Nenu does not parse it into sections or cards:
   the file is the agent's and the template is a convention, so a deviation still reads. Two touches
   only, both through `TextTokensContext`: a known `[state]` opening a line is a chip, and a thread id
   the project lists opens that node.
2. **At the top.** It heads a coordinator's page and sits under the project's name on the project page,
   folded at a phone's first screen with Show all. Without the field there is no block.
3. **Out of the snapshot.** The text comes with `/api/org/summary`; the snapshot carries only its
   `updated` stamp (`statusUpdated`), so a page reads it again when it changes and nothing else polls it.
4. **An edit is noticed.** The bridge stats every STATUS.md the overview names along with
   Organizations' own files, so an edit re-reads the overview. It never reads the file itself; the text
   is Organizations'.

## Consequences

The project page only shows when the root coordinator is not running; with it running, `/project`
opens its chat, which does not show the file yet. Do not add structure Nenu parses out of the text
(counts, a "needs you" badge): that belongs in fields Organizations prints, not in a reading of agent
prose. Revisit if Organizations publishes the asks as data.
