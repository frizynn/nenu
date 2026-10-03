# Automatic Codex history recovery from the live terminal title

Status: accepted locally, 2026-10-03. Supersedes the manual-only recovery requirement in ADR 0022.

## Context

Fran reported that an existing Codex terminal still required selecting a conversation manually.
Four live daemon-backed terminals reproduced `no-session`, including two in the same directory.
The installed 0.160.0 protocol exposes loaded conversation IDs and their names and directories,
but no terminal PID mapping. Each terminal's OSC title exactly matched its loaded conversation's
name followed by ` | ` and the directory basename. The native launch and hook path still works.

## Decision

Keep the terminal as the sole input owner. When its hook identity is absent, infer a conversation
from an exact full title match in the same real directory among loaded root conversations.
Require a foreground Codex process and recheck it after discovery. Refuse duplicate matches,
partial inventories, unnamed conversations and unsupported responses. Strip the observed leading
status spinner, never match partial names or choose by recency. Read metadata without turns,
in batches of eight, capped at 100 loaded conversations.

Recompute recovery on every read. Do not persist inferred matches or cache the inventory, so a
conversation switch or a newly loaded duplicate cannot reuse a previous match. Prefer the live
match over a saved manual choice or an original `resume` argument. If discovery is unavailable,
preserve existing hook, argument and manual recovery paths.

## Consequences

The four reported terminals now expose separate histories without operator configuration.
This is an inference from a unique title and directory, not an authoritative PID-to-thread
contract. A stale terminal title could still identify a loaded conversation incorrectly.
An explicit title change or collision fails closed or selects the new unique match on the next
read. Older CLIs, altered title formats, duplicate names and inventories over the cap keep the
manual picker. No thread is started, resumed or sent input during discovery.

If Codex publishes a terminal-to-thread identity contract, replace this inference with it.
Native sessions without a daemon continue to depend on their existing hook or explicit ID.

## Verification

`bridge/codex-sessions.test.ts` and `bridge/conversation-service.test.ts` cover exact matches,
duplicate names, partial inventories, wrong directories, process replacement, live conversation
switches, daemon failure and preserved explicit/manual recovery. The real history endpoint
changed from `available:false, reason:no-session` to `available:true` on all four affected panes.
Headless browser checks at 390 and 1366 pixels confirmed that the reported pane displayed its
history and removed the manual connection form. Activation of the installed service is separate.
