# 0064. A project's organization is drawn the way Herdr Organizations draws it

- **Status:** Accepted (2026-10-11)
- **Trail:** `web/src/lib/org-tree.ts` · `web/src/components/project-tasks.tsx` ·
  `web/src/components/workbench-sidebar.tsx` · `web/src/routes/node.tsx` · Organizations `src/ui.rs`
  (`open_tree`, `history`, `start_close`)

## Context

Until 0.58, Nenu drew a project four ways. The project page nested open threads and ranked a
coordinator by its most urgent thread; the panel beside a coordinator and the phone's Threads tab
grouped every thread flat under Needs you, Ready to review, Working and Resolved; the sidebar kept
Organizations' id order; the cards under a coordinator's chat added the two newest resolved threads.
Resolved threads were one flat list, oldest first, and their dot was the green of a finished agent.
A thread with no live pane linked to the project page, which redirects to the coordinator's chat.
Measured on a real project on 2026-10-10: 91 nodes, all resolved, 8 of them coordinators running 20
of the threads; the sidebar showed "History 91" as one flat list.

Organizations' popup settled three rules the person approved: only open work in the tree, at any
depth, coordinators first and then needs you, review, working, idle; everything resolved in one grey
History tree, each resolved coordinator holding the threads it ran, coordinators first and newest
first; and opening a node shows it, it never jumps elsewhere. The popup refuses to close a
coordinator that still runs open nodes, and replaces the project coordinator with a chosen agent.

## Decision

1. **One model.** `orgTree` builds the open tree and the History tree from Organizations' parent
   field; `nodeState` reads its group the way the popup does. Every view of a project draws from
   them: the project page, the panel, the phone's Threads tab, the cards, the sidebar, the node page.
   Don't group a project's nodes by state again.
2. **Resolved work is grey and lives only in History**, closed until opened.
3. **A tap opens the node inside Nenu**: its chat when it runs in a live pane, its detail page
   (`/project/:slug/node/:id`) otherwise. A node's detail never redirects to a chat.
4. **Close refuses a coordinator with open nodes under it**, in the client and in the bridge; the
   project coordinator is never closed, only replaced (`coordinator replace --profile`).

## Consequences

Nenu and the popup can no longer disagree on order or on what counts as open, and a change to the
rules lands in one function. A coordinator whose only urgent work is nested reads by its own state,
not its threads', as in the popup; the red dot on the thread underneath still says it.

Revisit if Organizations publishes the tree itself in its `--json` contract; Nenu should then read
it instead of rebuilding it.
