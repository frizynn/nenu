# 0114. A send from Nenu never gets stuck, and the Terminal view is the terminal

- **Status:** Accepted (2026-10-21). Amended by [ADR 0120](./0120-a-claude-at-its-usage-limit-waits-and-its-messages-wait-in-nenu.md): a send to a Claude at its usage limit waits in Nenu's queue. Reported by the operator on a desk with 1.38.1 and again on
  1.38.4. Amends [ADR 0056](./0056-queued-messages-follow-each-clis-native-queue.md) decision 3 (the
  send-time question), [ADR 0112](./0112-a-send-that-stops-leaves-the-box-as-it-found-it.md)
  decision 4 ("a Send from the phone still replaces any stranded draft"),
  [ADR 0104](./0104-a-picture-travels-where-it-sits-in-the-message.md) only through 0112, and how
  [ADR 0077](./0077-on-a-desk-type-into-terminal-lives-in-the-terminal-tab.md) and
  [ADR 0079](./0079-on-a-desk-the-keyboard-is-the-keys.md) arm Type into terminal.
- **Trail:** `web/src/components/composer.tsx` (`hostDraft`, `draftPick`, `settleHostDraft`, the
  `later` control) · `web/src/components/terminal-draft-preview.tsx` · `bridge/guarded-send.ts`
  (`settleDraft`, `LEFT_IN_BOX`) · `bridge/routes/reply.ts` (`clear-draft` with `action`) ·
  `web/src/hooks/use-direct-typing.ts` (`auto`) · `web/src/components/live-conversation.tsx` (the
  queue slot) · `web/src/components/message-queue-strip.tsx` · `bridge/chat-upload-preview.ts`
  (`queuedUpload`) · `scripts/e2e/send-always.ts`

## Context

What the operator saw on 2026-10-21, and what a real Claude Code 2.1.306 in a Herdr pane of its own
showed on 1.38.4, behind a bridge built from `main`:

- **The question sat in the middle of the screen.** Send while Claude works opened "Claude is working.
  When should it read this? Send now / Queue for later / Cancel" above the box: 202 px tall on a desk,
  228 on a phone. With pending messages under it, it read as a section of the conversation, far from
  the box.
- **Text in Claude's box held everything.** A message queued while the box held text waited
  ("Waiting. The terminal's input box holds a draft.") and was still waiting after the turn ended: the
  queue never clears a draft it did not type, and nothing in Nenu could. Take over was the only
  action, and for `[Pasted text #37 +27 lines]` it is withheld (ADR 0112). On an idle Claude a direct
  send did the opposite: it swept a hand-typed draft without a word (measured: "borrador escrito a
  mano" gone, the message sent alone).
- **Pending messages drew a chat over the chat.** The queue's rows that have no bubble on this page
  (queued before a reload, as an update's reload leaves them, or on another device) were a strip inside
  the composer, up to 13 rem, over the end of the thread; a table was cut in half. Their pictures were
  empty tiles: the bridge serves an upload only once the journal shows it, and a queued message is not
  in the journal yet.
- **The Terminal view did not take the keyboard.** In the chat's Terminal view, "hola" typed in the box
  went into the chat's draft; the desk's Terminal tab needed its switch first.
- **The errors pointed away.** "Nothing was submitted; part of the message may be typed, so check
  Terminal before retrying."

What the CLIs do at their own keyboard (ADR 0056's table): Enter while Claude works puts the message
in Claude's queue, read after the step it is on; Codex's Enter steers. T3 Code does the same by default
("steer") and keeps queueing a modifier away.

## Decision

1. **Send while the agent works goes now, as the terminal's Enter**: Claude's `asap`, Codex's `steer`.
   Nothing asks. "Send after this turn" is a row of the + menu while the agent works and the box has
   something to send (`afterTurn`, as before). The question is gone.
2. **Text in the agent's box is settled in one tap, beside the box.** The row above the box ("Text in
   Claude's box") offers **Send it first** (Enter in the terminal), **Add to my message** (Take over:
   it joins the draft and leaves the terminal) and **Discard**. Send it first and Discard are bound to
   the text the phone shows, as Take over is: a fresh read under the pane's write lock must show
   exactly that text, or nothing is pressed (`settleDraft`). They act on a paste or picture only the
   CLI holds as well, because the operator saw it and chose; Add to my message still is not offered
   for one (ADR 0112).
3. **A Send over that text waits for the tap, never sweeps it and never queues behind it.** The row
   says "Your message goes as soon as you choose", Send shows it waiting, the tap settles the box, and
   the message goes on its own; it also goes if the box empties at the terminal, never on a preview
   that only hid for a read. Don't send mine (or Esc on a desk) takes it back, and so does a hidden
   page: a message never goes on its own while nobody looks. A row of the queue that waits on
   such text says so and points at the same three buttons, and goes by itself once the box is free
   (unchanged: the queue's tick already sends a row the moment its box empties).
4. **A message sent from Nenu is drawn in the thread, at its end, until the journal has it.** The
   queue's rows with no bubble on this page are drawn into the conversation's own list, after its last
   turn, the same bubble as this page's sends, never in the composer. The bridge serves a picture a queue
   row on that pane names, under the same rules as one the journal names (a generated upload name,
   directly in an uploads folder, contained, sniffed).
5. **The Terminal view is the terminal.** While the chat's Terminal view or a desk's Terminal tab is on
   screen, the box types into the pane key by key (ADR 0079's keys), and leaving the view gives the
   chat its box back with its draft untouched. The view on screen is the named choice ADR 0077 asked
   for: the operator is looking at the pane. The switch, and the box's own keyboard button, turn it off
   for as long as the view stays. Every disarm of `use-direct-typing.ts` still holds (pane switch, lock,
   hidden page, failed batch); the view arms it again when it is live again, without a notice. The +
   row still arms it in the chat for one pane, as before.
6. **An error says what happened and what to tap.** A stopped send says nothing was sent, and that
   whatever is left in the box shows above the composer with Send it first and Discard; "check Terminal"
   stays only where Nenu cannot tell what happened.

## Consequences

- One tap less for the common send while the agent works; one more (the + row) for the rare one that
  must wait for the turn. A Claude message mid-turn is read after the step it is on, which is what the
  operator's terminal has always done.
- A hand-typed draft is never lost to a send from the phone. The cost is a tap when one is there.
- Arriving at a pane whose chat is on its Terminal view (a remembered view) arms the box. That is the
  view's meaning now; a pane whose chat is the conversation still needs the + row.
- `bun scripts/e2e/run.ts send-always` must pass: a queued message with a picture is drawn in the
  thread and its picture loads, Send while working asks nothing, text in the box never holds a send,
  and the Terminal view types into the pane, on a phone and a desk.
- The guard against sweeping lives in the client: `/send` still sweeps a stranded draft before it
  types, as ADR 0112 left it. A send that reaches the bridge with the box's text unsettled (a client
  of an older build, a read that missed the text) still replaces it. Moving that refusal into the
  bridge is the transport's change to make.
- Shell panes keep their composer: their only view is the mirror, and a command still goes through
  the guarded send unless Type into terminal is armed from the +.
