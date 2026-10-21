# 0114. A tap on a coordinator enters its chat; its threads fold down where it is listed

- **Status:** Accepted (2026-10-21). Requested by the operator, who delegated the redesign. Amends
  [ADR 0109](./0109-a-coordinators-page-shows-live-work.md) point 2 (a tap on a coordinator's card
  opened its page), [ADR 0110](./0110-projects-is-homes-first-tab-and-a-phone-enters-a-coordinator-on-its-page.md)
  point 3 (a phone entered a coordinator on its page) and [ADR 0092](./0092-a-project-organizes-its-coordinators.md)
  point 1 (each coordinator a row into its page), and [ADR 0101](./0101-a-threads-panel-opens-on-its-overview.md)
  on a coordinator's own pane (its Overview holds more than three cards, New thread and History included).
  0109's other points hold, inside the chat.
- **Trail:** `web/src/components/desk-pages.tsx` (`CoordinatorWorkCard`, `useOpenCoordinator`) ·
  `web/src/components/desk-project.tsx` (`ProjectWork`) · `web/src/routes/project.tsx` (`PhoneWork`) ·
  `web/src/routes/node.tsx` · `web/src/components/coordinator-sections.tsx` · `web/src/components/project-frame.tsx` ·
  `web/src/components/thread-overview.tsx` · `web/src/components/agent-chat.tsx` (`threadBack`) ·
  `web/src/components/app-header.tsx` (`HeaderBack.desk`) · `web/src/lib/projects.ts` (`coordinatorPane`) ·
  `scripts/e2e/coordinator-chat.ts`

## Context

With 1.38.1 deployed the operator said that a project's coordinators still could not be entered,
that there was no arrow to go back, that a phone could not get in either, and that the › on the right
led to "esta pestaña de mierda, que es re tosco". What was expected: a tap on a coordinator
takes you inside it, to talk to it, and the threads it runs are seen by unfolding its row downward. The
page between the project and the chat (Threads, Waiting on you, Routines, Status, with Open chat in its
header) was one more stop on the way to the only thing wanted there.

`bun scripts/e2e/coordinator-chat.ts` counts the taps from Home to a coordinator's box, over the herd of
`phone-nav.ts` (Acme organizes coordinators; Nenu runs only its own):

| Coordinator | Before, 390 px | After, 390 px | Before, 1440 px | After, 1440 px |
|---|---|---|---|---|
| Acme's project coordinator | 3 (project, its page, Open chat) | 2 | 3 | 2 |
| Rediseño mobile (Acme) | 3 | 2 | 3 | 2 |
| Nenu's coordinator | 1 (the project opens on it) | 1 | 3 | 2 |

Before, a desk's coordinator chat showed no back control at all (the desk hides it where the bar lists
the parent) and a phone's went back to the page in between. After, both read "‹ Acme Shop" and land on
the project; its back reads "‹ Projects".

## Decision

1. **A tap anywhere on a coordinator's row enters its chat**, on a desk and on a phone, from the project
   page, the drawer, and any address that names the coordinator (`/project/<slug>/node/<id>` redirects to
   the chat, replacing itself). A coordinator with no live pane has no chat to enter: its row opens its
   page, as a thread's does (ADR 0064).
2. **The project page is one list of rows on both sizes**: each open coordinator, the project
   coordinator's last with the threads started from the project. A row reads its name and one line of
   what is live there (waiting on you, needs you, to review, working). A chevron before it, on a row with
   threads, folds them down in place; rows start folded and the fold lasts for the tab. + starts a thread
   under it, on a desk's hover only; no › at the end. A phone draws the same rows, and History is the same
   `?work=finished`.
3. **What the coordinator's page held lives in its chat.** On a desk, the panel's Overview: This
   coordinator, Waiting on you (answered in place), its Threads (with New thread and "N finished" to the
   project's History), Changes, Routines that reach it, Status (its card without the waiting asks, which
   sit above, and STATUS.md), then Move and Close coordinator, read only while the Overview is on
   screen (ADR 0075). On a phone, a fourth tab beside Chat,
   Threads and PRs: Status, counting what waits on you in red, with the same parts; Threads keeps the
   tree, its New thread now starting under this coordinator.
4. **The back control climbs the project's tree, on a desk too**: a coordinator to its parent
   coordinator or its project, a thread to its coordinator, a project to Projects. It is still the
   browser's Back where that is the screen before (ADR 0097), so the system's Back and the iOS swipe
   agree with it. A phone's project that opens on its own coordinator's chat (ADR 0092) leaves that chat
   Home above it.

## Consequences

- The page of a running coordinator is gone as a place: links to it, Your asks' Open coordinator and
  status lines land in the chat. A desk with the panel folded sees Waiting on you only after ⌘⌥B; the
  chat's own chips still count what needs you.
- Folded rows put threads one tap away on the project page; the row's line says what they do.
- The phone's tab bar holds four segments on a coordinator's chat. Revisit if a fifth is proposed: the
  bar is at its width at 390 px.
