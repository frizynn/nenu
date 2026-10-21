# 0089. A coordinator's Summary groups its work by outcome

- **Status:** Accepted (2026-10-16); its Summary view superseded by [ADR 0109](./0109-a-coordinators-page-shows-live-work.md) (2026-10-21). Requested by the operator. Amends
  [ADR 0064](./0064-the-organization-is-drawn-as-organizations-draws-it.md) for this one view: the tree
  stays as Organizations draws it everywhere, the node page included.
- **Trail:** `web/src/lib/coordinator-summary.ts` · `web/src/components/coordinator-summary.tsx` ·
  `web/src/routes/node.tsx` · [ADR 0088](./0088-a-projects-library-is-read-through-one-contained-route.md)

## Context

ADR 0064 stopped Nenu grouping a project's nodes by state: four views had drawn a project four ways,
and the popup's tree replaced them all. The operator now runs every agent through coordinators and no
longer reads chats. What he asked for, in his words: open a coordinator and see the work that is done,
separated per coordinator, with a summary of what is going on and the pictures, ordered and clear.
Read as a tree, that is a scan of every row and every chat; the question he asks is "what do I have to
decide, what is moving, what is finished", and the tree orders by urgency without answering it.

Organizations is adding what each worker's report says: a verdict from a fixed `Status:` line
(`done`, `needs-decision`, `blocked`, `failed`), a plain-language summary, captures and deliverables.
Without them the view can still group by what Organizations already knows (group, PR, status).

## Decision

1. **A Summary tab on a coordinator's page**, beside the tree, groups the coordinator's whole subtree in
   three sections in this order: Needs your decision, In progress, Done, each newest first. Done shows
   ten cards at a time.
2. **One rule places a node** (`outcome`): resolved or merged is done; then what the agent is doing now
   (waiting on you is a decision, working is in progress); then its last report (a non-done verdict is a
   decision, done is done); a PR waiting for review is done; anything else is in progress. A report never
   hides an agent that is asking again or back at work.
3. **The tree stays one tab away, and stays the default until a report exists.** The page opens on the
   Summary only when the coordinator or a node under it carries a verdict, so an Organizations without
   the fields keeps the page as it was.
4. **A card says what its report says**: the agent's summary as text, its PR, its captures in one row
   that scrolls sideways and opens large, and its documents (HTML and PDF, opened through the library
   route). The coordinator's own report heads the page.

## Consequences

The project page, the panel, the phone's Threads tab, Search and the node page's own tree still draw
ADR 0064's tree; only this tab groups. A change to the placement rule lands in `outcome`, and its
test names each case. The summaries are read on demand (ADR 0088), so the tab costs one read of
cached data when the page opens and when a node in it moves, and nothing on the poll.

Do not add this grouping to the other views of a project: that is what ADR 0064 closed. Revisit if
Organizations publishes its own grouping of a coordinator's work.
