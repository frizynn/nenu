# 0117. Enter follows the text, and Claude's log is the witness

- **Status:** Accepted (2026-10-21). Amends [ADR 0104](./0104-a-picture-travels-where-it-sits-in-the-message.md)
  (a picture's token is waited for, not timed), [ADR 0067](./0067-the-clis-own-state-decides-the-screen-is-the-fallback.md)
  (Claude's session state and log now decide a send, not only a turn), [ADR 0076](./0076-a-long-claude-send-is-one-paste-and-its-log-has-the-last-word.md)
  (the log is read before the box, not after it) and [ADR 0048](./0048-the-input-box-is-found-by-its-own-frame.md)
  (a read that shows the text is no longer the last look before Enter at an idle Claude with a log).
- **Trail:** `bridge/guarded-send.ts` (`submitAndLog`, `logWitnesses`, `look`, `judged`,
  `pictureDrawn`, `WAIT_DELAYS_MS`) · `bridge/delivery-check.ts` (`claudeLogReader`, `LogLook`,
  `sameMessage`) · `bridge/routes/reply.ts` (`sendPane`: `turn`, the prior attempt's `typedAt`) ·
  `bridge/queue-service.ts` + `bridge/server.ts` (`turn`) · `scripts/bench/send-stress.ts`

## Context

The operator kept finding messages typed in Claude's box and never sent, a picture left as its path,
the queue stuck behind a draft, and Enter landing in a dialog, worse while the host ran at a load of
100 to 200 on 32 cores. Every send waited for the screen: after typing, up to 2.5 s for a read that
showed the text; after Enter, up to 2.5 s for the box to empty; after each picture, 2.5 s for its
`[Image #N]`; after a sweep, 2.5 s for the box to clear. A loaded host stretches each of those past
any fixed window, and every miss left something behind.

Measured on 2026-10-21, Herdr 0.9.3 on Linux, Claude Code 2.1.306 (haiku) in a pane of its own, with
`scripts/bench/send-stress.ts` (12 to 15 kinds of send, judged by Claude's log, three rounds each):

- **What the PTY receives.** A raw reader in a pane got one `pane.send_text` of 1 500 bytes in one
  read, and a 5 012-byte bracketed paste as two reads of 4 095 and 917 bytes. Herdr cuts nothing; the
  terminal splits a large write, which a bracketed paste survives (ADR 0076).
- **Claude takes text and Enter in order, however late it reads them.** A bracketed paste with `\r`
  behind it in the same write is submitted whole, short or long (logged 1 of 1 each, 200-430 ms). So is
  typed short text with `\r` behind it. Claude Code itself drives a REPL in a PTY this way: a bracketed
  paste, then `\r` 10 ms later, with no look in between (read in the 2.1.306 binary).
- **A picture is the exception.** Claude reads a pasted path before it draws anything, and Enter that
  arrives meanwhile is dropped: `words, path, " ? one word\r"` in one write left
  `words ? one word [Image #2]` in the box, unsent. It never draws the path as text for a file it can
  attach; it does for one it cannot (ADR 0112).
- **Claude logs a send at once.** A typed message is a `user` row about 200-500 ms after Enter on an
  idle Claude; a message sent mid-turn is a `queue-operation` `enqueue` row with its text within 250 ms.
  Its session file goes `busy`, or `waiting` while a permission dialog is up.
- **The bench, before.** With nothing but the host's own load (50 to 83), 36 of 36 sends were good.
  With Claude held to 15% of a core (`systemd-run --scope -p CPUQuota=15%`), 30 of 36: two stuck in
  the box (a picture whose token came after the window, a draft whose sweep outlasted it), one "Enter
  went out, but the message is still in the box" for a message Claude then took (a resend would have
  doubled it), one more of those for a message Claude took late, a sweep of the previous leftover that
  timed out, and a picture sent as its path. {AFTER}

## Decision

1. **At an idle Claude whose log Nenu reads, Enter follows the text** as one bracketed paste, with no
   look in between: the pre-flight read (or the sweep's read of an empty box) is the last look before
   the write, as a read used to be the last look before Enter. Idle means Claude's session file says
   no turn runs and no dialog is up; at an idle Claude only the operator opens a dialog. The text goes
   as a paste whatever its length, because 760 typed characters with Enter on their heels stayed in
   the box with the Enter untaken (2 of 3 at 15% of a core).
2. **Mid-turn, Enter still waits to see the text in the box** (type, see it, Enter, see it go), with
   rule 6's waits: a tool's permission prompt can open under the text, and an Enter behind it would
   answer it. So does every send the log cannot witness: a slash command (`/name`, not a path), a `!`
   line, a message of pictures alone (no words to find it by), a dialog's text field, Type anyway, a
   log that cannot be read now, and every pane without a log (Codex and the rest).
3. **Claude's own state is asked first.** A session file that says `waiting` refuses the send before
   anything is typed, and stops it before Enter on either path, pressing no key at all: the sweep's
   keys would reach a dialog opening over the box, so the text stays and shows above the composer.
4. **Claude's log is the witness, for this message.** The reader looks for the message sent (the same
   words, pictures aside, or the tail a dropped head leaves) and answers logged, queued, none or
   unreadable; it says none only for a log it read back to the moment asked about. The send is sent
   when the log has it (whole, or `incomplete` as ADR 0076 says) or Claude queued it, or when the box
   showed it and then let go of it for a verify window with the log silent. Silence alone is never
   sent: a box that never showed it and a log that never had it answer "may still arrive", and a
   dialog or menu that took the keys answers so. A box that still holds it at the bound means Claude
   never took the Enter: the send clears its own text (ADR 0112) and says so, then looks at the log
   once more for the whole bound, because the sweep's keys reach Claude after the Enter and a starved
   Claude logs seconds late (measured: an enqueue 2.5 s after the clear, which "send it again" would
   have doubled).
5. **A retry asks the log first.** A retry of a request id whose earlier attempt wrote looks for the
   message from that attempt's first write: logged or queued is sent, without typing. Silence proves
   nothing (the earlier bytes may still be on their way), so the retry keeps its old answers.
6. **Every wait ends on an event and is bounded, not timed.** The text in the box, a picture's token,
   the box emptying and the sweep clearing wait up to 15 s counted in the pauses between looks (on a
   loaded host the looks themselves are slow, so the wait only grows) and end on the first look that
   sees it. While Claude says "Pasting…" under its box (it is still reading a pasted picture, and may
   show the path in the box meanwhile) a picture's bound does not run, though never past 55 s into the
   send, and no picture is pasted past that; a path that sits in the box for 1 s once it no longer says
   so is taken as staying text (measured: a path shown during "Pasting…" stayed text every time; none
   turned into a token). A picture that shows after the send gave up and cleared the box is cleared
   too, once, through the same stop.

## Consequences

- No send fails or strands its text because the host is slow: the waits that stopped a send at 2.5 s
  now give a loaded Claude 15 s, and a fast one answers as soon as it logs.
- A send that genuinely never arrives now costs up to 15 s before it says so, where it cost 2.5 s.
- **The phone waits 110 s for `/send`, not 20 s.** A send's pictures stop being waited for 55 s into
  it by the clock, and at most three 15 s waits follow, so on a host whose reads are quick the answer
  comes inside that. The cost: a dead network shows "no answer" after 110 s, and the box's Send stays
  busy that long. On a starved host the reads can still push a send past it; the phone then says it
  had no answer, and its retry, with the same request id, joins the send under way (the ledger), so
  nothing is typed twice.
- At an idle Claude the safety of Enter rests on the pre-flight read and on `waiting`, not on seeing
  the text. A read between the text and Enter there brings back the window a loaded host misses.
- **Keys are slow, not lost, on a starved Claude.** 200 Backspaces took about 12 s to take effect at 5%
  of a core, so a sweep of a long draft can outlast its bound; the keys still land, after the answer.
- **A starved Claude keeps a picture as its path.** At 5% of a core Claude left a picture pasted alone
  as text in 3 of 6 tries (never converted within 20 s), and pasting it again after deleting it did
  not help (4 of 6 sends still had a path, one took 85 s), so the send does not retry: the picture goes
  as its path, which the agent reads (ADR 0112). The cause is inside Claude and was not traced.
- **An interrupt pulls Claude's queue back into the box.** Ctrl+C or Escape while Claude holds queued
  messages puts them back in the input box as a draft (`queue-operation` `dequeue`, measured): a
  message the log called queued can come back as text in the box. Stop already asks first in that
  case (ADR 0066); the draft row of ADR 0114 is how it is settled.
- The log's file format is undocumented (ADR 0067); an unknown shape decodes to nothing, and the send
  then falls back to the box.
- What would make it simpler, upstream: Herdr framing a bracketed paste itself when the pane's program
  enabled the mode (it tracks DECSET 2004), and a pane read that reports whether its content changed,
  so the waits could be pushed by Herdr instead of polled. Codex is unmeasured here (not logged in on
  the host); a Codex rollout as witness is the same change once a probe shows its rows.
