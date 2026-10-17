# 0094. A finished agent is a mark on its row on a phone too; only an ask raises a toast

- **Status:** Accepted (2026-10-17). Amends [ADR 0080](./0080-the-desks-bar-lists-projects-and-chats-the-tree-is-searchs.md)
  point 3, "A phone keeps its toast": it keeps the toast only for an agent that asks.
- **Trail:** `web/src/hooks/use-transitions.ts` · `web/src/components/home-panels.tsx` (`SessionRow`'s
  New) · `scripts/e2e/calm.ts`

## Context

With some 40 agents in one herd, each one finishing raised a toast at the top of the phone. The
toasts chained: one was on screen most of the time, over the header's ‹ and the row of thread chips.
An audit on the live service saw a tap on a chip fail for 30 s in a row. On the e2e bench (eight
agents finishing in turn) a tap on ‹ and a tap on a chip both landed on the toast, which is a link,
and opened another agent's chat instead.

The desk had the same problem and solved it in ADR 0080: a finished chat is a +1 on its row. A phone
already has that row: Home's Recents marks a session that finished since you last opened it "New".

## Decision

1. **An agent that finishes raises nothing on a phone either.** Its row in Recents says New until it
   is opened, as the desk's +1 does.
2. **An agent that asks for you still raises the toast**, grouped as before when several ask at once.
   An ask is rarer than a finish and waits on the operator, so it is worth the header for 2.5 s.
3. **The mark never moves its row.** Recents and the desk's chats keep the order they came on screen
   with (`web/src/hooks/use-held-time.ts`); a row that finishes says New or +1 where it is. What
   needs you shows without reordering: Home's Needs you group on top, and on a desk a chat that asks
   past More is drawn after the rows on screen, with Home's count above. The full order comes back on
   a return to the page or a tap on "N updates". A row that rose to say it finished was tried in
   review and measured 250 moves a minute on Home and 400 in the bar, as many as no hold at all.

## Consequences

- Inside a chat on a phone, another agent finishing is not announced until you go back to Home. Push
  still covers a hidden page (ADR 0072).
- On the bench, with agents finishing every 1.2 s, both taps land at the first try, no toast is up and
  no row moves in a minute; an agent off screen that asks is on screen in about 110 ms.
- A finished row below the fold stays there until a return or "N updates": its New is not seen from
  Home's first screen. The asking ones are.
- A chain of asks could still cover the header. If that shows up, the next step is a toast that
  leaves the header alone, not bringing back the finished one.
