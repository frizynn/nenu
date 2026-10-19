# 0092. A project organizes its coordinators; its own coordinator is one of them

- **Status:** Accepted (2026-10-17). Requested by the operator. Amends
  [ADR 0090](./0090-a-coordinators-status-file-is-drawn-as-written.md): on a project that organizes
  coordinators, the project coordinator's STATUS.md heads the page only while it says something. Point 1 is amended on a desk by [ADR 0100](./0100-on-a-desk-projects-and-coordinators-are-pages-with-tabs.md): a card per coordinator, the project coordinator's last, and no redirect to its chat.
- **Trail:** `web/src/components/new-dialog.tsx` (`CoordinatorsPane`) · `web/src/components/project-tasks.tsx`
  (`organize`, `MoveNodeDialog`) · `web/src/components/project-coordinator.tsx` · `web/src/routes/project.tsx` ·
  `web/src/lib/org-tree.ts` (`openCoordinators`, `moveTargets`) · `bridge/org-cli.ts` (`moveNode`, `canMoveNodes`) ·
  `scripts/e2e/coordinators.ts`

## Context

Nenu treated a project as having one coordinator: the project opened on its chat, its page led with a
"Coordinator · Not running · Start coordinator" block and its STATUS.md, and every other coordinator was
a row in the tree. Herdr Organizations already lets a project hold any number of coordinator nodes under
an optional root, and a real project runs that way: on 2026-10-17 `awam-org` had no root coordinator and
its work under one coordinator node, so its page opened on an empty template STATUS.md and a block saying
a coordinator was missing. The operator, that day: a project is like an organizer, not something with a
single coordinator; "+" should let him pick a project, then a coordinator or a new one, and land in its
chat.

## Decision

1. **A project with an open coordinator under it is the page of its coordinators.** It no longer opens on
   the project coordinator's chat. Each coordinator is a row that folds over its card, its work (a
   coordinator under it folds the same way) and New thread and New coordinator under it; the project
   coordinator is the first of them while it runs. The threads at the top level sit apart. A project with
   no coordinator under it is drawn and opened as before.
2. **The project coordinator is optional, never missing.** Without it there is no header saying it does
   not run: Start project coordinator is a small action beside New. Its STATUS.md heads the page only while
   Organizations reads something out of it (objective, asks, decisions); an Organizations without those
   fields cannot tell, and shows it.
3. **"+" goes project → coordinator → chat.** The New flow lists the projects; a project's step lists its
   coordinators, the project's own first while it runs, then every open coordinator in the tree's order.
   A coordinator started there opens its chat once its pane runs, else its page. It starts with
   `--can-spawn --kind=tab`, never on Organizations' defaults.
4. **Move is Organizations' `node move`, offered only where Organizations offers it.** Its help exiting 0
   says the binary has it, and a node's `actions` listing `move` says that node has another parent; the
   dialog lists the top level and open coordinators outside the node, and Organizations judges the rest.

## Consequences

The tree stays one model (ADR 0064): the page splits `orgTree`'s open level by role, it does not regroup
it. The card leaves its agent list to the tree beside it. Folds last for the tab's session, so a chat and
Back find the page as it was left.

Do not bring back a single "the coordinator" header for a project that has coordinators under it, and do
not redirect such a project to its own coordinator's chat. Revisit point 2 if Organizations publishes the
project coordinator as optional in its contract, and point 4 if `node move` gains a field naming where a
node may go.
