# 0097. The back control returns to the screen you came from

- **Status:** Amended by [ADR 0123](./0123-nenu-draws-herdr-alone.md) (2026-10-24), which removed projects, coordinators and threads. Accepted (2026-10-18). Amends [ADR 0095](./0095-the-back-control-steps-back-through-the-history.md), point 2.
- **Trail:** `web/src/lib/motion.ts` (`useGoBack`, `useGoUp`) · `web/src/components/app-header.tsx` (`StepLink`) ·
  `web/src/components/column-page.tsx` (`useKeptScroll`) · `scripts/e2e/origin.ts`

## Context

ADR 0095's back stepped back only when the entry before was the page's parent in the tree; from anywhere
else it replaced the page with that parent. So a thread opened from Your asks, Home, Search or its own
page went back to its coordinator, a coordinator opened from Home went to its project, and the system's
Back (the iPhone's swipe) went somewhere else than the app's ‹. Pages also came back scrolled to the top.

Measured with `bun scripts/e2e/origin.ts` (WebKit, 390 x 844, iPhone user agent), twelve ways in: before,
6 of 12 backs landed on the parent instead of the screen left, and Your asks came back at scroll 0 from
1049; after, 12 of 12 land where they came from, at the same scroll. Home → project → coordinator →
Threads → ‹ → ‹ stays at the entry + 2.

## Decision

1. The back control (the header's ‹, and Back on a chat outside a project) is `useGoBack(parent)`: when
   the entry was opened from a screen of the app (its `nenuFrom`, ADR 0095 point 1), it is the browser's
   Back, whatever that screen was. Otherwise (a link, a launch from a notification, a new tab) `parent`
   replaces the page, once, so the history never grows.
2. A move up the tree to a named node (a thread's coordinator chip, History's ✕, a file page's Done)
   stays `useGoUp(parent)`: Back when the entry before is that node, a replace otherwise.
3. A page scroller (`PageBody`) keeps its position per history entry and puts it back when the history
   steps back to that entry, applying it as late content grows the page, until it fits or the person
   scrolls. A pushed or replaced page opens at the top. Filters live in the URL, so Back restores them.

## Consequences

- The app's ‹ and the system's Back agree from every screen the app opened.
- A thread opened from a notification while Nenu was open goes back to the screen under it; one that
  launched Nenu goes to its coordinator, once.
- The positions live in memory: a reload starts each page at the top.
