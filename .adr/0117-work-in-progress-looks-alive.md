# 0117. Work in progress looks alive, where it happens, and one message is on screen once

- **Status:** Accepted (2026-10-21). Requested by the operator on 1.40.0 and 1.41.0 ("ese Working
  debe tener animación, tipo glow", "no veo cuando pensás, es como que está muerto el agente", "no
  sé si está corriendo o qué"). Amends [ADR 0111](./0111-one-set-of-motion-hover-and-mark-tokens.md)
  decision 1 ("nothing animates forever"), [ADR 0113](./0113-a-state-is-a-still-glyph-coloured-only-when-it-asks-for-you.md)
  decision 3 ("nothing spins") and [ADR 0116](./0116-a-turn-reads-as-t3-code-draws-its-work.md)
  decision 4 (the step in progress as the turn's bottom row, with the live mark).
- **Trail:** `web/src/lib/live-motion.ts` · `web/src/components/work-activity-label.tsx` (`Glow`) ·
  `web/src/components/status-badge.tsx` (`WorkingMark`) · `web/src/index.css` (`--motion-glow`,
  `.glow-*`, `.mark-turn`, `.row-enter`) · `web/src/lib/enter.tsx` · `web/src/lib/work-timeline.ts`
  (`workSegments`) · `web/src/components/work-log-tools.tsx` (`StepItem`, `ThinkingNow`) ·
  `web/src/lib/local-sends.ts` (`pendingSends`, `landed`) · `bridge/guarded-send.ts`
  (`takeBackQueue`) · `web/src/lib/harness/claude/chrome.ts` (`GLUED_EDITOR_HINT`,
  `inputBoxShowsHistory`) · `web/src/calm-motion.test.ts`

## Context

What the operator saw, and what a real Claude Code 2.1.306 in a Herdr pane of its own showed behind
a bridge built from `main` (1.41.0), 1440×900 and 390×844:

- **A working agent looked dead.** The turn's "Working for 9s" and every working mark (the bar, Home,
  a project, the chips) were still, by ADR 0111 and ADR 0113. Between two steps nothing said what the
  agent was doing; the operator could not tell a thread that runs from one that stopped.
- **The step in progress jumped.** It was drawn as one row under the turn ("● Running … · 1m"), and
  the moment it finished it left that row and appeared, done, inside its run higher up.
- **A message sent while Claude worked was on screen twice**, twice per send (measured): for about
  0.3 s as its pending bubble plus the queue's row (the row reached the page before the bubble knew
  its id), and again as the bubble plus the journal's turn (the bubble left only in an effect after
  the paint that drew the turn).
- **A message in Claude's own queue could not be edited or removed**, only read now. Claude hands its
  queue back on Up while it has not read it (measured: every queued message at once, one per line);
  once it has, Up shows its history instead (measured: "History 6/6", an old message in the box).
  Nenu could not even see the box then: a statusline that fills its row leaves Claude's "ctrl+g to
  edit in Vim" one space after its last field, which read as a dialog's footer and hid the box.
- **Editing a message already read** would take Claude's rewind (Esc Esc): its menu names messages by
  their first line, cut with "…", picks by position, and forks the conversation (measured).

T3 Code (`apps/web/src/index.css`, `live-activity-focus`) shows a live line with a light that passes
over its words: a window and the copy inside it slide opposite ways by `transform`, in 30 steps per
2.2 s, paused off screen.

## Decision

1. **Only what shows an agent works now may move for as long as it lasts**: the glow across a running
   turn's "Working for 9s", its step in progress and its "Thinking…", and the working mark's dashed
   circle turning a sixth of a turn per pass (its six dashes land where the next were). Each moves by
   `transform` alone, in `steps(30)` over `--motion-glow` (2.2 s), on a composited layer, and only
   while `lib/live-motion.ts` says it may: on screen, on a shown page, with no idle lock and motion not
   reduced. Otherwise the motion is not in the page at all (no glow copy, no class). Everything else
   still answers a tap and ends (ADR 0111), and `calm-motion.test` names these three rules as the only
   ones that run forever.
2. **The step in progress sits where it will stay.** It is a row of its run, its own icon, its words
   glowing, and it turns done in place. Between steps a "Thinking…" row stands where the next step
   lands. A thought being written shows its first line there.
3. **What joins the thread while it is read eases in** (a step, a thought, the agent's words, a
   message on its way): a fade and a short rise, 180 ms, transform and opacity only. What was there
   when the thread or a fold was drawn never moves. The operator's own message does not ease in when
   the journal shows it: it was already on screen as its bubble.
4. **A message is on screen once.** Its bubble owns its queue row before the row can reach the page,
   and stops drawing in the same render that draws the journal's turn; a landed bubble keeps holding
   its row a while, so the row is never drawn alone while the queue catches up.
5. **A waiting message is edited or removed with one tap**, on its status line. One in Claude's own
   queue is taken back (`take-back`): under the pane's write lock, only while the empty box says the
   queue holds something, Up, a read of what came back, and the box cleared. Every queued message
   comes back together, as Claude hands them over, into the composer (Edit) or, but for the removed
   one, into the composer (Remove). If Up reached the history, its text is cleared and nothing is
   taken.
6. **A message Claude has read is not edited from Nenu.** Rewind is a menu read by truncated text and
   position that forks the conversation; it waits for a protocol that can name the message.

## Consequences

- Work in progress costs a few composited frames a second per visible mark; off screen, hidden or
  locked, nothing. Measured cost: see the PR (`bun scripts/e2e/live-motion.ts`).
- Words that glow are drawn twice while they move; the copy is `aria-hidden`, and a still glow has
  none, so find and screen readers meet them once.
- Taking back one message of several brings them all back; Remove says the others are in the box.
- Under reduced motion a working agent is told by its words, its clock and the dashed shape alone.
- Revisit 6 when Nenu talks to Claude by protocol (the t-0024 research): rewind there names a message.
