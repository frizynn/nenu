# 0102. On a desk, projects and coordinators are pages with tabs; asks and routines live on them

- **Status:** Accepted (2026-10-20); points 3 and 5 amended by [ADR 0106](./0106-finished-work-is-history-and-a-routine-is-edited-in-place.md); the coordinator card and page amended by [ADR 0108](./0108-a-coordinators-page-shows-live-work.md). Requested by the operator, with the approved design
  (designboard `nenu-desktop`, artboards Projects, Project, ProjectAsks, ProjectRoutines, Coordinator).
  Amends [ADR 0080](./0080-the-desks-bar-lists-projects-and-chats-the-tree-is-searchs.md) point 1,
  [ADR 0091](./0091-your-asks-and-a-coordinators-card-come-from-organizations-fields.md) point 4,
  [ADR 0092](./0092-a-project-organizes-its-coordinators.md) point 1,
  [ADR 0064](./0064-the-organization-is-drawn-as-organizations-draws-it.md) point 2 and
  [ADR 0090](./0090-a-coordinators-status-file-is-drawn-as-written.md) point 2, all on a desk only.
- **Trail:** `web/src/components/desk-project.tsx` · `web/src/components/desk-coordinator.tsx` ·
  `web/src/components/desk-pages.tsx` · `web/src/components/desk-routines.tsx` · `web/src/lib/project-work.ts` ·
  `web/src/routes/projects.tsx` · `web/src/hooks/use-desk.ts` · `bridge/org-cli.ts` (`toggleRoutine`) ·
  `scripts/e2e/coordinators.ts` · `scripts/e2e/coordinator-status.ts`

## Context

On a desk the bar led with Routines and Your asks, two pages that listed every project's routines and
every coordinator's asks in one column. A project's page was a tree with a grey "History · 18
coordinators, 320 threads", its project coordinator first, and a project with only its own coordinator
opened on that coordinator's chat. Measured on awam-org on 2026-10-20: 359 nodes, 342 of them resolved,
four open coordinators, 18 asks waiting. The operator approved a design where the project is the place
to read all of it: who works on what, what waits on you, and what runs on its own.

## Decision

1. **The desk's bar leads with New chat, Search, Home and Projects.** Projects (`/projects`) lists every
   project as a card: its goal, what waits on you, what is working, and how many coordinators and threads
   it holds open. On a desk, `/asks` lands on the project's or coordinator's Waiting on you, and
   `/routines` on Projects. A phone keeps both pages and its Search sheet's Your asks.
2. **A project is a page with tabs, never a redirect to a chat:** Work, Waiting on you, Routines and
   Context, in the address (`?tab=`). Project chat opens the project coordinator's chat; New starts a
   thread or a coordinator at the top level.
3. **Work is a card per coordinator holding the threads it runs**, nested coordinators as their own
   cards in the tree's order, and the project coordinator's card last with the threads started from the
   project. Open or Finished (`?work=finished`) replaces History: the same cards over resolved threads,
   folded. The cards read `orgTree`; they split it by parent, never regroup it by state.
4. **Waiting on you groups what waits by coordinator** (`asks --json`, ADR 0091), each answered in place
   as ADR 0093 says.
5. **Routines say whom they reach** (Organizations' `to`, `routine list --json`) and open beside the list
   with what they ask, from their file. A switch turns one on or off through `routine toggle`, only a
   routine the list names, from a write-level device. Creating one and approving a command stay at a
   terminal.
6. **A coordinator's page has Threads, Waiting on you, Routines and Status.** Threads is its work as
   Summary and tree (ADR 0089); Routines lists those whose `to` names it (`root` for the project's own);
   Status is its card and STATUS.md. The project page draws no STATUS.md: the project coordinator's
   is on its own page (`node/root`), as the approved Project artboard has it.

## Consequences

The phone draws everything as before; the split is one `useDesk()` at each route, so the phone's reads
never run on a desk and the other way round. Your asks and Routines as cross-project pages remain only on
a phone. A project with no coordinator under it no longer opens on its chat on a desk. A desk project's
Context tab is where [ADR 0101](./0101-a-threads-panel-opens-on-its-overview.md) point 4 sent the project's Context;
Notes has no desk view yet, so the bridge keeps `/api/org/tasks` and `/api/org/status`.

Revisit if the phone takes the same tabs (then the phone's pages and the redirects go), or if
Organizations publishes a routine field that a client may edit (then Routines gains a form).
