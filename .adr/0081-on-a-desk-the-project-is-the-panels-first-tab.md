# 0081. On a desk, the project is the session panel's first tab

- **Status:** Superseded by [0101](./0101-a-threads-panel-opens-on-its-overview.md). Accepted (2026-10-15).
  Supersedes point 2 of ADR 0075, whose own condition for revisiting it was met.
- **Trail:** `web/src/components/session-inspector.tsx` · `web/src/components/inspector-panels.tsx` ·
  `web/src/components/project-panel.tsx` · `bridge/org-cli.ts` · `bridge/routes/org.ts`

## Context

ADR 0075 put a project pane's own panel (Threads, PRs, Activity, Memory) behind the session panel's
⋯, so the session's diff would show first. It said to revisit if operators kept reaching for ⋯
first; the operator did, and found the extra step redundant with the panel's own tabs. Memory showed only the project's goal
and the open branches, so it read the same on every project. Herdr Organizations now prints
`task list`, `project show` and `routine list` as `--json` documents (its docs/json.md, schema 1); the
installed release on the operator's host predates them.

## Decision

1. A project pane's session panel opens on **Project**, its first tab: the project's name, then
   Notes, Agents, PRs and Context. A pane outside a project starts on Changes. The tab and the view are
   kept per device, as the rest of the panel is.
2. **Notes** is the coordinator's task list (`task list`) grouped by state; **Context** is what every
   thread receives (`project show`), its routines (`routine list`) and the open branches. Each view
   reads only while it is on screen, on `/api/org/tasks` and `/api/org/context`, and polls nothing.
3. Where Organizations lacks a document, the bridge answers `null` and the view says, without an
   error, where the data will come from: Notes lists the threads by state, Context keeps the goal and
   the branches.
4. Only the coordinator writes TASKS.md. Marking a task asks it, after a confirm, through the guarded
   send of the composer (typed, verified, submitted); Nenu never writes the file.
5. Activity becomes Agents' folded "Background work"; Threads becomes Agents; Memory becomes Context.

## Consequences

- The session's diff is one tab away again on a project pane; on any other pane it is still first.
- A project with Organizations older than these documents shows less in Notes and Context, and says so.
- Revisit point 1 only if the operator reaches for Changes first on project panes as a habit; revisit
  point 4 never without the coordinator ceasing to be the list's only writer in Organizations.
