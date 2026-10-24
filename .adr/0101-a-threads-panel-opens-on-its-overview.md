# 0101. A thread's panel opens on its Overview; the project's views leave it

- **Status:** Superseded by [ADR 0123](./0123-nenu-draws-herdr-alone.md) (2026-10-24). Before that: Accepted (2026-10-20). Supersedes [0081](./0081-on-a-desk-the-project-is-the-panels-first-tab.md)
  and the Artifacts tab of [0075](./0075-a-desk-session-opens-with-its-own-panel.md) point 1. Amended for a
  coordinator's own pane by [ADR 0115](./0115-a-tap-on-a-coordinator-enters-its-chat.md): its Overview also
  holds what its page did (Waiting on you, New thread, its History line, Routines, Status, Move and Close).
- **Trail:** `web/src/components/thread-overview.tsx` · `web/src/components/inspector-panels.tsx` ·
  `web/src/components/session-inspector.tsx` · `web/src/components/project-frame.tsx`

## Context

ADR 0081 put the whole project (Notes, Agents, PRs, Context) in the first tab beside every project
pane. Beside a thread that answered questions about the project, not about the thread: a worker's
panel showed the same task list and context as every other pane of the project, and what the person
looks for beside a running thread (is it working, which coordinator runs it, did it open its PR,
how full is its context, what did it change) was spread over the chat header, the composer row and
the Changes tab. The approved desktop redesign (artboard Main, awam-org t-0356) draws that column
as cards, one question each, under four tabs.

## Decision

1. A project pane's session panel has four tabs: **Overview**, Changes, Files, Terminal. A pane
   outside a project has no Overview and starts on Changes, as before.
2. **Overview** is three cards: *This thread* (state and age, the coordinator it answers to, its pull
   request, its agent and model, how full its context is), *Changes* (the branch's +N −M and its first
   files, every tap opening the Changes tab) and the *coordinator* with its open threads, this one
   marked. A coordinator's own pane lists its own threads; the project coordinator's names no one
   above it.
3. Model and context come from what the chat beside it already reads (`SessionPanelLink.report`);
   the panel reads nothing of its own for them. A value the agent has not reported is left out.
4. The project's Notes, Agents, PRs and Context leave the panel. They belong on the project's page,
   which does not draw Notes or Context yet; until it does, the bridge keeps `/api/org/tasks`,
   `/api/org/status` and `/api/org/context` and their readers in `lib/api.ts` for it.
5. Artifacts becomes a view of Files (Folder · Artifacts), still offered only where the pane has a
   conversation.

## Consequences

- Beside a thread the person sees that thread first. The project's task list and context have no desk
  view until the project page draws them; its threads and PRs are already there.
- No ids, history, New thread or New coordinator in the panel: those are the project page's.
- Revisit point 4 only if the person keeps leaving a thread for the project page to read its task
  list as a habit.
