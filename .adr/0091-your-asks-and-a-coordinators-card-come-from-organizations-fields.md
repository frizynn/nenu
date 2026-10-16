# 0091. Your asks and a coordinator's card come from Organizations' fields

- **Status:** Accepted (2026-10-16). Requested by the operator. Amends
  [ADR 0090](./0090-a-coordinators-status-file-is-drawn-as-written.md) point 2: under a card, the
  STATUS.md starts closed. Meets 0090's own condition for revisiting it: Organizations now publishes
  the asks as data.
- **Trail:** `bridge/org-asks.ts` · `bridge/projects.ts` (`asks`, `waitingAsks`) · `web/src/lib/asks.ts` ·
  `web/src/routes/asks.tsx` · `web/src/components/coordinator-card.tsx` · `web/src/routes/node.tsx` ·
  `scripts/e2e/asks.ts` · Organizations `docs/json.md` (Asks, Status file, Usage) and `src/ui.rs`
  (`asks_lines`, `card_lines`)

## Context

The operator, on 2026-10-16: "I want everything more ordered, and to understand where everything I ask
stands", and before that, to open a coordinator and see where it is. Each coordinator keeps what the
operator asked under `## Asked` in its STATUS.md (ADR 0090), so the answer was spread over one file per
coordinator, read as prose. Herdr Organizations now reads those lines itself: `asks --json` lists every
coordinator's asks with the state the coordinator wrote, the state its links confirm (a thread's group,
a PR's state, a task) and a fixed reason when the two disagree; it sorts them by what the person does
next. `status_file` gains `objective` and `needs_decision`; threads and the project gain `usage` (context,
peak, compactions, caps passed); the project names its coordinator's agent, model and state. Its popup
draws one list, Your asks, and one card per coordinator, and the operator approved both.

## Decision

1. **Read, never re-judge.** Nenu groups the asks by Organizations' own rank (`Ask::rank`, ported once as
   `askGroup` in the bridge) and keeps its order; the decisions under `## Needs your decision` of a
   coordinator that still takes an answer join what waits on you, as in the popup. Nenu still parses
   nothing out of STATUS.md: every field is Organizations'.
2. **Asks are read beside the overview**, in the same refresh. A binary without `asks`, or with another
   schema, lists none; a read that fails keeps the last one, so the list does not vanish for a refresh.
   `/api/org/asks` answers from that read, without a spawn. The snapshot carries only how many wait per
   project (`waitingAsks`) and a stamp of each token reading (`usageStamp`), never an ask's text or a token count.
3. **An ask's text is shown, never sent.** It is the person's and the coordinator's words: drawn as text,
   and it never reaches a prompt, a terminal or a notification.
4. **Your asks** (`/asks`) is one tap from where the projects are listed: the desk's bar beside Routines,
   and the top of Projects in a phone's Search. A row opens its coordinator's page; the project's own
   coordinator has one at `/project/<slug>/node/root`, the id Organizations gives it.
5. **A coordinator's page opens on its card**: objective, what waits on you, its other asks with what
   their links confirm, its open agents with state, verdict and a passed cap, their PRs, and its tokens
   with a mark over a cap. The card shows only with something to say about that coordinator. Its
   STATUS.md starts closed only when the card already says what the file says (objective, asks,
   decisions), and only once both reads are in, so the order they land in changes nothing.
6. **Without the fields, nothing changes**: no row, no card, no request for asks, and the STATUS.md
   opens as before (`bun scripts/e2e/asks.ts --quiet` captures it).

## Consequences

Nenu and the popup cannot disagree on where an ask stands, since both read Organizations' rank. Each
refresh of the organization costs a second spawn (`asks --json` reads only records, no `gh` or Herdr); it
has not been measured on a large registry. The card repeats, in brief, what the Summary below it says of
each agent: the card answers "where is it", the Summary shows the reports.

Do not group asks by parsing STATUS.md, and do not put an ask's text in the snapshot or in anything
sent to an agent. Revisit point 2 if the second spawn shows up in the refresh's time, and point 1 if
Organizations publishes the groups themselves.
