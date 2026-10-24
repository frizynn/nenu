# 0123. Nenu draws Herdr alone; Herdr Organizations left the app

- **Status:** Accepted (2026-10-24). Requested by the operator, who stopped using Herdr Organizations
  and runs the same work with firstmate. Supersedes ADRs 0061, 0064, 0088, 0089, 0090, 0091, 0092,
  0093, 0096, 0099, 0101, 0102, 0103, 0105, 0106, 0107, 0109, 0110, 0115, 0119, 0121 and 0122, and
  amends 0072, 0075, 0080, 0095, 0097 and 0108 where they speak of projects, coordinators or threads.
- **Trail:** what this removed is in git history at `21add74e` (`bridge/projects.ts`,
  `bridge/org-cli.ts`, `bridge/routes/org.ts`, `web/src/lib/org-tree.ts` and the views built on them).

## Context

From 0.54.0 Nenu read Herdr Organizations (the `herdr-organizations` CLI, its registry under
`~/.herdr-projects`) and drew its projects, coordinators, threads, asks, routines, reports, library
and pull request actions, on a phone and a desk. By 1.46.0 that was most of the web app and a third
of the bridge: a registry watcher, a CLI adapter with a fallback for upstream herdr-projects, nine
read routes and sixteen write routes, the pane tokens Organizations writes, and a coordinator mark
store. Every Home list, the sidebar, the New flow, the chat header, its chips and its panel branched
on whether a pane belonged to a project.

The operator stopped using Organizations and moved the same work to firstmate, which runs its
agents as plain Herdr panes. Nothing in the app drew those agents better for the Organizations code
around them, and every change to Home, the sidebar or a chat had to keep both shapes working.

## Decision

1. Nenu reads Herdr and the agents' own files, and nothing else about how agents are organized. The
   bridge does not run `herdr-organizations` or `herdr-projects`, does not read their registry, and
   copies none of a pane's plugin tokens into its views.
2. The snapshot carries no `projects` and no `looseWorkspaceIds`; there is no `/api/org/*` route and
   no `org` live event. `COLLIE_HERDR_ORGANIZATIONS_BIN` and `HERDR_PROJECTS_ROOT` mean nothing to it.
3. The web app has no Projects, project, node, Your asks or Routines page. Home lists Recents,
   Workspaces and PRs; the sidebar, its rail, the phone's drawer and Search list workspaces and chats;
   New starts a tab, a workspace or a quick question; a chat is named by its pane, its back goes Home,
   its chips count its own background work, and its desk panel opens on Changes.
4. A notification names a pane by its own labels; with no coordinator to start a turn, every typed
   turn is a person's.
5. An organizer that comes back (firstmate's or another) is drawn through a new decision, reading a
   contract that tool publishes, never by restoring this code.

## Consequences

- An old link to `/project/…`, `/asks` or `/routines` lands on the not-found page, which offers Home.
- A coordinator mark picked in 1.46.0 stays in `coordinator-marks.json` in the state directory,
  unread. Deleting it is the operator's call; Nenu never reads it again.
- What Organizations gave and Herdr does not (a thread's title as its name, a project's pull request
  actions, the tree of who delegates to whom) is gone. A pane's own label, Claude's `/rename` and
  GitHub's pull requests on a session's branch stand in where they can.
- Revisit only with an organizer whose model the operator wants on the phone, by writing the ADR in
  point 5 first.
