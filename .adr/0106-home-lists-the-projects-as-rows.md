# 0106. Home lists the projects as rows, each with what it holds

- **Status:** Accepted (2026-10-20). Requested by the operator. Reverses the earlier Home that left
  projects to the sidebar (Search on a phone), which no ADR recorded. Amends
  [ADR 0080](./0080-the-desks-bar-lists-projects-and-chats-the-tree-is-searchs.md) point 1's period
  names: the bar's chats sit under Today, Yesterday, Previous 7 days, Previous 30 days and Older, and
  only under the ones that hold a chat on screen.
- **Trail:** `web/src/components/home-projects.tsx` · `web/src/lib/desk-nav.ts` (`projectPulse`) ·
  `web/src/routes/projects.tsx` · `web/src/components/desk-nav.tsx` · `scripts/e2e/home-projects.ts`

## Context

Home said what needs you and listed sessions, but no project: to know where work stood the operator
opened each project from the bar. He asked for "a view of projects, well ordered" on Home. Three
shapes were built over the same herd (three projects: twenty open threads today with asks, work and
reviews, one moved days ago, one paused) and six fresh readers each got one capture and the same six
questions (what waits on you and where, how many work, how many to review, which is paused, when one
last moved, whether one has reviews):

| Shape | Desk | Phone | Height at 390 px | Clarity (1 to 5) |
|---|---|---|---|---|
| Rows (name, counts with their words, age) | 5 of 6 | 5 of 6 | 202 px | 4 |
| Cards (three numbers each) | 5 of 6 | 5 of 6 | 346 px | 4 |
| One line of chips (dots and numbers) | 4 of 6, 3 guessed | 3 of 6 | 106 px | 3 |

Cards never said which project was paused and pushed Recents below the phone's first screen; chips
left every number to the colour of its dot. A Projects tab beside Recents was not built: it hides the
answer behind a tap, which is what the operator complained about.

## Decision

1. **Home lists every project as a row** between Needs you and the sessions: its mark, its name, what
   waits on you, how many work and how many are ready to review, each count in words beside the dot
   the organization tree draws for it, and when it last moved. A project with nothing running says so
   and how many threads it holds open. Five rows, then Show all; See all opens Projects.
2. **The counts are `projectPulse`**, the same numbers Projects' cards draw, and nothing new is read.
   "Waiting" is Organizations' asks count (the project's own Waiting on you tab), never the headline's
   "needs you", which counts dialogs. "Working" counts the project's agents at work, the unit the
   headline counts (an agent outside every project counts only there): a review caught the headline saying 1 working above a row saying 11, when the
   row counted threads whose last group said working.
3. **Rows keep their place while on screen** (`useHeldTime`, ADR 0094): last activity first, paused
   ones last. The order comes back on a return to the page; with a handful of projects there is no
   "N updates" count, as Recents has.

## Consequences

Home grows by one row per project (five at most before Show all). On a desk the bar's project rows
and Home's rows name the same projects; the bar only says that something moves, Home says what.
Revisit if the readers' test is run again with a shape that answers all six on a phone in fewer than
200 px.
