# 0080. The desk's bar lists projects and chats; the tree is Search's, and a finished chat is a +1 on its row

- **Status:** Accepted (2026-10-15). Amends [ADR 0064](./0064-the-organization-is-drawn-as-organizations-draws-it.md):
  the tree is still drawn as Organizations draws it, but the desk's sidebar no longer draws it.
  Point 3's "A phone keeps its toast" is amended by [ADR 0094](./0094-a-finished-agent-is-a-mark-on-its-row-on-a-phone-too.md).
- **Trail:** `web/src/components/desk-nav.tsx` · `web/src/lib/desk-nav.ts` ·
  `web/src/components/workbench-sidebar.tsx` · `web/src/hooks/use-transitions.ts` ·
  `web/src/components/status-area.tsx`

## Context

The desk's sidebar drew every project as a tree (coordinator, nested threads, panes outside them,
History) and then every loose workspace with its tabs and panes. The operator asked for Cursor's
agent window instead, and approved the design that takes the tree out of the bar
(designboard `nenu-cursor`, decision 2). With several projects the tree pushed the chats moved last
below the fold, and the bar answered "where" before "what changed".

On a desk, an agent finishing or asking elsewhere raised the app's lifecycle toast at the top right.
With Nenu open on a screen the bridge sends no push (ADR 0072), so that toast was the only notice,
and one with a destination was a link with no close control. The operator found it covering the page
every time and asked for "a +1 on the thread" instead.

## Decision

1. **The desk's bar is lists, not a tree.** New chat, Search, Home and Routines; every project as one
   row (glyph, the most pressing state among its agents, when it last moved), five before More; every
   open thread and every agent pane outside a project as a chat, under Today, Last 7 days, Last 30
   days and Older by its last real activity. A project's own coordinator is the project's row.
2. **The tree is Search's.** Opening Search on a desk shows the whole tree under the empty box, as the
   phone's sheet does; typing replaces it with results. Nothing the tree reached is lost: History,
   coordinators, panes outside threads, loose workspaces, tabs and shells are all there.
3. **On a desk a finished or asking chat is a +1 on its row, not a toast.** `useAgentTransitions`
   raises nothing at 1024 px and up. The row's +1 shows while the pane is `done` or `blocked` with
   activity after the last look in Nenu, and clears when the chat is opened. A phone keeps its toast
   and its push. Every remaining toast has a close button.

## Consequences

- The phone's drawer and Search sheet are unchanged: they still lead with the tree, folded.
- Restoring the tree to the bar, or the toast to the desk, reopens this; so does a desk layout that
  hides the sidebar by default (the rail's tiles show state, but no +1).
- Shell panes are not chats. On a desk they are reached through Search's tree or their workspace's
  tab strip.
