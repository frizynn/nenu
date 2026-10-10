# 0060. Codex panes stay off the daemon

- **Status:** Rejected (2026-10-10, coordinator default, reversible). The proposal was to launch
  Codex daemon-backed. [ADR 0022](./0022-native-agent-sessions-and-explicit-history-recovery.md)'s
  `--no-daemon` launch stays in force.
- **Trail:** `bridge/agent-start.ts` · `bridge/codex-rpc.ts`

## Context

The Codex app-server, reached over the shared daemon socket Nenu already connects to, is a full live
session protocol: item and turn events, thread status flags (`waitingOnApproval`,
`waitingOnUserInput`), approvals and questions sent to every subscribed client, a server-owned queue,
steering and image input (measured in the official source at `rust-v0.162.1`). Using it would give
Codex structured delivery, queueing and approvals instead of typing into the terminal.

Nenu cannot see any of it for the panes it starts, because it launches Codex with `--no-daemon`
(`bridge/agent-start.ts:53`, measured). The research proposed reversing that.

## Decision

**Keep launching Codex with `--no-daemon`.** Use the daemon only to observe panes that already run
daemon-backed (notifications, paged history), never to answer or send.

The reasons in 0022 still hold. Shared daemon hooks can inherit another pane's environment, which is
how a pane was matched to the wrong conversation. A protocol thread created before its first turn
failed native `resume --remote` with `no rollout found` in two probes on 0.157.0, and nobody has
re-probed it on 0.162. Which client receives a server request when several are connected is
undocumented, so an RPC answer could race the terminal ([ADR 0057](./0057-the-bridge-reads-and-answers-dialogs-through-the-screen.md)).

## Consequences

Codex panes started by Nenu keep going through the screen for sending, queueing
([ADR 0056](./0056-queued-messages-follow-each-clis-native-queue.md)) and approvals, and their history
comes from the rollout JSONL.

Revisit with a probe on the installed Codex that shows a daemon-backed launch resumes reliably and
attributes hooks to the right pane, and a decision on who answers when the terminal and Nenu both
see an approval.
