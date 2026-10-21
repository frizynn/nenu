# 0110. Projects is Home's first tab, and a phone enters a coordinator on its page

- **Status:** Accepted (2026-10-21). Requested by the operator. Amends
  [ADR 0107](./0107-home-lists-the-projects-as-rows.md): the rows stay, under a tab instead of above the
  tabs, and a row with asks opens its project. Amends [ADR 0092](./0092-a-project-organizes-its-coordinators.md)
  point 1 on a phone: a coordinator's row opens its page instead of folding over its card. Point 3 amended by
  [ADR 0114](./0114-a-tap-on-a-coordinator-enters-its-chat.md): the row enters the coordinator's chat.
- **Trail:** `web/src/components/home-projects.tsx` · `web/src/components/home-panels.tsx` (`HomeSessions`) ·
  `web/src/routes/project.tsx` · `web/src/components/project-tasks.tsx` (`organize`) ·
  `web/src/components/workbench-sidebar.tsx` (`ProjectSection`, `DrawerSections`) · `web/src/routes/node.tsx` ·
  `web/src/components/desk-nav.tsx` (`DeskProjects`) · `web/src/components/sidebar-rail.tsx` ·
  `scripts/e2e/phone-nav.ts` · `scripts/e2e/no-projects.ts`

## Context

ADR 0107 put the projects above Recents and turned down a Projects tab because it hides the answer
behind a tap. The operator read that Home and asked for exactly the tab: the projects one tab among
Recents, Workspaces and PRs, with only what is live in sight and finished work kept away, reachable.
On the same day he said that on a phone "it is impossible to get into a coordinator".

`bun scripts/e2e/phone-nav.ts` walked a phone (390x844) over a herd shaped like his: a project whose
running coordinator organizes two others, one whose coordinator only has workers, and a quiet one.

| From | Before | After |
|---|---|---|
| Home, a project with asks | its asks list; no project, no coordinator | its page, then the coordinator: 2 taps |
| Project page, a coordinator's row | its chat; the › folded a card in place | its page (status, threads, Open chat): 1 tap |
| Drawer (☰) | Recent before Projects; a coordinator opened its chat; History and open-task counts | Projects after Needs you; a coordinator opens its page: 3 taps |

None of the 3 coordinators of the organizing project was reachable from Home before; after, each
top-level one is 2 taps away and the nested one 3. A coordinator's chat is one more tap from its page,
and the project with only its own coordinator still opens on that chat (ADR 0092).

## Decision

1. **Home's lists are one tab control: Projects, Recents, Workspaces, PRs.** Projects comes first and
   is what Home opens on; the choice is remembered on the device under a new key, so a choice made
   before the tab existed opens on Projects once. Projects and PRs show only while there is one, and a
   remembered tab that is not there opens the first one left, kept for when it comes back.
2. **The Projects tab leads with live projects**: something waits on you, works, or is ready to
   review there. The rest (nothing running, paused last) fold under one "Quiet" row at its end. Each
   row is ADR 0107's, and always opens its project; the project page says what waits on you there.
3. **On a phone a coordinator opens its page**, from the project page and from the drawer: its card,
   its live threads, Open chat and New under it, Close as a quiet action at the end. Its threads are
   listed there, not on the project page.
4. **On a phone the project page and the drawer show only what is live first.** The project page drops
   the goal and heads with "N asks wait on you"; History stays its folded last line. The drawer lists
   Needs you, Projects, Workspaces, then Recent; there and on the Search sheet before anything is typed,
   a project opens on its coordinators and the threads that wait on you, work or wait for a review,
   with no History and no open-task count. Home's headline
   leaves idle agents out, a phone's Home leaves the date out, and no footer counts workspaces or agents.
5. **Without a project no list or bar says Projects** (amended 2026-10-21): not Home's tab, nor on a desk
   the bar's Projects row, its Projects heading with its +, or the folded rail's Projects button. Someone
   without Organizations, or with no project in it, sees Recents first; New project stays in New, under
   its own Projects group, and `/projects` still answers a link.

`bun scripts/e2e/no-projects.ts` loads Home at 390x844 and 1440x900 over four herds: one project,
Organizations with none, no Organizations, and one that never answers. The tabs come with the first
snapshot, whose projects the bridge reads from the files before Organizations answers, so each load drew
one set of tabs and kept it: no tab shows and then goes. Before the amendment, the three herds without a
project drew Recents first on both sizes and still said Projects three times on a desk; after, none.

## Consequences

Recents is a tap further away than it was. A coordinator's chat is two taps from a project on a phone,
one more than before, in exchange for its page being reachable at all. Revisit if the operator asks for
the chat again from the project page; the page's Open chat is the place to measure from. A desk with no
project has no shortcut to the Projects page; its first project starts from New.
