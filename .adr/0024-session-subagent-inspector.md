# 0024. Read subagents within their parent session

Status: Accepted

## Context

Native Codex and Claude conversations can delegate work without creating a Herdr pane. Nenu's pane list cannot identify those children, and a tool-call row alone cannot prove that a child is still running. The parent composer must retain its native owner and draft.

## Decision

Expose read-only subagent list/history endpoints under the live parent pane. Resolve its native session identity on every request and reject child histories that are not in that parent's verified descendant list. Never infer lineage from a shared directory.

Codex uses the existing App Server client, experimental ancestor filtering and independent parent-chain validation. Reading a child never resumes it or starts a turn. When a native CLI owns another runtime, its explicit journal task-start/task-complete events supplement App Server status. Recent starts can confirm running; stale unfinished turns remain unknown. Latest-turn metadata is a fallback, with bounded reads and terminal-state caching.

Claude uses the exact session's nested `subagents` directory. Optional `SubagentStart` and `SubagentStop` hooks record only lifecycle metadata in Nenu's state directory; the installer preserves existing hooks and makes a backup. A recent file alone never means running. Missing or stale lifecycle evidence is shown as unknown. Parent launch results provide task/model metadata and nested lineage where available.

The inspector reuses the existing transcript renderer and popover. List reads are cached for three seconds on the bridge. The browser polls every three seconds while open, twelve while closed, and pauses while hidden. Child transcripts are fetched only when selected. Claude file reads are byte-capped, cached by stat, and append-only growth reads only new bytes. Lists and caches are bounded and report truncation.

## Consequences

No additional agent engine, duplicate agent process, terminal resizing or input ownership is needed. Separate native runtimes may expose history without live status. Historical Claude sessions without hooks can show their children but may have unknown status; new lifecycle observations improve that state without fabricating it.

Cross-session children, malformed IDs and symlinks are covered by focused tests. Native Claude lifecycle and both mobile and desktop layouts must also be checked in a running bridge before activation.

## Native Claude metadata correction (2026-09-26)

Claude also writes a contained `agent-<id>.meta.json` beside each transcript. Read its description/name and parentAgentId only after the matching child transcript passes session ownership checks. This keeps names and nested relationships available when the parent launch falls outside the bounded tail.

A final assistant `end_turn`, an explicit API error, or a native task-notification terminal status is lifecycle evidence even without hooks. A newer user/assistant turn or start invalidates the older completion; a stop hook does not overwrite a reported failure. File activity alone still never proves running. The UI counts confirmed active children separately from finished history and leaves unconfirmed states explicit. Model labels are display-only; native IDs remain unchanged for model selection and are visible in child details.
