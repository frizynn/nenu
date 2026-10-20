# 0106. On a desk, finished work is a History by day, and a routine is edited where it is read

- **Status:** Accepted (2026-10-20). Requested by the operator ("threads ya cerrados, no tienen
  sentido, no me interesa ver eso"; "no puedo cliquear y editarlo"). Amends
  [ADR 0102](./0102-on-a-desk-projects-and-coordinators-are-pages-with-tabs.md) points 3 and 5.
- **Trail:** `web/src/components/desk-project.tsx` · `web/src/components/desk-pages.tsx` ·
  `web/src/components/desk-routines.tsx` · `web/src/components/ask-list.tsx` · `web/src/lib/project-work.ts` ·
  `web/src/lib/asks.ts` · `bridge/org-cli.ts` (`setRoutine`) · `scripts/e2e/project-page.ts`

## Context

ADR 0102 gave Work an Open | Finished switch with the same cards over resolved threads. On awam-org
(2026-10-20: 466 nodes, 444 resolved) Finished drew 23 coordinator cards, among them the same name
twice and cards that said "No threads". Those are real nodes: a coordinator whose start failed
(`the project's workspace is not open`) or that was started again with a worktree stays behind,
resolved, with no thread under it. Organizations records no link from the retry to the first start.
Waiting on you drew every row at one weight: the text, a grey word "decision", chips and two quiet
links. Organizations' `routine set` (docs/json.md: "creates or edits one"), which ADR 0102 waited for,
now exists.

## Decision

1. **Work is the open work.** Finished work is History (`?work=finished`, the same address), one
   quiet step from Work's line, never a peer of the open cards. History lists each resolved thread
   with the coordinator that ran it, and each resolved coordinator that ran at least one thread, by
   the day it last changed (Today, Yesterday, the weekday, then the date), newest first, with a
   search over name, id and coordinator. A coordinator that never ran a thread is left out: that is
   what drew a name twice. A card with nothing to unfold draws no chevron.
2. **What waits on you reads as a question:** its kind in the one red (Decision, or Your ask),
   what it asks, what its coordinator says, its tasks, then Answer as a button. A decision line is
   split at its first ` : `, the separator Organizations' coordinator skill writes between what
   goes to the person and the recommendation; a line without one stays whole.
3. **A routine is edited beside the list,** where Organizations has `routine set` (its `--help`
   exits 0) and on a write-level device: its trigger (a schedule in Organizations' grammar, or the
   pull request events), whom it reaches (`root`, the pull request's thread, an open coordinator, a
   new thread and where it starts) and its prompt. Only the changed fields are sent, each as one
   `--flag=value`. Creating a routine, its repository and approving a command stay at a terminal.

## Consequences

Nothing resolved is lost: a coordinator that ran nothing still opens from Search and the tree. The
kinds Organizations does not tell apart (a question, an approval, a login) read as Decision until
`asks --json` names them. Revisit if Organizations links a retried coordinator to its first start
(then History can fold them), or if it publishes an ask's kind.
