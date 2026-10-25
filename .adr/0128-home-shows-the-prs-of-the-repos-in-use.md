# 0128. Home shows the pull requests of the repos the herd is using, and filters them on the device

- **Status:** Accepted (2026-10-25). Amends [ADR 0127](./0127-home-lists-every-open-pr-the-person-authored.md):
  the bridge still reads every open PR; Home no longer lists all of them by default. Requested by the
  operator: "pero se debe poder filtrar y debe ser de los proyectos que 'están en uso' en herdr".
- **Trail:** `bridge/pull-requests.ts` (`inUse`) · `web/src/lib/pr-filter.ts` ·
  `web/src/components/ready-to-review-list.tsx` · `web/src/components/ui/quiet-menu.tsx`

## Context

2.5.0 listed every open PR the person authored (ADR 0127): 29 in 14 repos on the operator's herd,
most in repos no agent was working in. The operator wants the tab to be about the projects in use
in Herdr, and to narrow it further.

What "in use" can be read from, measured on the operator's herd on 2026-10-25, read-only:

| Source | What it names |
| --- | --- |
| `workspace.list` | id, number, label, focus, counts, active tab. No folder. |
| Panes' folders (`cwd`) | 37 panes in 24 folders, naming 3 GitHub repos through their remotes |

A Herdr workspace carries no folder, so the only place the herd says where it works is its panes.
The 24 folders name `frizynn/comercio-saas`, `kunchenguid/firstmate` and `frizynn/nenu` (several are
worktrees of one repo; three folders are outside git or have only a local remote). Of the 29 open
PRs, the 11 in `comercio-saas` are in use and 18 are not.

The old per-pane search (2.4.0) also scoped by pane folders, but missed PRs of in-use repos: one
search per folder, capped at twelve folders, so clones crowded repos out.

## Decision

1. **The bridge marks each PR `inUse`** when its repo is one the remotes of a pane's folder name
   (any remote, so a fork's upstream counts), within the same session. It still reads the list once,
   from `viewer.pullRequests`; in use is a filter over that read, never a narrower read. Each
   session's repos in use are kept with the saved list, so a restart marks PRs as before until git
   answers for one of that session's folders (in a repo, or in none); a git that fails or times out
   neither changes nor overwrites that session's record. A session the record does not name, as in a
   list saved by 2.5.0, marks every PR in use meanwhile, never none.
2. **Home lists the PRs in use by default**, and says how many more sit in repos no pane is in, one
   tap from all of them. With none in use it says so and offers all.
3. **The filter lives on the device**: In use or All repos, any of four states (the runs a repo already
   lists them in: ready to merge, needs attention, in review, draft) and any of the repos in the
   scope, kept in localStorage like the workspace order. A search over title and number narrows too
   and is not kept. One menu holds the choices, built on the same quiet menu as the workspace order.
4. **The headline counts what the tab lists** with the kept filter; a search does not change it.

## Consequences

- A repo whose PRs you care about but no pane sits in is hidden by default; "Show all" or the menu
  brings it back, and the choice stays on that device.
- A pane opened in a new repo marks its PRs in use within the 5 s a new folder waits for a refresh.
- A chosen repo with no PR in the scope narrows nothing until it has one again, so a stale choice
  never leaves an empty list; every repo of the scope chosen narrows nothing either.
- Herdr growing a workspace folder (or a project notion) would be a better source than pane
  folders: revisit then. Don't bring back per-repo GitHub searches to scope the list; they missed
  PRs and cost a request per repo.
