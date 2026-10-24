# 0103. A conversation that ended its turn waits on nobody

- **Status:** Superseded by [ADR 0123](./0123-nenu-draws-herdr-alone.md) (2026-10-24). Before that: Accepted (2026-10-20). Amends point 1 of [ADR 0064](./0064-the-organization-is-drawn-as-organizations-draws-it.md).
- **Trail:** `web/src/lib/org-tree.ts` (`nodeState`, `atRest`) · `bridge/projects.ts` (`conversation`) ·
  Organizations `src/thread.rs` (`group`, row 4) · `docs/json.md` (`keep_open`)

## Context

ADR 0064 has `nodeState` read Organizations' group the way its popup does, so the two never disagree.
Organizations groups a thread Waiting on you when its agent reports `Waiting for you`
(`live.self_waiting()`), whatever kind of thread it is. A conversation (`keep_open`, a thread that
talks with a person) reports it before every answer, as its progress hook asks, so after each turn
it is Waiting on you. Measured on 2026-10-20: awam-org's "Charla de mejoras" (t-0360) in
`overview --json` read `group: waiting-on-you`, `activity: Waiting for you`, `keep_open: true`, its
pane `done`. Home said "1 needs you" with a red "Waiting for your reply" and Reply, the Home tab's
badge counted it, and its workspace read Needs you. The person read that as a request it was not.

The contract has no field that tells a conversation's real question from its ended turn: both are
the same `Waiting for you` report.

## Decision

1. **A conversation at rest is idle.** A thread with `keep_open` whose agent said `Waiting for you`,
   on a live pane Herdr does not read blocked, is not Waiting on you in Nenu, whatever its group.
2. **A conversation needs you only as any agent does:** a dialog on its screen (Herdr's `blocked`),
   a failed start, or a lost pane. Organizations' other reasons stay its group's.
3. **Like a coordinator, a conversation never reads as ready for review from its own turn.** Herdr's
   `done` after an answer, or a report Organizations groups Ready for review, leaves it idle; its
   pull request still reads as review once approved or landing.
4. A worker that is not a conversation and says `Waiting for you` stopped to ask: it still needs you.
5. A coordinator kept open reads as any coordinator does. Organizations gives the conversation's brief
   only to threads (`src/thread.rs`), so a coordinator's `Waiting for you` is still a stop to ask.

## Consequences

Nenu and Organizations' popup and sidebar disagree on a conversation at rest until Organizations
groups it the same way; the fix belongs there (`group()` row 4: `self_waiting()` unless the thread is kept open and not a coordinator), and
Nenu's rule then agrees with it instead of overriding it. An ask linked to such a thread still reads
Organizations' raw state (`asks --json`) and says "needs you" until then.

A conversation that asks a real question in plain text reads as at rest. Revisit if Organizations
publishes a field that tells the two apart.
