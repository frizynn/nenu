# 0127. Home lists every open pull request the person authored, read in one request

- **Status:** Accepted (2026-10-25). Requested by the operator: "la pestaña de prs debe estar
  ordenada por repositorios y verse bonita, además no aparecen todos y creo que tarda mucho".
- **Trail:** `bridge/pull-requests.ts` · `web/src/lib/home-stats.ts` (`reviewQueue`, `reviewsByRepo`) ·
  `web/src/components/ready-to-review-list.tsx` · `scripts/e2e/fake-gh.ts`

## Context

Home's PRs came from one GitHub search per repo a pane sat in (`author:@me repo:<name>`, batched four
repos to a request, twelve repos at most). Measured on the operator's herd on 2026-10-25, read-only:

| | Per-repo search (2.4.0) | `viewer.pullRequests` |
| --- | --- | --- |
| Open PRs the person authored that Home showed | 5 of 26, in 1 of 14 repos | all 27, in 14 repos (one opened meanwhile) |
| Rows on the wire | 35 (one repo cloned in 7 folders, listed once per clone) | 27 |
| Refresh, background (3 runs) | 0.9 to 1.5 s | 2.3 to 3.8 s |
| Commands a refresh, same 25 folders | 1 `gh` + 60 `git` | 1 `gh` + 25 `git` (a folder already read costs its branch) |

The 21 missing PRs sat in 13 repos no pane was open in. Every agent works under the operator's own
`gh` login, so author was never the gap. The cap counted local folders, not GitHub repos: seven
clones of one repo and five local-only clones filled its twelve slots. That lost no PR that day, but
a thirteenth repo would have been dropped without a word.

`viewer.pullRequests` is the account's own list, not the search index: a PR opened a moment ago is
there, and it does not spend the search API's tighter rate limit. One request costs 2 points of the
5,000 an hour (`rateLimit(dryRun:true)`). It takes longer than a single repo's search, about 2.5 to
3.5 s against 0.5 to 1 s, whether it asks for each check or only their counts.

## Decision

1. **One read lists every open PR the person authored**, the newest 100 by last update, from
   `viewer.pullRequests` on github.com. A pane's folder no longer decides whether a PR is listed.
   It only decides which panes a PR opens in: a PR matches the panes on its branch in a repo whose
   remotes name its `owner/name`. An ssh alias names its repo by its path.
2. **The list survives a restart.** The last good read is kept in `<stateDir>/pull-requests.json`
   (0600, written atomically). A restarted bridge shows it at once, unless it is older than a day.
3. **Home groups them by repo.** Repos come by their latest PR update. Inside a repo, a PR one merge
   away comes first, then a blocked one (a check failing or changes asked for), then the rest, and
   drafts come last.

## Consequences

- A slower refresh never reaches the screen: the bridge answers from its cache and refreshes in the
  background. A cold start without a saved list waits about 3 s instead of up to 6.5 s.
- `/api/pull-requests` now carries PR titles from every repo the person has open PRs in, work orgs
  and private repos included. Any device that can read Home sees them, read-only devices too.
- Past 100 open PRs, the oldest ones drop out of the list and stop opening in their panes. The old
  limit was 50 per repo across 12 repos. Paging is the remedy if someone ever reaches it.
- A PR from a fork clone whose only remote is the fork does not open in its pane. This was true
  before too: the PR belongs to the upstream repo, which no remote names.
- Going back to asking per repo would bring back the missing PRs. If the list grows too long, group
  or fold it on the web; don't narrow what the bridge reads.
