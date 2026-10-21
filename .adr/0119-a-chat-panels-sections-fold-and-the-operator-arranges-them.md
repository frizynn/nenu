# 0119. A chat panel's sections fold, and the operator arranges them; a coordinator's Threads lists its whole subtree

- **Status:** Accepted (2026-10-21). Requested by the operator, who delegated the design. Amends
  [ADR 0115](./0115-a-tap-on-a-coordinator-enters-its-chat.md) (what a coordinator's page held, drawn
  inside its chat as a column of cards) and [ADR 0101](./0101-a-threads-panel-opens-on-its-overview.md)
  (the Overview's cards in a fixed order, a coordinator's Threads card listing its direct threads).
- **Trail:** `web/src/components/panel-sections.tsx` · `web/src/lib/panel-layout.ts` ·
  `web/src/components/thread-overview.tsx` (`threadsSection`, `CoordinatorOverview`) ·
  `web/src/components/coordinator-sections.tsx` (`useCoordinatorSections`) · `web/src/lib/org-tree.ts`
  (`workUnder`) · `bridge/projects.ts` (`keptThreads`) · `scripts/e2e/overview-sections.ts`

## Context

With 1.41.1 deployed, looking at a coordinator's panel, the operator asked to fix its errors, to be
able to hide things "tipo un desplegable en cada cosa", to reorder them, and to see the threads that
run, "no sé dónde están los threads"; perhaps tabs inside Overview. The same evening awam-org's Mi
Cúcula read "Nothing running · 78 finished" with 16 nodes open under it.

Measured with `bun scripts/e2e/overview-sections.ts` over Mi Cúcula's shape (its own threads, two
coordinators under it, one more level below one of them, 16 finished), 1440×900:

| | Before (1.41.1) | After |
|---|---|---|
| Open rows the panel lists | 5 of 12 (direct children only) | 12 of 12, grouped by coordinator |
| First running thread, px below the panel's top | 702 (under two questions) | 162 |
| "Nothing running" against its card's edge | yes | no |
| Chips reading "missing" | 2 | 0 |

The live "Nothing running" had a second cause, in the bridge: a project past 500 threads was cut in id
order, dropping the newest, the running ones (awam-org had 553; 36 of its 45 open threads never
reached Nenu). 1.41.2 keeps every open thread and drops the oldest finished.

Two shapes were drawn over the same panel: tabs inside Overview (Threads, Waiting on you, Changes,
This, Status) and sections that fold under their heads. Tabs stacked a second row of tabs under the
panel's own (Overview, Changes, Files, Terminal), named Changes twice, and cost a tap for every
section but the first; a count on a hidden tab is all that says something waits on you. Folding
sections keep everything one scroll away: Threads at 64 px, Waiting on you at 743 px with everything
open, and at the top once Threads is folded, which the device remembers.

## Decision

1. **Every section of a chat's panel folds under its head** (`PanelSections`): a desk's Overview and a
   phone's Status tab alike. The head keeps a badge that still says what is inside when folded (what
   is alive in the threads, the questions' count, the state). It folds on the shared `Fold` and
   `desk-fold` motion (ADR 0111).
2. **Arrange moves and hides sections; the device keeps it, and Reset forgets it**
   (`lib/panel-layout.ts`, localStorage per kind of panel). A section the layout never heard of takes
   its default place after the one it follows; a hidden one is drawn nowhere until shown again.
3. **No tabs inside Overview.** The panel already has its tabs; a second row repeats them.
4. **A coordinator's Threads lists the open work of its whole subtree, first** (`workUnder`): its own
   threads, then one group per coordinator under it, most urgent first, each row its state, what it
   does when that says more than its mark, and a tap to open it. Finished work stays a link to History.
5. **A task the tracker does not have draws no chip**; its context says "not in the tracker".

## Consequences

- The order a panel opens in is the operator's on that device, not one the app can rely on; nothing may
  assume a section's position.
- A section's badge is the only thing a folded section says; a new section must give one when what it
  holds can change without a look.
- Revisit tabs if a panel ever holds so many sections that folding them all still scrolls.
