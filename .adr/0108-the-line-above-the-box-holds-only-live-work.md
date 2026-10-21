# 0108. The line above the box holds only live work, and Stop sits in the box

- **Status:** Accepted (2026-10-21), amended the same day: the live chips left the line for the row
  under the box (see *Amendment*), so no line sits above the box at all. Requested by the operator. Reverses the chips' line of
  `17dfd095` (a quiet Done or Published chip once nothing ran, a Routines chip whenever a project had
  routines) and `b2b463e6` (Stop at the end of that line, on a line of its own when alone), which no
  ADR recorded.
- **Trail:** `web/src/components/composer.tsx` · `web/src/components/composer-chips.tsx` ·
  `web/src/components/stop-control.tsx` · `web/src/components/agent-chat.tsx` ·
  `scripts/e2e/run.ts chip-line`

## Context

A coordinator's chat at rest drew "Done 6" on a line of its own between the conversation and the box,
and "Stop" at the end of it while a turn ran. The operator: "it's clunky and takes space for nothing,
and maybe it isn't needed." Finished work asks nothing of anyone, and a project's routines run on
their own clock; the line's other chips (Needs you, Working or Background, PRs) are what waits or
moves. Stop alone kept the line open for every turn.

Three places for Stop were built over the same seven moments (`chip-line`, 390×844 and 1440×900, dark
and light), with finished work already off the line:

| Stop | Above the box, Stop alone | Keyboard up (phone) | Box moves when Stop comes |
|---|---|---|---|
| Its own line (as before) | 40 px | stays | the line folds open, 40 px |
| In the box, beside Send | 0 px | stays | 0 px |
| Row under the box | 0 px | hidden with the row | 2 px |

Ovis (herdr-web-ui) puts Stop in Send's slot while the draft is empty. Not taken: a draft appearing
swaps Stop for Send under the thumb, the reason Stop never took the Send slot.

## Decision

1. **The line holds only chips for live work:** Needs you, Working or Background, PRs. It folds open
   with the first and shut with the last.
2. **Finished work and routines are rows of the chat's ⋯ menu** ("Finished work · N", "Published · N",
   "Routines · N"). A row opens the same panel the chip did, floating from the box's top edge with no
   line under it, its finished rows unfolded. The panel sits outside the line's fold, so work that ends while it is open leaves it
   as it was.
3. **Stop is a round button in the box, beside Send**, for the whole turn: never in Send's slot.
   The two sit 12 px apart, so their 44 px touch areas meet without overlapping. "Really stop?" and
   "Stopping…" take its place there. Esc in the empty box still stops.
4. **The terminal view says nothing of its own about the turn**: the mirror shows the CLI's own
   "Working… (Ns)".
5. **A chat holds no line while it settles.** The hold kept the line's height for chips that answer
   after a project's chat mounts, mostly Done; with finished work off the line it almost always ended
   empty and folded shut two seconds in (composer bench, Chromium, late chips: 1 and 3 fold shifts on
   a phone and a desk with it, 0 and 0 without). A live chip that answers while the chat settles is
   drawn at once, like any row then; one that comes later folds in.

## Consequences

A turn with nothing else around it costs no height above the box. Finished work is one tap further
(⋯, then the row) and no longer seen at a glance. The draft is 44 px narrower while a turn runs.
Revisit if the operator reads finished work often enough to want it back in sight.

## Amendment (2026-10-21): the chips sit under the box

With finished work off the line, the line still took a full row for "Working 2" and "PRs 1" on a
coordinator's chat (operator, on 1.38.1: "it still takes space"). Three places were sketched on the same
chat (a worker with Needs you, Background and PRs; WebKit, 390×844 and 1440×900):

| Chips | Height above the box (390 / 1440) | Draft width at 390 | Title at 390 | Taps to a kind |
|---|---|---|---|---|
| Their own line (1.38.1) | 48 / 40 px | 246 px | whole | 1 |
| In the row under the box, beside the model | 0 / 0 | 246 px | whole | 1 |
| In the header, beside the title | 0 / 0 | 246 px | gone (0 px) | 1 |
| One counter in the box, beside + | 0 / 0 | 198 px | whole | 2 |

**Decision, replacing 1 and 5:** the live chips (Needs you, Working or Background, PRs) sit in the row
under the box, between the model and the place. That row is there on every chat, so they cost no height
and no width of the draft. They are as quiet as the row's other controls; only Needs you
keeps its word in a narrow box, the rest are a mark and a count (a dot, a pull-request icon), named in
full to a screen reader. Each is at least 44 px wide on a touch screen, and its 44 px reach grows down, away from the
box. What gives way is read off the box's own width (a container query), so a phone and a thread
docked beside its coordinator take the same row: under 480 px only Needs you keeps its word and, while
chips are there, the model's effort and the context's number step aside (the picker and the ring's
panel still say them), then the model's name truncates, and the place is one button that opens the
branch and the machine; under 300 px the context's ring steps aside too (the thread's full view says it),
never the model's button, from which the model panel opens on its own. In a wide box the branch and
the machine truncate side by side when the row is full. The panel a chip opens still floats over the
thread from the box's top edge. With the phone's keyboard up the row gives its height back, chips
included, as the line did; an open panel stays. Nothing folds: the row does not change height.
`run.ts chip-line` (with a model reported, as in a real session) fails when anything sits between the
thread and the box, when a chip is not under the box, or when any two controls of that row touch.
