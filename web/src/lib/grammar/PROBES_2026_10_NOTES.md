# Probes 2026-10: what the CLIs actually do

Live probes run on 2026-10-10 in a **disposable** Herdr server (its own `HERDR_SOCKET_PATH`,
`XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_RUNTIME_DIR`), never the operator's server. Every claim is
tagged **MEASURED** (seen live, evidence named), **INFERRED** (follows from what was measured) or
**ASSUMED** (documented or plausible, not observed).

| Component | Version | Notes |
|---|---|---|
| Herdr (disposable server) | 0.9.3, protocol 22 | The installed binary. The operator's long-running server is 0.9.1 and was only read (pane list before/after, identical). Timings below are from 0.9.3. |
| Claude Code | 2.1.296 | `--model haiku --effort low --setting-sources project,local`; only the Herdr SessionStart hook was installed (project settings), so no operator hook ran. |
| Codex CLI | 0.160.1 | `--no-daemon -c features.hooks=false -c notify=[] -c model_reasoning_effort=low -a on-request -s workspace-write` |
| pi | 1.0.0 (`@earendil-works/pi-coding-agent`) | Newest release older than 7 days. No provider logged in, so no turns ran. |

Pane size 119×40. Pane captures sit in `harness/{claude,codex,pi}/fixtures/*-v2296|v0160|v100.txt`
(read the same way the mirror reads: `pane.read` source `recent`, format `ansi`). They are deliberately
**not** in `fixtures/panes/`: the corpus tests glob that directory and pin every file, so adding a
capture there is a decision for whoever owns the grammar (see "Grammar gaps" below). Journal excerpts
(paths and user name scrubbed) are `claude/fixtures/journal-queue-and-dialogs-v2296.jsonl` and
`codex/fixtures/rollout-steer-queue-approval-v0160.jsonl`.

## Claude Code 2.1.296

### Typing + Enter while the agent works (the native queue)

MEASURED, three turns, JSONL rows in `journal-queue-and-dialogs-v2296.jsonl`:

1. **Enter enqueues.** A `{"type":"queue-operation","operation":"enqueue","content":…}` row is
   written at the moment of Enter. The screen moves the message above the input box with a
   `ctrl+enter to send now` hint, and the empty box shows the placeholder
   `Press up to edit queued messages` (`working-queued-v2296.txt`).
2. **It is absorbed mid-turn, at the next tool boundary.** When the running tool returns, Claude
   writes `operation:"remove"` plus an `attachment` row `{"type":"queued_command","prompt":…,
   "origin":{"kind":"human"},"humanTurn":true}` and the model answers it **in the same turn** (same
   `promptId`). With a 25 s foreground `python3 slow.py` the message waited the full 25 s for the
   tool to finish; the tool was **not** interrupted.
3. **No tool boundary left → next turn.** Queued during a tool-free text answer, the message was
   `dequeue`d right after `turn_duration` and became a new user row with a **new** `promptId`.
4. **Up recalls.** `Up` while a message is queued writes `operation:"popAll"` and puts the text back in
   the input box (`working-queued-recalled-v2296.txt`). `Up` on an idle box is plain history recall;
   the top border then carries a `History N/M` label (`history-recall-v2296.txt`).
5. **Ctrl+Enter = send now.** With a message queued and a foreground Bash running, `send_keys
   ["ctrl+enter"]` made Claude move the command to the background ~1.6 s later (tool_result
   `"Command was moved to the background … so that a message that arrived while it was running could
   be delivered"`, `toolUseResult.backgroundedToDeliverMessage: true`), then `dequeue` and a new user
   row with a new `promptId`. The background command kept running and later arrived as a
   `<task-notification>` (itself `enqueue`/`dequeue`).
6. **Ctrl+X Ctrl+S does the same through `send_keys`** (two calls: `ctrl+x`, then `ctrl+s` 100 ms
   later): backgrounded after ~2.9 s, same rows. In one earlier run with text in the box (recalled
   via Up) it first wrote `enqueue` for that text and the backgrounding came ~10 s later; not
   reproduced, cause unknown. On an idle box Ctrl+X Ctrl+S simply submitted the draft.
   INFERRED: "send now" only shortens the wait when a long tool is running; it backgrounds it rather
   than killing it. Not probed: send-now while the model streams text with no tool running.

Herdr status stayed `working` the whole time a message was queued (MEASURED, event log).

**For the design (INFERRED):** Claude supports both modes the decision asked about. Plain Enter is
"after the current tool call" (steer-like when tools remain, after-turn when none do); Ctrl+Enter /
Ctrl+X Ctrl+S is "now". The JSONL gives delivery confirmation without screen scraping: `enqueue` →
`remove` + `queued_command` (absorbed mid-turn) or `dequeue` + user row (new turn), `popAll` (recalled
to the box).

### Permission prompt, "Tab to amend"

MEASURED (`permission-bash-v2296.txt` and the `-amend*` captures). The Bash prompt now has four rows:
`1. Yes`, `2. Yes, and always allow access to <dir> from this project`,
`3. Yes, and switch to auto mode · …`, `4. No`; footer `Esc to cancel · Tab to amend`. A
`Tip: auto mode handles these prompts…` line sits under the title.

- `Tab` on row 1 relabels it `Yes, and tell Claude what to do next`; typing replaces the label with
  `Yes, <text>`. Enter **runs the tool** and the JSONL tool_result message carries an extra
  `{"type":"text","text":"<text>"}` block. The turn continues.
- `Down`×3 to row 4, `Tab`: `No, and tell Claude what to do differently`; typing gives
  `No, <text>`. Enter rejects the tool, the turn **continues** with the feedback.
- Digit `4` alone rejects and **ends** the turn (`[Request interrupted by user for tool use]`).
- The footer loses `· Tab to amend` while the amend field is open.

### AskUserQuestion, multi-select and "Type something"

MEASURED (`ask-*-v2296.txt`). Rows `N. [ ] Label` with an indented description, then
`N. [ ] Type something`, then an unnumbered `Submit` row, a rule, and `N+1. Chat about this`. Tab strip
`←  ☐ Fruit  ✔ Submit  →` (☒ once something is checked).

- A digit toggles that row (`[✔]`), the pointer does not move.
- Focusing `Type something` adds `ctrl+g to edit in Vim` to the footer; typing **checks the row and
  replaces its label** with the typed text (`4. [✔] Mango`).
- `Down` to `Submit`, Enter → a review screen (`Review your answers` / `→ Apple, Mango` /
  `1. Submit answers  2. Cancel`). Digit `1` submits.
- JSONL: the `AskUserQuestion` tool_use row (full questions and options) is written **while the dialog
  is still on screen**; the answer arrives as a tool_result `The user answered: "…"="Apple, Mango"`.

### Plan mode exit (ExitPlanMode)

MEASURED (`plan-approval-v2296.txt`). Options: `1. Yes, and use auto mode`,
`2. Yes, manually approve edits`, `3. Tell Claude what to change` with a hint line
`shift+tab to approve with this feedback`; footer `ctrl+g to edit in Vim · ~/.claude/plans/<slug>.md`.
**Yes, the plan is in the JSONL**: the `ExitPlanMode` tool_use row carries `input.plan` (full markdown)
while the dialog is pending, and the plan file path is on the footer. Esc rejects and ends the turn.

### A slow PreToolUse hook

MEASURED. A project hook `sleep 12` on `Bash` (picked up live, no restart): the spinner line read
`(probe hook holding… · Ns)` (the hook's `statusMessage`), the empty input box stayed drawn, Herdr status
stayed `working` (`hook-holding-v2296.txt`). For a command that needs permission, the prompt appeared
only **after** the hook returned (6 s hook → dialog at 7.7 s, Herdr `blocked` then). So a hook that
waits for a phone decision hides the terminal's own dialog for as long as it waits, as the research
assumed.

### Does `wait_for_output` see an unsent draft?

MEASURED. Yes. Typing `QUAIL-77` into an idle box (no Enter) matched `pane.wait_for_output`
(`source: visible`, substring) **118 ms** after `send_text`; `recent` and `recent-unwrapped` match
too. The matched line is `❯ QUAIL-77`: Claude puts a **no-break space** after `❯`, so a regex
written with a plain space (`❯ QUAIL`) times out. Rust regex `$` needs `(?m)` to mean end of line.

### `agent.prompt` against ADR 0010 / 0023

MEASURED. `herdr agent prompt <pane> "<13-line text>" --wait` on an idle Claude: the box showed
`[Pasted text #1 +12 lines]` 0.33 s in (so Herdr sends it as bracketed paste), Enter followed inside
the same call, the turn ran, and the call returned at 2.85 s. Claude then showed a
`paste again to expand` footer (`paste-again-hint-v2296.txt`). INFERRED: `agent.prompt` gives no
window between typing and Enter, so the ADR 0010 check (verify the placeholder before Enter) and the
ADR 0023 re-read cannot run inside it; it fits only where Nenu has decided not to verify. Documented,
not probed: it rejects a `blocked` target with `agent_blocked` before sending anything.

### Other 2.1.296 observations (MEASURED)

- Trust prompt: the cursor starts on `❯ No, exit`; `Down`, `Enter` trusts (`trust-prompt-v2296.txt`).
- Permission modes cycle with `shift+tab`: auto → `⏸ manual mode on` → accept edits → plan → auto.
  The default mode is now labelled **manual**.
- Claude Code refuses a bare `sleep 25` ("Blocked: standalone sleep") and chained sleeps; probes need a
  real script for a long foreground tool.

## Codex 0.160.1

### Enter vs Tab while working

MEASURED, rows in `rollout-steer-queue-approval-v0160.jsonl`:

- **Enter = steer.** The screen shows `• Messages to be submitted after next tool call (press esc to
  interrupt and send immediately)` with the message (`busy-after-enter-v0160.txt`). It is delivered
  **after the running tool call finishes** (the 20 s command was not interrupted), as a user
  `response_item` with the **same `turn_id`**; the model answers it in that turn.
- **Tab = queue.** `• Queued follow-up inputs` / `↳ <text>` / `shift+← edit last queued message`
  (`busy-after-tab-v0160.txt`). Delivered after `task_complete` as a **new** `task_started` turn. While
  drafting during a turn the footer offers `tab to queue message` (`busy-draft-v0160.txt`).
- **Esc with a steer pending = send now.** `• Model interrupted to submit steer instructions.`;
  rollout `turn_aborted {reason:"interrupted"}` then a new turn with the message. The running command
  survives as a background terminal (`1 background terminal running · /ps to view`).
- The rollout records **nothing while a message waits** (no row between Enter/Tab and delivery), so
  pending state is only visible on screen.

### Approval

MEASURED (`approval-exec-v0160.txt`). `Would you like to run the following command?`, a new
`Environment: local` line, `Reason: …`, `$ <cmd>`, then `1. Yes, proceed (y)`,
`2. Yes, and don't ask again for commands that start with … (p)`,
`3. No, and tell Codex what to do differently (esc)`; footer `Press enter to confirm or esc to cancel`.
`y` approved. Rollout: the `custom_tool_call` with `sandbox_permissions:"require_escalated"` is
written while the dialog is up; no approval row exists, only the later output.

### request_user_input

MEASURED (`ask-plan-mode-v0160.txt`). With `default_mode_request_user_input` off (its default), the
tool is available in **Plan mode** (`shift+tab`; it also switched the model to `medium` effort). Card:
`Question 1/1 (1 unanswered)`, question, `› 1. Apple  …`, auto-added `3. None of the above  Optionally,
add details in notes (tab)`, footer `tab to add notes | enter to submit answer | esc to interrupt`
(no `←/→` hint on a single question). Digit `2` answered and submitted. Rollout: `function_call
request_user_input` (full questions) while pending, then `retained_context verified_answer` and
`function_call_output {"answers":{…}}`.

### `no rollout found` with `--remote` on 0.162

**Not probed.** 0.162.x was published 2026-10-08/09, inside the 7-day supply-chain window this repo
enforces, so it was not installed. ADR 0022 stays as is until someone re-probes on a version old
enough.

## pi 1.0.0

MEASURED, composer only (no model, so no turns):

- Composer = the rows between two dim rules above the `cwd (branch)` and usage lines; the cursor is a
  reverse-video space (`\e[7m \e[0m`) inside the pane text (`idle-v100.txt`, `draft-single-v100.txt`).
- **Bracketed paste works**: `\e[200~…\e[201~` with 3 lines lands as 3 composer lines, nothing
  submitted, no stray escape text (`bracketed-paste-3-lines-v100.txt`).
- Paste placeholder: more than 10 lines → `[paste #N +L lines]`; more than 1000 chars on fewer lines
  → `[paste #N C chars]` (10 lines stayed inline, 11 collapsed, 1200 chars collapsed; thresholds match
  the bundled source `pastedLines.length>10||totalChars>1e3`) (`bracketed-paste-30-lines-v100.txt`).
- `ctrl+l` opens the model selector (not "clear"); `ctrl+u` deletes one line of a multi-line draft.
- ASSUMED (pi docs, not run): Enter while running = steer (after the current assistant turn's tool
  calls), `alt+enter` = follow-up queue (after the agent finishes).

## Herdr 0.9.3 (disposable server, all other agents idle)

- **`blocked` vs `output_matched`** (MEASURED, 9 dialogs): `blocked` arrived 1749 (first dialog, trust
  prompt at startup), 317, 205, 108, 103, 102, 0, −1, −8 ms after `output_matched`. Median ~102 ms.
  The order is not fixed; either can come first.
- **`pane.updated` does not track status** (MEASURED): 68 status changes vs 66 `pane.updated`, and the
  updates follow metadata, each with a new `revision`. Claude produced 4 (agent detected, session id,
  `/clear` new session, title). Codex produced bursts every ~100 ms at startup and ~1/s while blocked,
  following its animated terminal title. INFERRED: treat it as a metadata poke only.
- `output_matched` fired once per new dialog (9 dialogs, 9 events) for a standing regex subscription.
- Restarting the disposable server **restored the session and typed `claude --resume <id>`** into the
  pane that had held Claude (MEASURED). Probe servers need their state dir deleted afterwards.

## Grammar gaps found with these captures (current adapters, `buildBlocks` / `composerReady`)

MEASURED by running the adapters on the new captures:

| Capture | Today | Why it matters |
|---|---|---|
| Claude `trust-prompt-v2296` | raw | 2.1.296 trust prompt not lifted (cursor starts on "No, exit"). |
| Claude `working-queued-v2296` | `composerReady=false` | While a message is queued Nenu refuses to type, so a second queued send is blocked. |
| Claude `hook-holding-v2296` | `composerReady=false` | Same during a slow hook, although the empty input box is drawn (typing there was not tried). |
| Claude `permission-bash-amend*`, `permission-deny-amend-typed` | raw | "Tab to amend" not modelled. |
| Claude `permission-bash`, `plan-approval`, `ask-*` | lifted | 4-row permission and new plan options parse today. |
| Codex `approval-exec`, `ask-plan-mode`, `trust` | lifted | `Environment: local` line does not break parsing. |
| Codex `busy-after-enter`, `busy-after-tab` | raw, `composerReady=true` | Pending steer / queue is not surfaced to the UI. |

## Not done

- Claude `agent.prompt` on a blocked or working pane: skipped, documented behaviour only.
- Codex 0.162 `--remote`: skipped, see above.
- pi turns, queue and dialogs: no provider credentials in the probe.
- Timings on the operator's 0.9.1 server: not measured (read-only rule).
