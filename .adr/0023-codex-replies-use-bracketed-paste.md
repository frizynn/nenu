# 0023: Send Codex replies as bracketed paste

Status: accepted
Date: 2026-09-26

## Context

A real Codex 0.157.0 / Herdr 0.9.1 mobile test stranded a multiline Unicode
message after Nenu acknowledged typing and Enter. `pane.send_text` writes raw
bytes. Codex's paste-burst handling can still be assembling those bytes when
Enter arrives, so visible text alone does not establish that the paste has ended.
A separate 0.157 footer, `tab to queue message` below the persistent status,
also made the existing composer detector reject a healthy editor.

Clearing a previous draft had another race: an RPC acknowledgement did not mean
the TUI had rendered the empty editor. An old identical draft could satisfy the
verification for the replacement message.

## Decision

The Codex adapter requests bracketed paste for the guarded reply's typing step.
The bridge wraps the complete payload with the terminal paste delimiters and
rejects embedded escape sequences. Enter remains a separate, verified operation.
Raw terminal typing, shell commands and other adapters retain their existing
transport. Deduplication fingerprints include the paste mode.

After destructive draft clearing, require a live, recognizable, empty composer
before typing the replacement. A timeout or unavailable read preserves the phone
draft and stops the operation. Accept the exact, styled shortcuts/queue hints
below Codex's status row, while retaining the status and dialog checks.

## Consequences

Multiline messages reach Codex as one paste. This does not turn the terminal into
a semantic session API: native rendering and paste-placeholder verification are
still required. New providers must opt into framing only after a real TUI probe.
No duplicate submit, automatic dialog approval, chunked paste, or blind retry is
introduced. See `HERDR_API.md`, `web/src/lib/reply-action.ts` and the captured
`draft-queue-hint-v0157.txt` regression.
