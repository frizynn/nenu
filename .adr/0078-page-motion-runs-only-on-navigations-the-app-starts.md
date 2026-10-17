# 0078. Page motion runs only on navigations the app starts

- **Status:** Accepted (2026-10-15).
- **Amended by:** [ADR 0095](./0095-the-back-control-steps-back-through-the-history.md): the back steps back through the history, and an armed replace or history step animates.
- **Trail:** `web/src/lib/motion.ts` · `web/src/router.tsx` · `web/src/index.css` (Page motion) ·
  `web/src/lib/notification-open.ts` · `web/src/sw.ts` · `scripts/e2e/run.ts motion`

## Context

Moving between pages had no motion: going back, opening a notification and returning Home were
plain cuts, and a notification tapped with the app open reloaded the whole page
(`client.navigate`). Nenu had view transitions once and removed them (`1d925922`), because React
Router's `viewTransition` flag replays a transition on every revalidation after a Back: a revalidation
reuses `state.historyAction`, which stays `POP`, and `completeNavigation` then fires
`startViewTransition` for any path in its `appliedViewTransitions` map. With a poll every few seconds
that is a full-page flicker on every tick (react-router 7.18, read in `completeNavigation`).

Measured in WebKit (webkit-2287) on the bench: a separately named part of the page (the header, the
tab bar) keeps its old picture but draws no new one during a same-document transition, while
Chromium draws both. The whole page as one picture (`root`) draws in both.

## Decision

1. Never use React Router's `viewTransition` flag, on a `<Link>` or a `navigate()`. `lib/motion.ts`
   wraps `router.navigate`, which only `<Link>`, `useNavigate` and our own code call; it starts the
   transition itself. A revalidation, a loader redirect and the browser's Back or a swipe never pass
   through it, so they never animate.
2. The navigation starts inside the transition's update callback, after the old page is captured, and
   the old page holds only until the new one commits or 300 ms, whichever is first. Past that the
   change goes through unanimated, as before. Data loading never waits on the animation.
3. The page moves as one picture. A deeper page (route `handle.depth`) is a push, the header's back
   control is a pop, anything else is a cross-fade. Reduced motion and a desk (from 1024 px, where the
   sidebar must not move) only cross-fade. A `replace`, a search-only change and the same path never
   animate.
4. A tapped notification asks the open app to navigate itself (`nenu:open` message, answered), and
   the service worker falls back to `client.navigate` only when no answer comes.

## Consequences

- One frame more from tap to the new page in the DOM, the capture: on the bench, medians of 8, going
  back took 5 to 7 ms before and 18 to 20 ms after, opening a pane 23 to 32 ms before and 36 to 44 ms
  after.
- The header slides with the page instead of staying put as on iOS. Revisit if WebKit draws named
  groups in a same-document transition, verified on a real iPhone.
- Browser Back and the iOS edge swipe stay unanimated by Nenu, so they never fight the browser's
  own gesture animation.
- `bun scripts/e2e/run.ts motion` counts `startViewTransition` calls on a quiet page; any value
  above 0 is a regression of decision 1.
