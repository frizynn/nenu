# 0113. A state is a still glyph, coloured only when it asks for you

- **Status:** Accepted (2026-10-21). Supersedes decision 3 of
  [ADR 0111](./0111-one-set-of-motion-hover-and-mark-tokens.md) ("one status mark, 6 px"). Requested by
  the operator on 1.38.4: "our sidebar is very rough and I don't like the dot of that colour; another,
  more minimal and nicer icon", with T3 Code and Ovis as references.
- **Trail:** `web/src/components/status-badge.tsx` (`StateMark`, `StatusDot`, `AGENT_STATE`) ·
  `web/src/components/node-row.tsx` (`NodeDot`) · `web/src/components/desk-nav.tsx` (`data-live`) ·
  `web/src/styles/nav.css` · `web/src/components/status-badge.test.tsx` · `scripts/e2e/sidebar.ts`

## Context

Every state was a 6 px dot told apart by colour alone: red needs you, amber works, blue to review,
green finished, a grey ring at rest. In a real bar most rows were amber or green, so the one red row
had to win a colour contest, and in grey (or to an eye that confuses red and amber) needs, working and
review were the same dot.

Three still candidates were drawn on the same herd (sidebar, Home, a project; dark, light and grey):

| | Needs you | Working | To review | Resting | In grey |
|---|---|---|---|---|---|
| A, T3 Code's icons | red alert | grey dashed circle | blue check | nothing | 4 states apart |
| B, Ovis's marks | red `?` | grey ring | blue dot | nothing | 4 apart, but the ring was 1.38's resting mark |
| C, a neutral dot | red dot | grey dot | blue dot | nothing | needs, working and review alike |

A spinner for working, as T3 Code's busy rows suggest, was not drawn: `calm-motion.test` forbids an
animation that runs for a whole turn (a spinner cost about 1 s of CPU every 30 s on the bench), and
T3 Code's own working glyph, `CircleDashed`, is still.

## Decision

1. **One mark per state, by shape first** (`StateMark`, A): a red alert waits on you, a blue check is
   ready to look at (an agent's finished turn included), a grey dashed circle works, a grey branch is a
   merge left, a grey tick is resolved, and a resting node draws nothing in a 14 px box that keeps the
   names in line. `NodeDot` is this mark and `StatusDot` maps an agent's status onto it; nothing else
   draws a state's dot by hand.
2. **Colour only for what asks something of you:** red and blue; everything else is grey.
3. **Nothing spins.** A state that lasts is a still glyph.
4. **In the desk's bar a resting chat reads in the muted ink;** a live one, the one on screen and the
   one under the pointer keep the full ink, as T3 Code's list does. A phone's drawer keeps every chat
   in the full ink: no pointer rests on a row there to bring one back.

## Consequences

- `status-badge.test` pins a different glyph per state, the two colours and the still marks; a dot per
  state brought back fails it.
- A rail tile's corner badge draws the same glyph on a disc of the rail, and only for a live state.
  Where no column holds names in line (a chip, a row's end, the chat's subtitle, a folded node's
  summary), a resting agent draws nothing at all (`resting`); in a list its empty box keeps the column.
- Dots that are not a node's or an agent's state (a check run, a tool's activity, usage, a link chip's
  tone) keep their own colours; they say something else.
- Revisit only with a measured reason that a glyph reads worse at a glance than the colour it
  replaced, and never with an animation that lasts.
