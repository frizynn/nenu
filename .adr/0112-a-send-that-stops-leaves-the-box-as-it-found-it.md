# 0112. A send that stops leaves the agent's box as it found it

- **Status:** Accepted (2026-10-21). Amends [ADR 0104](./0104-a-picture-travels-where-it-sits-in-the-message.md)
  decision 2 ("a token that never shows stops the send"). Decision 4's last sentence (a Send replaces
  a stranded draft) amended by [ADR 0113](./0113-a-send-from-nenu-never-gets-stuck.md), which also
  replaced `clearTakenDraft` with `settleDraft`. Reported by the operator from an iPhone on
  1.38.1: a picture left its path typed in Claude's box, the queue stuck behind it, and the phone
  could neither type nor delete in the terminal.
- **Trail:** `bridge/guarded-send.ts` (`typePieces`, `pictureDrawn`, `unsent`, `clearTakenDraft`) ·
  `web/src/lib/harness/inline-images.ts` (`pathShows`, `draftIsPartOfSend`, `holdsCliToken`) · `bridge/queue-delivery.ts` ·
  `bridge/message-queue.ts` (`CLEARED_TRIES`) · `bridge/routes/reply.ts` (`clear-draft`) ·
  `web/src/components/composer.tsx` (`takeOverDraft`) · `scripts/e2e/take-over.ts`

## Context

What happened, from the audit log and the queue file: the message went out while Claude worked, so
it went through the queue, whose write wrapper ignored the piece it was handed and pasted the whole
message every time. Claude attaches a path only when it is pasted alone, so no `[Image #1]` showed,
the send stopped with "check Terminal before retrying", and the path and words stayed in the box. The
row paused; the retry queued behind it and behind a draft the queue never clears. Take over copied
the draft into the composer and left it in the terminal, and Type into terminal refuses to arm while
the composer holds text, so nothing on the phone could remove it.

Measured on Claude Code 2.1.306 in a Herdr pane: a path to a file that does not exist, pasted alone,
stays in the box as text, and Claude, given the message with the path in it, reads the path and
answers about it. A direct send through the fixed queue attaches the picture whether Claude is idle
or mid-turn (`[Image #4]` in its own queue).

## Decision

1. **A picture whose token never shows but whose path sits in the box goes as that path.** The agent
   reads a path it is given, which is how every message reached it before ADR 0104. Enter still waits
   for the adapter to read the whole message: each picture as its token or its path.
2. **A send that typed and stops before Enter clears the box when the box holds only what it typed**
   (its words in order, each picture as token or path, a prefix of the message at most), with the
   send's own sweep and a read that shows it empty. The error then says the box is empty and to send
   again. A box holding anything else may be the operator's, and stays, with the old wording.
3. **A queued row whose delivery cleared the box goes again**, at most three times, then pauses.
4. **Take over moves the draft**: the composer gets the text, and the bridge clears the box only while
   a fresh read, under the pane's write lock, shows that exact text (`clear-draft`). A read-only
   device only copies. A draft holding `[Image #N]` or a collapsed paste offers no Take over at all: a
   copy would be only the token, and its Send would sweep the picture or paste that lives in the CLI
   alone. Type into terminal edits it in place, and `clear-draft` refuses it too. A Send from the
   phone still replaces any stranded draft, tokens included, as it did before this decision.

## Consequences

- A picture the CLI never attaches costs the verify window (2.5 s) before its path goes as text. One it
  attaches later than that lands after the next piece; the final read then fails and the send stops
  with "check Terminal", never a wrong Enter.
- "Check Terminal before retrying" remains only where Nenu cannot tell its typing from the operator's.
- Take over now writes to the terminal. It is the operator's tap, bound to the text the phone showed;
  a host that typed on keeps its line. Don't return it to a copy: the copy is what stranded the queue.
- Claude has no `composerPrompt`, so the client cannot bind a sweep itself; `clear-draft` binds to the
  draft's text on a local read instead. Adding one to Claude would also bind every send's sweep, which
  is its own decision.
