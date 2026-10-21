# 0109. A coordinator's page shows its live work; what finished is one line away

- **Status:** Accepted (2026-10-21). Requested by the operator. Supersedes
  [ADR 0089](./0089-a-coordinators-summary-groups-its-work-by-outcome.md)'s Summary view (a node's own
  report at the head of its page stays). Amends [ADR 0102](./0102-on-a-desk-projects-and-coordinators-are-pages-with-tabs.md)
  (the coordinator card on a project page) and [ADR 0091](./0091-your-asks-and-a-coordinators-card-come-from-organizations-fields.md)
  (what a card lists of its asks).
- **Trail:** `web/src/components/desk-coordinator.tsx` · `web/src/components/desk-pages.tsx` ·
  `web/src/lib/asks.ts` (`unmarked`) · `web/src/components/ask-list.tsx` · `web/src/components/coordinator-status.tsx` ·
  `web/src/lib/org-tree.ts` (`mergedToClose`) · `scripts/e2e/coordinator-page.ts`

## Context

With 1.35.0 deployed the operator opened the Nenu project's coordinator on a desk and listed what they
could not use, in their words: getting in took the small chevron, "re tosco"; the page opened on a
Summary that drew every finished thread as a card with its whole report and captures ("los done me
chupan huevo", "el summary no entiendo una goma"); Open chat and New thread looked like two kinds of
control; Waiting on you listed the five done asks; four lines sat under "Other lines" with their raw
`[in-progress]`; and the opened STATUS.md "no deja scrollear".

Measured on a copy of the real project (`coordinator-page.ts --fixture`): the Summary held 12 report
cards against 3 live threads; the coordinator's Waiting on you drew every group of its asks; the
coordinator had written `[in-progress]`, which the format Organizations documents
(`[open|working|needs-decision|answered|done]`) does not name, so Organizations read four lines as
`unknown`; and an opened STATUS.md under a card was clipped at 288 px with `overflow: hidden` on a page
too short to scroll, so a wheel over it moved nothing and only a faint Show all opened it.

## Decision

1. **A coordinator's page lists only its live work.** Its open threads, the most urgent first, as rows
   that open them; a thread under a nested coordinator one step in. What finished is one line, "N
   finished", to the project's History (ADR 0106) searched for the coordinator's name; on a phone, the
   tree's folded History. That line, and the project page's History, sit after the live work, never
   beside it: "lo que se está trabajando ahora, y el historial en otro lugar, lejano". No Summary,
   no report cards: a thread's report is on its own page.
2. **A tap anywhere on a coordinator card's head opens its page.** The fold is its own chevron button;
   + still starts a thread under it.
3. **A page's header actions are one button.** Same height, radius, padding and fill: no primary in
   ink beside a quiet one.
4. **A coordinator's Waiting on you holds only what waits on you.** Its other asks are its Status, on
   its card, as requests with their state (Waiting on you, Does not close, In progress, Done), and Done
   is one folded line wherever asks are listed.
5. **An Asked line outside the format reads as the request it is.** Its brackets go; a word that says
   finished (`merged`, `finished`, `hecho`…) puts it under Done, anything else under In progress, never
   Waiting on you, which only Organizations decides. Its words split at the format's ` : `. Its links
   stay unread: Organizations confirmed none. Nenu adapts its reading, not the format; the coordinator
   should still write the documented states.
6. **A STATUS.md the person opens is drawn whole.** The Show all fold stays only where the file heads a
   page unasked.
7. **A node in the review group whose pull request merged reads "merged, closes on its own"**, and
   nothing counts it as to review (a card, Home's projects and Ready to review): Organizations resolves
   it shortly. `org-tree.ts` (`mergedToClose`, `toReview`) is the one place that decides it.

## Consequences

- The reports of finished threads are a tap further away (History, then the thread). That was the
  point: the operator reads results from Waiting on you and the thread itself, not from a wall of cards.
- Reading off-format lines is a guess Nenu makes for display only; counts that decide what waits on the
  person stay Organizations'. If Organizations starts reading `[in-progress]` itself, `unmarked` simply
  stops being reached.
- Revisit if the operator asks again for finished work on the coordinator page, or if a second
  coordinator page shape (a phone tab bar) is built.
