# 0057. The bridge reads and answers dialogs; the screen is the actuator and hooks only observe

- **Status:** Accepted (2026-10-10), shipped in 0.54.0. Observe-only hooks are a coordinator default,
  reversible. Free-text answers ("Type something", "Tab to amend", Codex notes) stay out until the P0
  probes measure their key recipes.
- **Extends:** [ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md) and
  [ADR 0053](./0053-an-unread-dialog-still-has-a-way-out.md), which keep governing which keys a
  dialog may receive. Keeps [ADR 0048](./0048-the-input-box-is-found-by-its-own-frame.md).
- **Trail:** `bridge/interactions.ts` · `bridge/routes/interactions.ts` · `bridge/prompt-binding.ts` ·
  `web/src/lib/harness/*` (the grammars, shared) · `web/src/lib/prompt-action.ts` ·
  `web/src/lib/dialog-guard.ts` · `scripts/install-claude-hooks.ts`

## Context

Every answerable prompt (permission requests, AskUserQuestion, plan approval, generic menus, Codex
approvals) is recognised only in the browser, only for the pane that is open, by the per-harness
grammars reading the rendered grid. The answer is guarded keystrokes: a fresh read, the dialog
re-derived through its adapter, a signature compare, and a bridge-side `expected_prompt` check
before `send_keys` (measured: `lib/prompt-action.ts`, `bridge/prompt-binding.ts`). Because the bridge
never knows what a blocked pane is asking, Home cannot show "Needs you" with the question, and a push
notification cannot carry it.

Structured sources exist and are tempting. Claude Code hooks (`PermissionRequest`, `PreToolUse` on
`AskUserQuestion|ExitPlanMode`, `Notification`) receive the full question, options and tool input.
A hook can also *decide*: return allow or deny, or fill in the answers, without a keystroke. Codex's
app-server sends approval requests to every subscribed client and takes the first answer. Either
would let Nenu answer without touching the terminal.

Three things argue against letting them decide. Whether a blocking hook suspends the TUI dialog while
it waits is undocumented (assumed, to be probed). A decision made off-screen races the person at the
keyboard. And Codex's routing of server requests among several clients is undocumented, while Nenu
launches Codex with `--no-daemon`, so those panes are invisible to the socket anyway
([ADR 0060](./0060-codex-panes-stay-off-the-daemon.md)).

## Decision

**Detect on the bridge, answer through the screen, and let structured sources only describe.**

1. The bridge keeps one neutral `Interaction` per agent pane: kind, question, context, options with
   their keys and a role (`primary`, `persistent`, `deny`, `freeText`), a signature and when it was
   detected. It is built by the same adapters the browser uses (the bridge already imports the
   grammar modules), only when the pane is `blocked` or Herdr reports `pane.output_matched`, and not
   again while the pane is unchanged.
2. It is published by name on the event stream (topic `interaction`, per
   [ADR 0054](./0054-the-browser-hears-what-changed-not-the-state.md)) and read over HTTP with an
   ETag. Home, the thread and push all render from it.
3. **An answer is one request, and the bridge keeps the client guard.**
   `POST /api/interactions/:pane/answer {signature, optionIndex}` re-reads the pane, re-derives the
   dialog, compares the signature (a stale one is a 409), checks `expected_prompt` and only then
   sends the option's keys. Read-only devices are refused as they are today. Write authority moves to
   the bridge; the binding it enforces does not change.
4. **Persistent options need a confirm.** An option that changes the agent's mode ("allow all edits
   this session", "don't ask again") is never a one-tap action on Home or in a push notification.
   Approving from Home or push is offered only when the card shows the full command or file; without
   that detail the card opens the thread.
5. **Hooks, the journal and Codex RPC only enrich.** They can supply the full question, option
   descriptions, plan text or tool input. If they disagree with the screen, the screen wins. They
   never choose a key, never return a decision, and their installation is opt-in from Settings.

## Consequences

Home and push can show and answer what an agent is asking without opening the thread, at the cost of
one read per blocked pane on the bridge. Answering costs one HTTP request and one or two reads,
against two of each today.

The screen stays the only path that writes, so every rule about keys (0009, 0017, 0053, the plan
dialog notes) still applies in one place. The price is that Nenu still scrapes to know *whether* a
dialog is up and which keys answer it, and a CLI release that changes a dialog's layout still breaks
recognition until a grammar catches up. A grammar miss falls back to the raw keys path, which is
safe but unexplained to the user.

Decision-returning hooks ("away mode", where the phone answers and the terminal never shows the
dialog) are not adopted. Revisit only with a probe that shows what the TUI does while a hook blocks,
a per-pane opt-in, and a timeout that always falls back to the terminal dialog.
