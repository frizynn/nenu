# 0120. A Claude at its usage limit reads so, and its messages wait in Nenu

- **Status:** Accepted (2026-10-22). Reported by the operator on 1.41.2: a message sent from the phone to
  a coordinator held by the account's usage limit came back "Your message didn't show in the agent's
  input box, so nothing was sent", although it had. Amends [ADR 0067](./0067-the-clis-own-state-decides-the-screen-is-the-fallback.md)
  (the transcript is read once at rest), [ADR 0108](./0108-the-line-above-the-box-holds-only-live-work.md)
  (the limit's line takes the place the terminal's wait notice had above the box), [ADR 0113](./0113-a-state-is-a-still-glyph-coloured-only-when-it-asks-for-you.md)
  (one more mark) and [ADR 0114](./0114-a-send-from-nenu-never-gets-stuck.md) (a send it would refuse waits).
- **Trail:** `bridge/agent-state-sources.ts` (`ClaudeTurnScan.limit`, `claudeLimit`) ·
  `bridge/agent-state.ts` (`peekTranscript`, `profileReply`) · `bridge/queue-service.ts` (`wait: "limit"`) ·
  `web/src/lib/harness/claude/chrome.ts` (`AUTO_CONTINUE_NOTICE`) · `web/src/lib/usage-limit.ts` ·
  `web/src/components/agent-chat.tsx` (`data-usage-limit`) · `web/src/components/composer.tsx` (`limit`,
  `continueNow`) · `web/src/components/desk-nav.tsx` (`data-limit`) · `scripts/e2e/usage-limit.ts`

## Context

What happened on 2026-10-21 at 23:59, read from Nenu's audit and Claude's own log (Claude Code 2.1.306):

1. Under its input box Claude printed "⚠ Usage limit reached · limit resets 3:20am" and "Continuing
   automatically at 3:20am · esc to cancel". The guard read that "esc to cancel" as a dialog's key, so the
   first Send typed nothing ("The agent's input box isn't on screen").
2. The second try typed the message; it showed in Claude's box, but the same rows made every read
   "no input box" for 15 s, so the guard said nothing was sent and left the text there.
3. 13 s later the root coordinator typed its own "the account changed, continue" prompt into that box and
   Claude took both as one message, glued without a space.

Measured in Claude's log and its 2.1.307 code:

- A request the limit refuses leaves an assistant row with `apiError: "usage_limit_reached"` and
  `quotaLimits.resetsAt` (epoch seconds), and the turn ends within a second. Claude still logs every
  message typed meanwhile and carries the refused ones into the next request that goes through.
- At the reset Claude continues by itself with a prompt of its own ("Your claude.ai usage limit has
  reset. Continue the task…"). An account switch, Escape or a typed message cancels that; a typed message
  the limit refuses arms it again ("Usage limit reached again · continuing automatically").
- Nothing Claude writes says the account was switched until a request goes through.

## Decision

1. **The limit is the CLI's state, read from its log.** The newest `usage_limit_reached` row holds a
   Claude at rest until its reset passes or a reply comes through after it, on that Claude or on any Claude
   of the same profile (one sessions folder, one account) in a pane Nenu follows; a Claude outside Herdr
   lifts nothing. That reply is how a switched account shows.
   The transcript of a Claude at rest is read once more when its session file changes (1 MB on first
   sight), never watched. The screen's notice is not read for it.
2. **That notice is Claude's own, not a dialog.** Its three wordings with "esc to cancel" leave the input
   box ready: the box takes typing and Enter submits under it (measured). A dialog's footer under a stale
   box is still refused.
3. **A message for a Claude at its limit waits in Nenu's queue**, says "Goes when Claude is back, ~6:40 PM"
   and goes by itself when the limit lifts. Send now on the row lifts only that wait.
4. **Continue now** types Claude's own continue prompt without its claim that the limit reset. It is
   safe whatever the account: refused, Claude logs it and arms its automatic continue again.
5. **The line sits where the terminal's wait notice sat**, between the thread and the box, and only
   while the limit holds: it is the one thing the operator can act on there, and the notice it replaces
   is gone with it.
6. **A grey hourglass and "resets 6:40 PM"** mark the chat in the bar, Home and the chat's line. Grey: it
   resumes by itself and asks nothing of the operator.

## Consequences

- Typing into a limited Claude straight away was the other road: Claude keeps the message, so nothing
  would be lost. It was not taken: the reply to it would be another "You've hit your session limit", a
  typed message cancels the automatic continue until the refusal re-arms it, and the operator could not
  see what was still waiting. Through the queue the message stays editable and says when it goes.
- A reply that was already streaming when another pane hit the limit can lift the limit early. The queue
  then types into a Claude the limit refuses; Claude logs the message, re-arms its continue, and the new
  refusal holds the pane again. A weekly model limit beside a working model on the same account behaves
  the same way.
- Nenu never reads a credential or the account to see a switch; the first reply is the evidence.
- Codex is not covered: no Codex ran on this host and none of its limit screens or rollout rows were
  measured. Add it once one is.
- `bun scripts/e2e/run.ts usage-limit` must pass. Revisit if Claude starts writing the limit or the account
  into its session file.
