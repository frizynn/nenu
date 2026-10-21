# 0111. One set of motion, hover and mark tokens

- **Status:** Accepted (2026-10-21). Requested by the operator ("more professional, native, subtle
  and smooth", Ovis as the reference) after six threads built pages in parallel.
- **Trail:** `web/src/index.css` (`--motion-*`, `--color-hover`) · `web/src/lib/motion.ts` ·
  `web/src/components/status-badge.tsx` · `web/src/components/node-row.tsx` ·
  `web/src/components/desk-pages.tsx` (`DeskTabs`) · `web/src/components/ui/button.tsx` ·
  `web/src/calm-motion.test.ts` · `web/src/design-system.test.ts` · `scripts/e2e/tour.ts`

## Context

`bun scripts/e2e/tour.ts` walks every screen at 1440×900 and 390×844, dark and light, and counts what
each one draws. On 1.38.0 it measured, across the app:

| What | Values found |
|---|---|
| Durations | 100, 120, 140, 150, 160, 180, 200, 220, 280, 300 ms |
| Curves | `ease-out`, `ease-in`, Tailwind's `(0.4, 0, 0.2, 1)`, `(0.2, 0, 0, 1)`, `(0.23, 1, 0.32, 1)`, `(0.32, 0.72, 0, 1)` |
| Hover fills | `accent`, `accent/30`, `/40`, `/60`, `muted`, `muted/40`, `/50`, `--workbench-row-hover` |
| Status dots | 6, 8 and 10 px, picked per caller |
| Page tabs on a desk | underlined (project, coordinator) and pills (Home) |
| Button labels | 14 px, a size the type scale does not have |

Each was reasonable where it was written; together they read as several apps. Every new page invites
another "200 ms feels right here".

## Decision

1. **Three lengths and one curve.** A control answers in 120 ms (colour, a press, a chevron, a
   tooltip, any exit); a panel arrives or folds in 180 ms (sheets, popovers, revealed rows, a docked
   column); a page slides in 280 ms. All on `cubic-bezier(0.2, 0, 0, 1)`, Ovis's curve. Stylesheets
   name `--motion-*`; components use `duration-120/180/280` and `ease-out`, which index.css points at
   the same tokens; script motion reads `lib/motion.ts`'s constants. Reduced motion keeps its own
   rules, and nothing animates forever (calm-motion.test).
2. **One hover fill.** `hover:bg-hover` and `var(--workbench-row-hover)` light a row or a control; a
   press steps up to `accent`. Only a control that rests on a fill hovers above it.
3. **One status mark, 6 px.** `StatusDot` and `NodeDot` own the size; only an avatar's corner badge
   passes its own.
4. **A desk's page tabs are underlined** (`desk-tab`), Home's too; pills (`panel-tab`) are for the
   session panel's tabs. A phone keeps its segmented track.
5. **Buttons are on the type scale:** footnote at a desk, subhead on a coarse pointer, body for the
   large ones.

## Consequences

- `calm-motion.test` fails on a literal duration or curve in a stylesheet and on any other duration
  class; `design-system.test` fails on another hover tint. A new motion picks a length by what it
  answers, not by feel.
- The page slide's iOS curve `(0.32, 0.72, 0, 1)` is gone; the shared curve starts as fast and settles
  a little sooner. Revisit only with a measured reason that applies to every slide, not one page.
- A component that needs a fourth length is a sign it is two motions; split it before adding a token.
