# 0104. A picture travels where it sits in the message

- **Status:** Accepted (2026-10-20); decision 2's stop on a missing token amended by
  [ADR 0112](./0112-a-send-that-stops-leaves-the-box-as-it-found-it.md). Amends how [ADR 0074](./0074-an-attached-file-is-saved-for-the-agent-and-never-served.md)
  puts a picture on the wire (`serializeMessage`, every path after the prose); other files keep it.
- **Amended by:** [ADR 0115](./0115-enter-follows-the-text-and-claudes-log-is-the-witness.md): a picture's token is waited for until it shows, not for a fixed window.
- **Trail:** `web/src/lib/message-images.ts` (`imageChip`, `serializeDraft`, `draftFromWire`,
  `keepChipsWhole`, `tokenPieces`, `pathPieces`) · `web/src/lib/harness/inline-images.ts` ·
  `bridge/guarded-send.ts` (`typePieces`) · `web/src/components/draft-chip-layer.tsx` ·
  `web/src/hooks/use-draft-chips.ts` · `web/src/lib/upload-path.ts` (`isPicturePath`) ·
  `web/src/components/attachment-chips.tsx` · `web/src/components/transcript-view.tsx` (`UserWords`) ·
  `scripts/e2e/inline-images.ts`

## Context

The composer appended every uploaded path after the prose, so a message about two screenshots reached
the agent as its words and then two paths. What each CLI made of that, measured 2026-10-20 in Herdr
panes on Claude Code 2.1.304 and Codex 0.162.1:

- Claude, a short message (typed): the paths stay text; Claude attaches nothing and reads each file
  with its Read tool after the fact.
- Claude, past 800 characters (one bracketed paste, ADR 0076): every `[Image #N]` first, then the prose.
  A single paste holding paths between words is no better: Claude splits the paths onto lines of their
  own and attaches none of them.
- Codex (always one paste): the paths stay text; nothing is attached.

At the terminal, a person drags or pastes each picture where they are writing. The CLI then attaches
it and draws `[Image #N]` at the cursor, and logs the message that way: Claude its text with the
tokens in place and the pictures after it ("este certifi[Image #7] cado" in a real log), Codex the
pictures and then the text with the tokens in place. That is what the model reads, and the Chat UI
should give it the same. The operator asked for exactly that, and for the composer to show where each
picture goes.

Two facts shape how: each CLI attaches a path only when it arrives as a paste of its own, and Claude
draws the token about 150 ms after that paste, so text sent on its heels lands before the token
(measured: `AA first  then BB  end CC[Image #3] [Image #4]`). Codex draws it at once.

## Decision

1. **On the wire a picture's path sits where its chip was**, set off by whitespace; files other than
   pictures still go after the prose. The wire stays plain text, so drafts, queue rows, local bubbles
   and the audit log keep their shape, and an old message (paths at the end) still reads.
2. **The bridge types such a message piece by piece** for a harness whose adapter declares
   `pastesImagePaths` (Claude and Codex): each text piece as that adapter types any text, each
   picture's path as a bracketed paste of its own, and before the next piece a read that shows the
   token. A token that never shows stops the send with nothing submitted. Enter still waits for the
   adapter to read the whole message in the box: its words in order, a token where each picture was.
3. **A harness without it gets the paths in place, as text** (omp today). Its agent reads them where
   they sit, as it always read paths.
4. **In the draft a picture is a chip**, characters in the textarea (two blank Braille cells, "Image
   #N", a word joiner: nothing anyone types, not whitespace, no line break inside). A layer under the
   textarea paints the pill and the icon. An edit that touches a chip takes the whole chip and its
   picture; removing the thumbnail takes the chip; the rest renumber; chip text that names no picture
   (pasted back, brought back by undo) leaves. The textarea stays the editor, in the composer and in
   the queue editor alike (`hooks/use-draft-chips.ts`).
5. **The conversation draws each picture at its token** (the k-th token is the message's k-th picture,
   whatever its number), or at its path when the CLI kept paths as text.

## Consequences

- Never send a message with pictures as one paste or one write to Claude or Codex, and never move the
  paths back to the end: the pictures would arrive first, last, or not at all.
- A message with pictures costs one write and one wait per picture, about 150 ms each on Claude.
- A rich-text editor (contenteditable) would draw a true chip, but it would take the native textarea,
  its dictation and every textarea-bound behaviour in `composer.tsx` with it. Reopen that as its own
  decision.
- omp is not installed where this was measured. If its CLI attaches pasted paths, declaring
  `pastesImagePaths` on its adapter is the whole change, once a live probe shows its token.
