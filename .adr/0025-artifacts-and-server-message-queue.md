# 0025. Artifacts and a server-owned message queue

Status: Accepted

## Context

Media and edited files were only discoverable through transcript links, and the phone could not stage follow-up messages. Sleeping mobile clients leave in-flight requests stranded. Herdr snapshot failures also remained visible until the relaxed poll interval.

## Decision

Extend the existing file preview and transcript renderer. A per-directory project browser uses the same realpath, private-file and regular-file checks as previews. Artifacts derive from explicit file-writing tool activity and HTML references; project contents are separately labeled, never attributed to the agent just because they exist. Videos are validated and served with bounded-buffer range streaming. Images and videos appear inline and retain explicit full preview actions.

HTML render requests use a dedicated authenticated GET endpoint. Its own response CSP grants inline scripts/styles but no network, and enforces sandbox allow-scripts even if navigated directly. The iframe also carries that sandbox token without allow-same-origin. Unlike srcdoc, a network document does not inherit the application's script-src self restriction. Raw file downloads remain inert; SVG remains source-only. External dependencies stay blocked.

Keep queued messages in a private, atomically replaced bridge file, keyed by Herdr session, pane and native conversation identity. Enqueue IDs deduplicate retries. Sending is persisted before side effects; a restart pauses an interrupted delivery. A queue worker uses the same guarded reply implementation as the browser through an injected transport. Every write rechecks identity and the native composer; a dialog or host draft pauses delivery. It never clears a host draft or answers an approval. Automatic sends wait for an idle/done agent, and subsequent messages wait for the previous turn to start. Explicit Send now selects that item even if earlier entries are paused. Uncertain outcomes require inspection before retry, never automatic replay.

The browser owns editing and display, not delivery. Closing it does not stop the worker. Pending queues survive restart, but native conversations must still exist and match. The worker does not resume or create an agent. A pause or unobserved native lifecycle can require an explicit Send now.

On foreground return, supersede a request stranded while hidden immediately. Failed Herdr snapshot polls retry with a bounded 1–5 second backoff without falsely claiming the connection is healthy.

## Validation and limits

Use fixture files and a disposable native session for video playback/seeking, interactive HTML, queue delivery while the browser is closed, parent identity and draft protection. Private paths and symlink escapes remain denied. Files outside the project are unavailable except the existing verified upload-preview exception. Queues accept text including existing attachment references, not binary uploads. Physical-phone acceptance is separate from mobile headless verification.
