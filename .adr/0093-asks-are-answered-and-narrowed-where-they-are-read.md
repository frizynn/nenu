# 0093. Asks are answered and narrowed where they are read

- **Status:** Accepted (2026-10-17). Requested by the operator. Amends
  [ADR 0091](./0091-your-asks-and-a-coordinators-card-come-from-organizations-fields.md) points 1, 3 and 5.
- **Trail:** `bridge/org-asks.ts` (`placeholder`) · `bridge/org-cli.ts` (`answerAsk`, `offers`) · `bridge/projects.ts`
  (`has`) · `web/src/lib/asks.ts` (`askSections`, `linkChip`) · `web/src/components/ask-list.tsx` ·
  `web/src/routes/asks.tsx` · `web/src/components/coordinator-card.tsx` · `scripts/e2e/asks-answer.ts`

## Context

On 2026-10-17 the operator's Your asks held one row waiting on him, "(nada por ahora; ninguna unidad de
la primera tanda depende de lo que quedó para confirmar)": a coordinator's placeholder under
`## Needs your decision`, counted as a decision and badged in the sidebar. The ask under it read
"task:AWA-569 missing · t-0003 idle · t-0004 working · t-0005 working". To answer what did wait on him
he had to find the coordinator's chat and type it there. He asked for a list narrowed by project and
coordinator, the same list on each coordinator's page, links as short chips with their state, no row
that is only a parenthesis, and Answer on what waits on him. Herdr Organizations adds `asks answer
<slug> <root|t-NNNN> --line N --text-file <F|-> [--json]` for it.

## Decision

1. **A line that is only a parenthesis is a placeholder.** The bridge leaves it out of the asks and the
   decisions, so it neither lists nor counts as waiting. This is the one judgement Nenu adds to
   Organizations' fields; it reads the text Organizations printed and nothing else of STATUS.md.
2. **Answer goes through Organizations, on the person's tap.** The person's words go to `asks answer` on
   standard input, never in the argv, and stay out of the audit. An ask's own text is still never sent.
   Answer shows only on an ask that waits on you, with a line, where `asks answer --help` exits 0. A
   decision line has no line to answer on.
3. **One list, narrowed where it is read.** Your asks narrows by project and coordinator, in its address;
   a coordinator's card draws the same list narrowed to itself, without naming whose each row is. A
   link is a chip: what it points at and the state Organizations confirmed.

## Consequences

The sidebar badge and the list agree with what a person would call waiting. A coordinator that writes a
real decision in parentheses loses it from the list; the STATUS.md under its card still shows it. Each
refresh of the organization may add an `asks answer --help` spawn, at most every ten minutes while the
answer is no, through the same probe as `node move` (ADR 0092).

Do not send an answer by typing into a coordinator's terminal, and do not show Answer where Organizations
cannot take one. Revisit point 1 if Organizations stops printing placeholders as asks or decisions.
