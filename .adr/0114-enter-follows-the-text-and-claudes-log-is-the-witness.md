# 0114. Enter follows the text, and Claude's log is the witness

- **Status:** Accepted (2026-10-21). Amends [ADR 0104](./0104-a-picture-travels-where-it-sits-in-the-message.md)
  (a picture's token is waited for, not timed), [ADR 0067](./0067-the-clis-own-state-decides-the-screen-is-the-fallback.md)
  (Claude's session state and log now decide a send, not only a turn), [ADR 0076](./0076-a-long-claude-send-is-one-paste-and-its-log-has-the-last-word.md)
  (the log is read before the box, not after it) and [ADR 0048](./0048-the-input-box-is-found-by-its-own-frame.md)
  (a read that shows the text is no longer the last look before Enter on a Claude pane with a log).
- **Trail:** `bridge/guarded-send.ts` (`submitAndLog`, `logWitnesses`, `judged`, `pictureDrawn`,
  `WAIT_DELAYS_MS`) · `bridge/routes/reply.ts` (`sendPane`: `waiting`, the prior attempt's `typedAt`) ·
  `bridge/queue-service.ts` + `bridge/server.ts` (`waiting`) · `scripts/bench/send-stress.ts`

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

1. **On a Claude pane whose log Nenu reads, Enter follows the text** with no look in between: the
   pre-flight read (or the sweep's read of an empty box) is the last look before the write, as a read
   used to be the last look before Enter. The same race is there either way, a dialog opening in the
   milliseconds between a look and a write, and the next rule narrows it.
2. **Claude's own state is asked first.** A session file that says `waiting` refuses the send before
   anything is typed, and stops it before Enter.
3. **Claude's log is the witness.** The send is sent when the log shows the message (whole, or
   `incomplete` as ADR 0076 says) or shows Claude queued it. A log that says nothing while the box no
   longer holds the message for a verify window is sent, as before. A box that still holds it at the
   bound means Claude never took the Enter: the send clears its own text (ADR 0112) and says so, then
   looks at the log once more, because the sweep's keys reach Claude after the Enter.
4. **A retry asks the log first.** A retry of a request id whose earlier attempt wrote looks at the log
   from that attempt's first write: logged is sent, without typing; a readable log that holds nothing
   since then proves the text never arrived, so it is typed again, once.
5. **Every wait ends on an event and is bounded, not timed.** The text in the box, a picture's token,
   the box emptying and the sweep clearing wait up to 15 s counted in the pauses between looks (on a
   loaded host the looks themselves are slow, so the wait only grows) and end on the first look that
   sees it. A picture's path that sits in the box for 1 s is taken as staying text; anything shorter
   is a picture still being read.
6. **A slash command, a `!` line, a dialog's text field and Type anyway keep the old order** (type,
   see it in the box, Enter, see it go): Claude logs them as something else, so the log cannot witness
   them. So does every pane without a log: Codex and the rest, with rule 5's waits.

## Consequences

- A typed send no longer waits for its own echo before Enter, and no send fails because the host is
  slow: the waits that used to stop a send at 2.5 s now give a loaded Claude 15 s, and a fast one
  answers as soon as it logs.
- A send that genuinely never arrives now costs up to 15 s before it says so, where it cost 2.5 s.
- The safety of Enter rests on the pre-flight read and on `waiting`, not on seeing the text. A rule
  that brings back a read between the text and Enter brings back the window a loaded host misses.
- The log's file format is undocumented (ADR 0067); an unknown shape decodes to nothing, and the send
  then falls back to the box as in rule 3.
- What would make it simpler, upstream: Herdr framing a bracketed paste itself when the pane's program
  enabled the mode (it tracks DECSET 2004), and a pane read that reports whether its content changed,
  so the waits could be pushed by Herdr instead of polled. Codex is unmeasured here (not logged in on
  the host); a Codex rollout as witness is the same change once a probe shows its rows.
