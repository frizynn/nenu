# 0058. The bridge watches the panes a browser is looking at

- **Status:** Accepted (2026-10-10, coordinator default, reversible), shipped in 0.54.0.
- **Amends:** [ADR 0054](./0054-the-browser-hears-what-changed-not-the-state.md). The stream still
  names only what changed and the fallback poll stays. What changes is the clause "a terminal mirror
  on screen keeps its fast poll", and the hidden mirror's fallback goes from 4 s to 10 s.
- **Trail:** `bridge/pane-watcher.ts` · `bridge/journal-watch.ts` · `bridge/live-events.ts` ·
  `bridge/routes/events.ts` · `web/src/lib/revalidation.ts`

## Context

ADR 0054 left the open terminal mirror and a streaming transcript on fast polls from the phone,
because Herdr announced no output changes. That is still true on the running server: on Herdr 0.9.1
`pane.read` revision is 0, `events.wait pane_output_changed` is rejected, and the snapshot revision
does not move with output (measured). The cost lands on the phone's radio. The mirror polls every
1.5 s, the chat view with an agent working re-reads its transcript at the same rate, and every event
re-runs the snapshot and pane loaders; about 76 requests a minute per phone in chat with a working
agent (inferred, to be measured by F0).

The same poll is almost free on the bridge. `pane.read` visible ANSI costs 0.23 ms at the median and
about 7 KB (measured), and the bridge is next to the socket.

Two roads stay closed. Pushing the text over the stream would undo 0054's reasons (a second consumer
with its own resync and backpressure, reads that bypass the HTTP routes). Waiting for Herdr to ship
an output event means upgrading or restarting the server, which touches every live agent.

## Decision

**Move the fast poll from the phone to the bridge, for the panes someone is looking at, and keep
sending only names.**

1. A client declares interest on the stream it already holds (`/api/events?watch=<paneId>`). While
   at least one client watches a pane, the bridge reads it every 150 to 250 ms, hashes the visible
   text and publishes `{topic: 'pane', paneId}` only when the hash changes. An idle pane yields no
   frames. Nobody watching means no reads.
2. For panes whose history was requested in the last 60 s, the bridge watches the resolved journal
   file (`fs.watch`) and publishes `{topic: 'journal', paneId}`. The set is bounded, and a watch is
   re-armed when the resolved path changes.
3. With the stream healthy, the mirror and the transcript fall back to a 10 s poll, and so does a
   mirror the conversation view hides (was 4 s). With the stream closed every reader keeps its
   previous cadence.
4. New Herdr subscription types (`pane.updated`, `pane.output_matched`) are used only as pokes and
   only behind a protocol gate (22 or later), because one unknown type rejects the whole subscribe.

## Consequences

A change on screen should reach the page in about 0.2 s plus a round trip instead of up to 1.5 s,
and a phone in chat with a working agent should drop to 10 or fewer requests a minute (both
inferred; the targets are pinned against F0's baseline). The bridge pays a few reads a second per
watched pane.

The stream now carries per-connection interest, so the bridge holds a little state per client. It
is released when the client disconnects, which hidden pages and the idle cover already do.

`fs.watch` on macOS can coalesce or drop events, and the journal can rotate. That costs one fallback
interval, never correctness, which is why the poll stays.

Do not put pane text or state on the stream, and do not remove the fallback poll; 0054's rule holds.
Revisit the bridge watcher if the running Herdr gains a subscribable output event.
