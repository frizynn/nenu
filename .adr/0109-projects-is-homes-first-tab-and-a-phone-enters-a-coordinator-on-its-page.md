# 0109. Projects is Home's first tab, and a phone enters a coordinator on its page

- **Status:** Accepted (2026-10-21). Requested by the operator. Amends
  [ADR 0107](./0107-home-lists-the-projects-as-rows.md): the rows stay, under a tab instead of above the
  tabs, and a row with asks opens its project. Amends [ADR 0092](./0092-a-project-organizes-its-coordinators.md)
  point 1 on a phone: a coordinator's row opens its page instead of folding over its card.
- **Trail:** `web/src/components/home-projects.tsx` · `web/src/components/home-panels.tsx` (`HomeSessions`) ·
  `web/src/routes/project.tsx` · `web/src/components/project-tasks.tsx` (`organize`) ·
  `web/src/components/workbench-sidebar.tsx` (`ProjectSection`, `DrawerSections`) · `web/src/routes/node.tsx` ·
  `scripts/e2e/phone-nav.ts`

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

None of the 3 coordinators of the organizing project was reachable from Home before; all 4 are within
2 taps after. A coordinator's chat is one more tap from its page, and the project with only its own
coordinator still opens on that chat (ADR 0092).

## Decision

1. **Home's lists are one tab control: Projects, Recents, Workspaces, PRs.** Projects comes first and
   is what Home opens on; the choice is remembered on the device under a new key, so a choice made
   before the tab existed opens on Projects once. Projects and PRs show only while there is one.
2. **The Projects tab leads with live projects**: something waits on you, works, or is ready to
   review there. The rest (nothing running, paused last) fold under one "Quiet" row at its end. Each
   row is ADR 0107's, and always opens its project; the project page says what waits on you there.
3. **On a phone a coordinator opens its page**, from the project page and from the drawer: its card,
   its live threads and Open chat, Close as a quiet action at the end. Its threads are listed there and
   not again on its card or on the project page.
4. **On a phone the project page and the drawer show only what is live first.** The project page drops
   the goal and heads with "N wait on you"; History stays its folded last line. The drawer lists
   Needs you, Projects, Workspaces, then Recent; a project opens on its coordinators and the threads
   that wait on you, work or wait for a review, with no History and no open-task count. Home's headline
   leaves idle agents out, a phone's Home leaves the date out, and no footer counts workspaces or agents.

## Consequences

Recents is a tap further away than it was. A coordinator's chat is two taps from a project on a phone,
one more than before, in exchange for its page being reachable at all. Revisit if the operator asks for
the chat again from the project page; the page's Open chat is the place to measure from.
