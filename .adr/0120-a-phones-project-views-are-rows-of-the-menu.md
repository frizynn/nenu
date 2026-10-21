# 0120. A phone's project views are rows of the ⋯, and what waits on you is counted on it

- **Status:** Accepted (2026-10-22). Requested by the operator, who chose where the views go (the ⋯)
  and delegated the rest. Amends [ADR 0115](./0115-a-tap-on-a-coordinator-enters-its-chat.md) point 3
  (a phone's Status as a fourth tab beside Chat, Threads and PRs) and its consequence on the phone's tab
  bar. 0115's other points hold.
- **Trail:** `web/src/components/project-frame.tsx` (`phoneViews`, `menu`) ·
  `web/src/components/conversation-actions.tsx` (`waiting`) · `web/src/components/agent-chat.tsx`
  (`menu`) · `scripts/e2e/coordinator-chat.ts` · `scripts/e2e/phone-nav.ts`

## Context

Since 1.23.0 a project chat on a phone drew Chat · Threads · PRs as a segmented band under its title,
and 1.40.0 added Status to it. On a coarse pointer the band is 60 px of the chat's height at 390×844,
on every project chat, all the time. The operator, on an iPhone at 1.41.2: "se ven mal los tabs, son
gigantes en mobile en este coordinador; debe ser un toggle y más chico, tocando los 3 puntitos".

Three shapes were drawn over the same coordinator at 390×844 (the band from the header's foot):

| | Band in the chat | Band in a view | Chat → a view | A view → Chat | A view → another |
| --- | --- | --- | --- | --- | --- |
| Before: the 52 px track | 60 px | 60 px | 1 tap | 1 tap | 1 tap |
| The ⋯'s rows, a 32 px switch in an open view | 0 | 44 px | 2 taps | 1 tap | 1 tap |
| The ⋯'s rows, a "‹ Chat" line in an open view | 0 | 40 px | 2 taps | 1 tap | 2 taps |
| A 32 px track, always shown | 40 px | 40 px | 1 tap | 1 tap | 1 tap |

The always-shown track keeps two thirds of the band in the chat, where it is read most. The "‹ Chat"
line saves nothing over the small switch and costs a tap between views.

## Decision

1. **On a phone a project chat draws no views under its title.** Chat, Threads (with its count), PRs
   (with its count) and, on a coordinator, Status are the first rows of the header's ⋯ menu, under
   Show, the open one checked. A desk is unchanged: its panel holds them.
2. **What waits on you is counted on the ⋯ itself**, in red, so it shows with the menu shut, and on the
   Status row: the asks Status answers, as its tab did. Nothing else is counted there: a thread's or a
   PR's count is not a request, and the threads that need you keep their own Needs you chip under the
   box, which counts threads, not asks, so the two numbers can differ.
3. **An open view draws the same switch at 32 px** in a 44 px band under the title, which each tab's
   touch reach fills (measured: 44 px down a tab's centre; in a 40 px band the header took the top 2),
   so Chat and the other views stay one tap away. It leaves with the view.
4. The view stays in the URL (`?view=`), replaced, as before.

## Consequences

- Reaching a view from the chat is one tap more (2: the ⋯, the row); the chat gains 60 px. Revisit if
  the operator ends up living in a view rather than the chat.
- The ⋯ menu grows by four rows on a coordinator's chat. Its other groups keep their order.
- `bun scripts/e2e/coordinator-chat.ts` fails when a phone's chat draws views under its title, a view
  takes more than 2 taps, or Acme's waiting ask is not on its ⋯; `bun scripts/e2e/phone-nav.ts` fails
  when an open view's switch is taller than 32 px or its Chat takes a finger over less than 44 px.
