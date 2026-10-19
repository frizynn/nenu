# 0100. A thread's panel opens on its Overview; the project's views live on its page

- **Status:** Accepted (2026-10-20). Supersedes [0081](./0081-on-a-desk-the-project-is-the-panels-first-tab.md)
  and the Artifacts tab of [0075](./0075-a-desk-session-opens-with-its-own-panel.md) point 1.
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
4. The project's Notes, Agents, PRs and Context leave the panel; they belong on the project's page.
5. Artifacts becomes a view of Files (Folder · Artifacts), still offered only where the pane has a
   conversation.

## Consequences

- Beside a thread the person sees that thread first. The project's task list and context are one
  step further away, on the project page.
- No ids, history, New thread or New coordinator in the panel: those are the project page's.
- Revisit point 4 only if the person keeps leaving a thread for the project page to read its task
  list as a habit.
