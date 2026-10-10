# 0056. Queued messages follow each CLI's native queue

- **Status:** Proposed. The direction was decided by Fran on 2026-10-10. The measured semantics
  below are pending the P0 probes, and the decision becomes Accepted once they are filled in.
- **Supersedes:** the message-queue half of [ADR 0025](./0025-artifacts-and-server-message-queue.md),
  specifically "Automatic sends wait for an idle/done agent". The artifacts half of 0025 stays in
  force, and so does the rest of its queue design (durable bridge file, enqueue ids, persisted
  `sending`, guarded writes, no replay of uncertain outcomes).
- **Trail:** `bridge/queue-readiness.ts` · `bridge/queue-service.ts` · `bridge/queue-delivery.ts` ·
  `bridge/message-queue.ts` · `bridge/journal/claude.ts` · `web/src/components/message-queue-strip.tsx`
  · `web/src/components/composer.tsx`

## Context

ADR 0025 made Nenu's queue wait for the agent. A message sent from the phone while Claude works is
held until Herdr reports `idle` or `done` (`queue-readiness.ts` returns `working` before it reads the
screen). In the terminal, the same message typed while Claude works goes into Claude's own queue.
Claude Code 2.1.296 documents that it reaches the model as soon as the current tool calls finish,
within the same turn, and that whatever is left at the end of the turn is sent then. The phone was
therefore slower and different from the desktop, for no safety reason: the guard that protects the
send (no dialog, no host draft, identity rechecked on every write) does not depend on the agent
being idle.

Codex was already different in the other direction, and the UI hid it. The queue marks every Codex
row `sendNow` (`queue-service.ts:169`, measured) and delivers it with Enter. Fixtures show Codex
offering "tab to queue message", and third-party sources say Enter during a turn steers it. So a
Codex message the strip described as "waiting for the agent to be free" was in practice injected
into the running turn. Neither Enter nor Tab is documented officially (unverified).

The structured record already exists for Claude. Its session JSONL writes `queue-operation` rows
(`enqueue`, `dequeue`, `remove` with reason `absorbed_mid_turn` or `delivered_to_agent`, `popAll`).
Local logs hold 3757 `absorbed_mid_turn` removals (measured). `bridge/journal/claude.ts` ignores
these rows today, so the queue confirms delivery by scraping an empty composer for up to about 2.9 s.

Two roads were open. Keep Nenu's queue as the only queue and keep waiting for idle, which is simple
but makes the phone a worse terminal. Or deliver into the CLI's own queue as soon as the composer is
safe to type into, and let the CLI decide when the model reads it, which is what the person would
get at the keyboard. Fran chose the second, with one addition: when the agent is busy, the person
chooses at send time.

## Decision

**Mirror what each CLI does natively at the keyboard, as measured, and never invent a semantics the
CLI does not have.**

1. **Nenu's queue stays as the durable outbox.** It is shared between devices, survives a restart and
   holds a message while the composer is unsafe (dialog, host draft, disconnected pane). What
   changes is when a row leaves it and what Nenu claims about it afterwards.
2. **An idle agent gets the message directly.** Send does not ask anything when the agent is free.
3. **A busy agent gets a choice at send time.** The composer offers two actions:
   - **Send now / steer.** The message enters the current turn, the way the CLI's own mid-turn
     input does.
   - **Queue for later.** The message runs after the current turn.

   Each row records the choice as `deliveryMode`. `steer` types into the running turn where the CLI
   steers on submit (Codex Enter, pending P0). `asap` hands the message to a CLI whose own queue
   absorbs it mid-turn (Claude Enter, pending P0). `afterTurn` uses the CLI's own next-turn queue
   when it has one (Codex Tab, pending P0), and otherwise Nenu holds the row until the turn ends,
   as 0025 does today. The choice is only
   offered for a CLI whose probes show it supports both behaviours. Codex is expected to support
   both. Claude gets the choice only if P0 shows the CLI distinguishes them, otherwise it gets the one
   behaviour its terminal has.
4. **Delivery keeps the 0025 guard and drops the status gate.** A row whose mode delivers mid-turn is
   typed as soon as the composer is free of dialogs and host drafts, even while the agent is
   `working`. A re-read immediately before Enter still applies, because a permission prompt can
   appear between typing and submit, and Enter would then answer it.
5. **Order holds across turns.** After a delivery, the next row for that scope waits until the turn
   has visibly started, using Herdr's `state_change_seq` (or the journal's `user` row) rather than a
   status read that can lag. This is what 0025 promised and the code did not enforce.
6. **Confirmation comes from the CLI's record when there is one.** For Claude, an `enqueue` row whose
   content matches confirms delivery, `remove` (absorbed or delivered) or `dequeue` marks it read,
   and `popAll` marks it recalled in the terminal. These are stored as the row's `native` state.
   Matching uses exact content and a time window, because `enqueue` rows also carry task and
   background-agent notifications. The screen check stays as the fallback for CLIs without a record.
7. **A blocked row says why.** Rows carry `waitingFor` (dialog, draft, working, disconnected) and
   `stranded` when their pane or conversation is gone. A stranded row is never delivered elsewhere
   on its own.

### Measured semantics (pending P0)

This table is the contract the delivery code implements. Until the probes fill it in, Nenu keeps
today's behaviour for the cell and the UI labels it unverified.

| CLI | Key while working | What the CLI does | Journal record | Status |
| --- | --- | --- | --- | --- |
| Claude Code 2.1.296 | Enter | Documented: queued, absorbed after the current tool calls | `queue-operation` rows | Pending P0 inside Herdr |
| Claude Code 2.1.296 | Ctrl+X Ctrl+S | Documented: send now | Unknown | Pending P0 (does Herdr pass the chord?) |
| Claude Code 2.1.296 | Up / Esc | Documented: recall queued / interrupt and send queued | `popAll` on recall | Pending P0 |
| Codex 0.160.1 | Enter | Third-party sources: steer the current turn | Unknown | Pending P0 |
| Codex 0.160.1 | Tab | Fixture footer "tab to queue message": queue for the next turn | Unknown | Pending P0 |
| pi | n/a | No adapter, no captures | n/a | Pending P0 and C1b; stays outside the queue |

If P0 contradicts a row, the table changes and so does the mapping from `deliveryMode` to keys. The
rule above it does not change.

## Consequences

The phone behaves like the terminal. A Claude message sent mid-turn is read after the next tool call
instead of after the whole turn, which can be minutes sooner. The model reads it between tool calls,
not at the end; that is the terminal's meaning too, and "Queue for later" exists for the other one.

Codex stops lying. The two actions name what happens, and the strip's copy follows the agent and the
mode instead of always saying "wait for the agent to be free".

Delivering while the agent works widens the window in which a dialog appears between typing and
Enter. The pre-Enter re-read keeps it closed as far as a read can. It is a risk the probes must
exercise, not one this ADR settles.

The semantics now depend on the CLIs' key bindings, which can change in any release. A changed
binding silently changes what "steer" means. The journal confirmation narrows that for Claude; for
Codex there is no record yet, so a version bump needs the probe re-run.

Revisit if a CLI exposes a structured input queue Nenu can write to without typing (for example
Codex's app-server queue, which needs a daemon-backed pane; see [ADR 0060](./0060-codex-panes-stay-off-the-daemon.md)),
or if probes show a CLI's mid-turn input is unsafe to type into through Herdr.
