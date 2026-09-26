# Native agent sessions and explicit history recovery

Status: accepted locally, 2026-09-26.

## Context

A recognized terminal is not a conversation identity. The installed shared Codex daemon can inherit a different Herdr pane's environment. On the reported session, Herdr recognized Codex but had no `agent_session`; the browser never requested history because it required `hasSession` first.

Codex 0.157.0 supports the shared app-server Unix WebSocket. Two real probes of `thread/start` followed by native `resume --remote unix:// <id>` failed with `no rollout found` before a first turn, including while the creating connection remained open. An empty protocol thread is therefore not a reliable native launch contract for this version.

Claude Code 2.1.283 offers `--session-id`, `agents --json` and native `attach`. The Agent SDK controls application-owned sessions. Its documented resume contract does not promise a second UI attached to an arbitrary running native process. Claude's official Remote Control synchronizes its own web/mobile clients with the terminal.

## Decision

Keep the native terminal as the sole owner of input, approvals and cancellation. New mobile launches use Herdr's atomic `agent.start`: Codex with `--no-daemon`, Claude with an explicit UUID. This preserves existing model selection, uploads, prompt guards and terminal access. It does not change sessions already running.

Request history whenever a supported agent is recognized. Resolve identities from hooks and explicit native arguments. For background Claude sessions, match the foreground PID or the exact `claude attach` target against the public session list; cache the list for five seconds. Never match by directory or recency.

For existing Codex sessions without a hook, let the operator choose history from the local app server or supply the exact session ID. Validate the directory and an unchanged foreground process before accepting the choice. Store bindings in Nenu, scoped to the Herdr session and pane. Each read checks the process fingerprint and the hook identity again. Persist only IDs and hashes in an atomic owner-only state file, capped at 200 bindings. A different process or changed hook invalidates the binding.

Herdr accepted a `pane.report_agent_session` call from a new source without exposing that identity in the active pane. This was verified in the real recovery flow. Nenu therefore owns its explicit recovery binding instead of relying on that call.

Prefer the existing bounded, contained journal reader and its mtime/ETag caches. If the Codex journal is absent, read structured history via the daemon without resuming, submitting a turn or subscribing to approvals. The WebSocket remains local. There is no second remote listener or agent engine.

## Consequences

- Phone and terminal operate the same native session. New Codex sessions use a native runtime per terminal, rather than the shared daemon.
- Recovery survives a browser reload and bridge restart. Explicit selection is required when the daemon exposes no trustworthy pane-to-thread mapping.
- If `/new` or `/resume` changes a conversation inside the same process and its hook fails, the process identity alone cannot detect that change. The operator must reconnect the correct history. This is a protocol limitation, not an automatically repaired case.
- Protocol reads are capped at 32 MiB. The fallback cache retains at most 16 threads for three seconds and never replays failed commands.
- Existing native send/approval parsing remains in use. This change fixes identity, launch and view recovery; it does not claim to eliminate every terminal grammar bug.
- Older Codex CLIs that lack `--no-daemon` must be updated or started manually. Existing journals remain readable without a daemon.

## Sources and evidence

- [Claude Remote Control](https://code.claude.com/docs/en/remote-control)
- [Claude Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
- Local `codex --help`, `codex app-server generate-json-schema`, `claude --help` and Herdr protocol 22.
- `bridge/conversation-service.test.ts`, `bridge/conversation-bindings.test.ts`, `bridge/codex-rpc.test.ts`.
- Real mobile-sized browser recovery and native replies recorded in the project task `WIP/nenu-sesiones-compartidas-20260926`.

## Local verification

The mobile browser flow passed at 390 × 844 for both agents: empty terminal, Start action, first reply, response in the conversation and round trip through the raw terminal. A separate shared-daemon Codex session reproduced the missing-hook failure on the installed 0.41.2 build and recovered through the new picker. A page reload preserved the connection. Claude identity resolution was also checked against a real native process with the hook reference omitted at the resolver boundary.

The first native Codex send exposed a separate 0.157 renderer change: a styled shortcuts row now follows the status line. Captured fixtures reproduce the refusal. The parser accepts only that exact styled hint and still rejects plain lookalikes and trailing dialogs.

Local checks: 823 bridge/script tests, ctl lifecycle sandbox, 4384 web tests with 30 existing todos, bridge/web typechecks, production build and real Codex/Claude journal probe. Cross-origin requests to both new write routes return 403. Physical-phone acceptance and activation of this build are separate from these checks.
