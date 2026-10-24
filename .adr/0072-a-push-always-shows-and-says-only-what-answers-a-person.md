# 0072. A push always shows, says only what answers a person, and comes once until you look

- **Status:** Amended by [ADR 0123](./0123-nenu-draws-herdr-alone.md) (2026-10-24), which removed projects, coordinators and threads. Accepted (2026-10-14). Lands with 1.1.0. Amends [ADR 0070](./0070-each-agent-gets-its-own-notification.md):
  each agent still gets its own notification, but a resolved one is no longer retracted by push.
- **Trail:** `bridge/notifications.ts` · `bridge/notify-prefs.ts` · `bridge/alert-detail.ts`
  (`turnOutcome`) · `bridge/awaiting-replies.ts` · `bridge/live-events.ts` (`watching`) ·
  `web/src/lib/push-decision.ts` · `web/src/lib/stale-notifications.ts`

## Context

The operator reported constant, confusing notifications on an iPhone. Two causes, both measured.

**What was sent.** Over 12 hours of real journals, 239 turns ended: 56 and 36 started by a
subagent's result (already off), 44 coordinator turns started by Herdr Organizations' own inbox nudge
(`[hp inbox] …`), 37 thread turns started by their coordinator, 54 loose-agent and 5 coordinator
turns started by a person. With the switches the operator had on, about 150 of them notified; more
than half was the organization talking to itself.

**How it was sent.** WebKit requires every web push to show a notification and revokes a
subscription after three that do not (WebKit "Meet Web Push"; the "Enforce silent push quota"
commit). Nenu sent two kinds of silent push: retractions (`clear`) and pushes the service worker
dropped because a Nenu tab was visible. The operator's iPhone re-subscribed three times in one
evening; between revocation and the next app open, nothing arrived.

## Decision

1. **Never silent.** The bridge sends no retraction, and the service worker shows every push. While
   Nenu is open on a screen (a page keeps its live-events stream open only while visible and not
   idle-locked), or a snooze runs, the bridge sends nothing at all. The open app closes the
   notifications it no longer needs.
2. **Only what answers a person.** An agent waiting on you notifies. A finished turn notifies when a
   person started it: a message sent from Nenu, or text typed into a loose agent or a coordinator.
   It never notifies for a turn Organizations' nudge started, for a thread's turn its coordinator
   started, or (unless switched on) for a subagent's result.
3. **Once until you look.** An agent that already notified for a kind does not notify for it again
   until Nenu's ledger says you looked at it.

## Consequences

- Settings has four switches: Needs input, Replies to you, Subagent results, App updates. A prefs
  file from before keeps its finished choice as Replies to you.
- A thread's progress reaches the phone through its coordinator's replies and through Needs input,
  not through each of its turns. A future "thread reports" notification should come from
  Organizations' report events, not from turn ends.
- Closes the options of retracting by push, hiding pushes in the service worker, and notifying turn
  ends regardless of who started them.
