# 0076. A long Claude send is one bracketed paste, and Claude's log has the last word

- **Status:** Accepted (2026-10-14). Amends [ADR 0010](./0010-long-sends-are-verified-via-the-paste-placeholder.md):
  its claim that `pane.send_text` cannot carry a bracketed paste, and its idea that a paste
  placeholder consistent with the message proves the message arrived. Keeps 0010's placeholder
  grammar as the evidence for Enter and its refusal to chunk sends.
- **Amended by:** [ADR 0114](./0114-enter-follows-the-text-and-claudes-log-is-the-witness.md): on a pane with a log, Enter follows the text and the log is read before the box.
- **Trail:** `web/src/lib/harness/claude/paste.ts` (`sendsAsOnePaste`) · `bridge/guarded-send.ts`
  (`logged`) · `bridge/delivery-check.ts` · `bridge/routes/reply.ts` (`claudeLog`) ·
  `bridge/agent-state.ts` (`claudeSessionId`)

## Context

A 1 430-character message sent from Nenu reached Claude Code 2.1.300 as its last 408 characters, and
Nenu said "Sent". Measured in a disposable Herdr 0.9.3 on macOS, one byte-level step at a time:

- Herdr is not cutting anything. A raw reader in a pane received the 1 430 bytes of one
  `pane.send_text` intact, in two reads of 1 022 and 408 bytes. The PTY splits the write.
- Claude drops the first read. It takes a read of more than 800 characters as a paste, and when the
  rest of the message arrives as a second read it often keeps only that. Sent with plain
  `pane.send_text`, 1 025 characters logged only the last 3 in 3 of 3 sends on 2.1.300; 1 500
  characters logged only the last 478 in 3 of 4 on 2.1.300, 3 of 3 on 2.1.299 and 2 of 2 on 2.1.296.
  2 000 and 4 000 characters, whose second read is a paste of its own, arrived whole. It is not new
  in 2.1.300.
- Framed as ONE bracketed paste (`ESC[200~ … ESC[201~` inside the same `pane.send_text`, as Codex
  already gets per [ADR 0023](./0023-codex-replies-use-bracketed-paste.md)) every send arrived whole:
  9 of 9 on 2.1.300 between 300 and 4 000 characters with and without newlines, 2 of 2 on 2.1.299
  and 1 of 1 on 2.1.296. Claude still collapses it into one `[Pasted text #N]` (`+M lines` exact),
  so 0010's grammar verifies it. A bracketed paste of up to 790 characters on one line is typed as text, and a
  bracketed `/help` still opens the command popup and runs on Enter.
- The guard said "Sent" because the box it read showed either the token, or only the literal tail,
  which is a slice of the message like any windowed draft. Nothing on screen tells a whole send from
  one that lost its head. Claude's log does: it records the message, each paste inside
  `<pasted_content id="…">` tags.

## Decision

1. **A Claude send longer than Claude's paste threshold (800 characters) goes as one bracketed
   paste.** At or below it nothing changes: no read of it can be a paste, so it stays typed text,
   and an image path in a short message stays a path.
2. **After Enter, Claude's own log has the last word on a send it can judge.** The bridge reads the
   log of the session the pane runs (mapped through Claude's session file, ADR 0067) for the first
   typed message logged from the Enter on. Holding all of the message, whitespace aside, is sent.
   Holding fewer characters is `incomplete`: the send answers that the message reached the agent
   incomplete, with how much arrived, and the composer marks it failed, not sent. No log within the
   confirm window, a message Claude queued, an attached image or any other rewrite gets no verdict
   and keeps "Sent".
3. **Don't chunk.** 0010's reasons stand, and a bracketed paste removes the need.

## Consequences

- Rule 1 removes the measured loss. Rule 2 is the witness if Claude ever drops text another way or
  lowers its threshold, and it does not depend on the message's length.
- An idle send now waits for Claude to log the message before answering, which takes one or two
  reads after the box lets go. A pane whose session Nenu cannot map, or a non-Claude pane, skips it.
- A message with an image path is not judged, because Claude logs `[Image #N]` in its place. The
  queue (`bridge/queue-delivery.ts`, its log from `bridge/queue-service.ts`) gets both rules through
  the guarded send: a row Claude logs incomplete stays in the queue, paused, instead of delivered.
- Codex is unchanged: it already sends every message as one bracketed paste.
