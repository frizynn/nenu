# 0113. A turn reads as T3 Code draws its work, the same on a phone and a desk

- **Status:** Accepted (2026-10-21). Requested by the operator ("los comandos deben verse así", four
  captures of T3 Code). Reverses the desk's own work log of `c16199e7` (a turn never folds on a desk;
  each run of steps a bordered table of verb and target rows), which no ADR recorded.
- **Trail:** `web/src/components/transcript-view.tsx` (`WorkTurnView`) ·
  `web/src/components/work-log-tools.tsx` · `web/src/components/fold.tsx` (`.fold` in `index.css`) ·
  `web/src/lib/work-timeline.ts` (`foldsSteps`, `workSegments`) · `web/src/lib/shell-tokens.ts` ·
  `web/src/components/live-conversation.tsx` (`onWorkToggle`) · `scripts/e2e/commands.ts`

## Context

Nenu drew a turn's work two ways. A phone folded the whole turn behind "Worked 1m 52s", and opened it
onto one row per step under a rail. A desk never folded the turn and drew each run of steps between
two of the agent's texts as one grey line that opened onto a bordered table (verb, target, and a row
opening onto a "$ command" box and an "Output" box). The operator's T3 Code captures show a third
shape, the same at every width: "Working for 9s" / "Worked for 12s ⌄" folds the turn with its time at
the end of the line; inside, a thought is a row with a brain and its first words, the agent's words
sit between runs, three parallel commands read "Ran 3 commands" with the terminal glyph, each command
a row that is the command itself, and an open command shows it in a shell's colours with its output
in grey under it, a failure as "Error: Exit code 1" and no red panel.

`scripts/e2e/commands.ts` replays that demo as a Claude log, 1440×900 and 390×844, before and after.

T3 Code colours a command with Shiki and puts its HTML in the DOM (`dangerouslySetInnerHTML`). Nenu's
transcript renders every string from a log as a React text node (the XSS boundary of the mirror), so
the colouring could not come that way.

## Decision

1. **One work log for every width.** A turn's line says "Working for 9s" (seconds through its first
   minute, then minutes) or "Worked for 12s", with its finish time at the end and a hairline under it
   while open. A finished turn folds to its line and its answer; a running one is open.
2. **Inside, the agent's words between runs of steps.** A run with one call, or only thoughts, draws
   as its own rows. A run with several calls folds under one line that counts them ("Ran 3 commands",
   "Read 1 file, edited 1 file") with the icon they share and no chevron; the thoughts among them fold
   with them, and what their calls returned stays in sight under the line while it is folded. Open on
   a desk, the line says when the run began.
3. **A run drawn as rows stays rows while it is on screen.** A call that joins it as the turn runs
   never pulls a line in above rows the reader may have opened; the run folds the next time it is
   drawn whole. Calls still running never fold under a line in the past tense, and a run is named by
   its first step, the live one included, so parallel calls finishing out of order and an older page
   going in above it keep its state.
4. **A command is its row's name**, in the row's type; the verb stays in the row's accessible name.
   Open, it shows the command coloured by `lib/shell-tokens.ts` (program, flags, arguments, strings,
   variables, keywords; text nodes only) and its output in grey, "Error: Exit code N" first. A row's
   command is its first line as written, never passed through the Markdown a thought goes through. A
   failed step half-tints its icon and its row says Failed in grey; its run's line tints only its icon.
   The step in progress carries the live mark and no clock: the turn's line says how long.
5. **Folds move as the box's rows already did** (ADR 0111): the composer's `Fold`, now `fold.tsx`
   with its `.fold` rules in `index.css`, grows a fold's height from nothing in 180 ms and shrinks it
   in 120 ms on the shared curve, inert while it leaves; chevrons turn in 120 ms; under reduced motion
   only the fade remains. Only a fold the operator opened moves: one opened by search or focus is in
   the page in the same commit (its phase follows its value in the render), so find can scroll to
   it. T3 Code animates only its chevron (measured, 200 ms); the operator asked for more ("faltan
   animaciones, como desplegar los comandos"). The chat holds the tapped line in place for the whole
   motion, and lets go as soon as the reader scrolls.

## Consequences

- A desk loses its table of steps and the "Output" box: a long output scrolls in place under a
  pointer (`max-h-80`) and runs whole under a finger, so the chat stays the one box that scrolls.
- A call's own description (Claude's Bash `description`) is no longer drawn; it is the row's tooltip.
- A turn opened by search or focus is simply there; only a tap animates.
- A running turn may hold an unfolded run that a reload would fold. That is the price of rule 3;
  revisit only with a measured jump that folding live runs would not cause.
- A syntax highlighter that emits HTML (Shiki, Prism, highlight.js) stays out of the transcript; a new
  grammar gets a tokenizer that returns text pieces, as `shell-tokens.ts` does.
