# 0124. Workspaces keep Herdr's order, or the operator's, never their agents' activity

- **Status:** Accepted (2026-10-24). Requested by the operator; where the choice is kept was delegated.
  Amended the same day: the sort and the drag are two controls above the list, not one menu beside the
  tabs ("es raro que lo de reorder esté dentro del selector").
- **Trail:** `web/src/lib/workspace-order.ts` · `web/src/lib/workspace-tree.ts` (`workspaceTree`) ·
  `web/src/components/home-panels.tsx` (`HomeSessions`) · `web/src/components/workspace-order-menu.tsx` · `web/src/components/workspace-tree.tsx` ·
  `web/src/components/ui/list-reorder.ts` · `scripts/e2e/workspace-order.ts`

## Context

Every list of workspaces (Home's Workspaces, a phone's drawer) came from `workspaceTree`, which put
the workspace whose agent last changed state first and Herdr's order only between the rest
(4becf61d, so that opening a pane stopped moving its row). On the operator's herd of 23 workspaces
(2026-10-24) that read as a shuffle: Herdr keeps a parent workspace and the `└ child` ones it spawned
next to each other, and the activity order pulled the children away from their parents and moved
rows every time an agent finished. The operator: "la vista de workspaces de Nenu debe respetar el
orden o que se pueda ordenar por nombres o reordenar si toco un botón que me permita ordenar con
drag". They read Nenu mostly on a phone.

| Where the choice lives | Same on every device | Cost |
| --- | --- | --- |
| The browser (`localStorage`) | no | none: Home's remembered tab is kept there |
| Nenu's state dir, in the snapshot | yes | a route, a file, a snapshot field and an event |
| Herdr itself (`workspace.move`) | yes | a drag rewrites the operator's real Herdr order, and Name could not be a mode |

## Decision

1. **A list of workspaces is in Herdr's order** (`number`, which `workspace.move` renumbers), never
   ranked by what its agents did or by which one is open. Recents is where activity orders sessions.
2. **The operator may choose Name, or Custom**, from Home's Workspaces: an Order menu above the list
   names the order on screen and holds only orders. Reorder, beside it, makes each row a handle to
   drag, by finger or mouse, starting from the order on screen, until Done; Arrow keys on a handle
   move it one place. A move makes the order Custom, which the menu lists once there is one. A workspace opened since a custom order was set
   goes at its end, in Herdr's order; a closed one drops out. The drawer follows the same choice.
3. **The choice is kept on this device**, in `localStorage`, like the rest of a device's view. It
   never writes Herdr: a drag here is not `workspace.move`.

## Consequences

- A row stays where the operator put it, so a finished agent no longer moves its workspace; what moved
  last is Recents' to say.
- A phone and a desk can disagree on a custom order. If the operator asks for one order everywhere,
  move the store into the bridge's state dir and serve it in the snapshot, rather than writing
  Herdr's order.
- The handle takes the touch (`touch-action: none`) so a finger drags at once; the rest of each row
  still scrolls the list. Don't make the row itself draggable with a hold: in this list a tap already
  opens the workspace, and a hold would compete with the scroll the list needs.
