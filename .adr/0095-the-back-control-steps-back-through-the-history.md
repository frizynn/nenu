# 0095. The back control steps back through the history

- **Status:** Accepted (2026-10-17). Amends [ADR 0078](./0078-page-motion-runs-only-on-navigations-the-app-starts.md), point 3.
- **Trail:** `web/src/lib/motion.ts` (`useGoUp`, the `nenuFrom` stamp) · `web/src/components/app-header.tsx` ·
  `web/src/components/project-frame.tsx` · `web/src/router.tsx` (`keepInPlace`) · `scripts/e2e/run.ts back`

## Context

The header's back was a `<Link>` to the parent, so it pushed the parent as a new page. Home → project →
coordinator → thread and three backs left `history.length` 8 entries above where it started, and the
system's Back (the iOS swipe, Android's button) then walked thread → coordinator → project again before
leaving: "tengo que ir para atrás 200 veces". A sibling chip pushed too, and a phone coordinator's tab
lived in component state, so coming back landed on Chat instead of the list you left. Every pane sits at
one route depth, so a coordinator → thread move cross-faded and the way back slid out.

Measured with `bun scripts/e2e/run.ts back` (WebKit, 390 px): before, three backs from a thread took
`history.length` from 2 to 10 and the system's Back from Home went to the project; after, 2 to 5 (one per
level walked down) and the system's Back from Home leaves Nenu.

## Decision

1. Every navigation the app starts records, in its history entry's state, the page it came from. A replace
   keeps the entry's place, so it keeps that page too. The state survives a reload.
2. The back control, and any move up the tree, calls `useGoUp(parent)`: when the entry before is the parent
   (same path and session, whatever tab or docked thread it shows), it is `navigate(-1)`; otherwise the
   parent replaces the page. It never pushes.
3. Across the tree (a sibling) replaces; down the tree (a coordinator's thread) pushes. The caller names
   the motion with `armMotion`, and an armed replace or history step animates: down is a push, up a pop,
   across a fade. The browser's own Back still never animates.
4. What a chat shows in place (`?view=`, `?thread=`) lives in the URL and is replaced, and a change of
   only those re-runs no loader.

## Consequences

- The app's back and the system's agree, so neither can strand you in a loop of the pages you came through.
- Entering a thread from outside its project (a notification, Home) and pressing back replaces it with its
  coordinator: the system's Back then skips the thread, as a pop on iOS would have.
- A modified click on the back still opens the parent's address as a link.
- Revisit if Nenu ever needs forward history to be meaningful inside a project: replacing siblings means
  the browser's Forward cannot return to a sibling you left.
