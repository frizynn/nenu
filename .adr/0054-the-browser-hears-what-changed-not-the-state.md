# 0054. The browser hears what changed, never the state

Status: Accepted

## Context

The browser learned about every change by polling: the herd at 1.5 s or 4 s, a pane's queue at
3 s, an idle transcript at 12 s. The bridge already knew sooner. Herdr's event stream pokes the
engine within tens of milliseconds, and the message queue is written in the bridge itself. Measured
on a fake Herdr with the real routes, a status flip reached the page in 2.0 s at the median and up to
3.5 s; a queued message was on screen as sent about 2.9 s after the POST although delivery took
under 0.8 s.

Two roads were open. Pushing state (a WebSocket carrying snapshots or pane text) would make the
browser a second consumer of the engine with its own resync, backpressure and session lifecycle,
and would bypass the HTTP routes where the access, device and caching rules live. Pushing only the
name of what changed keeps every read on those routes.

## Decision

The bridge serves one same-origin Server-Sent Events stream per session at `/api/events`, gated like
any read. Each frame names a topic (`snapshot`, `pane`, `queue`, `journal`) and at most a pane id;
it carries no content. The page re-reads that one thing through the usual API.

Polling stays. While the stream is open it is a fallback (10 s for the herd, 10 s for a queue, 4 s
for a mirror the conversation view hides); while it is closed every reader runs at its previous
cadence. A reconnect emits `resync` so each reader refreshes once. A terminal mirror on screen keeps
its fast poll, because Herdr announces no output changes.

## Consequences

A lost frame costs one fallback interval, never correctness, as with the event poker. Hidden pages
and the idle cover close the stream, which also bounds the long-lived connections one browser holds.
A client that stops reading is closed after a bounded backlog and recovers through `resync`.

Do not put state or pane text on this stream, and do not remove the fallback poll. Revisit if Herdr
gains an output event, which would let the mirror's poll relax too.
