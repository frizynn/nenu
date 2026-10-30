# 0135. Each herdr-core machine is its own session, and its files come through hc

- **Status:** Accepted (2026-10-30). Does not replace [ADR 0084](./0084-machines-are-herdrs-reached-through-their-own-nenu.md),
  which still holds for Herdr's saved machines.
- **Trail:** `bridge/hc-client.ts` · `bridge/hc-journal.ts` · `bridge/hc-core.ts` · `bridge/sessions.ts` (`setExtras`) ·
  `bridge/routes/snapshot.ts` (`hcMachineViews`) · `bridge/queue-delivery.ts` (`deliverWhole`) · `bridge/index.ts`

## Context

`hc ls` answers with every machine's terminals (`rise-l/t7`), so Nenu's one `hc` session mixed them:
the operator could not tell a Mac chat from a server chat and kept a second Nenu on the server. Three
things were wrong behind that, measured against a real Mac and `rise-l`:

- A server chat answered `{"available":false,"reason":"no-log"}`: the journal reads local files.
- ADR 0084 reaches another machine through its own Nenu. hc already has a connection to that machine,
  and the point of the request is to retire the second Nenu, so nothing would answer there.
- A queued message always failed with "Your message didn't show in the agent's input box". hc types
  nothing until Enter, and the queue went through the guarded send, which waits to see the text. Six of
  six queued rows failed and six of six direct sends went, short, wrapped and multi-line alike. It
  read as random, or as a picture problem, because the composer queues only while the agent reads as
  working.

## Decision

- **One session per machine:** `hc` for this one, `hc@<machine>` for each machine hc lists, re-read with
  the other sessions. A machine out of reach keeps its session, unreachable. `hc@` keeps every name
  free of shell quoting and never starts with `@`, which is ADR 0084's forwarded machine.
- **A page on one lists the others** through the snapshot's `machines`, the lists ADR 0084 already draws
  in Home, the bar and Search, so nobody must switch session to see a server chat. Only a session's own
  Workspaces list its workspaces.
- **Another machine's Claude log is copied here** under `<stateDir>/hc-journals/projects`, one more
  journal root, while someone reads it: at most the newest 32 MB, new bytes every 2 s for a minute after
  the last read, gone after five quiet minutes and at every start. Adapters, containment and the file
  watch stay as they are. Don't teach the adapters a remote file system.
- **hc delivers queued rows whole:** text and Enter as one write. Never route hc through the guarded
  send's "see it in the box" step.
- **An upload named in a message to another machine travels first** with `hc put`, and the message
  names where it landed. Only a regular file directly in an uploads folder travels; any other path is
  the sender's words. A file that cannot travel stops the send with nothing typed.

## Consequences

- Moved panes change session once: a link, a queued row, a read mark or a notification switch saved
  under `hc` for a server pane does not follow it. An old link shows the pane as gone.
- Conversations live on this disk while read (0600 under a 0700 folder, in the state directory `/file`
  refuses). A log past 32 MB shows its newest part. Subagents' logs and a conversation rotated into a
  sibling file are not copied, and only Claude has a remote conversation id.
- hc has no "paste without Enter", so a picture inside a message arrives as a path the agent reads with
  its Read tool (ADR 0104's token does not apply). An agent denied Read cannot see it.
- Changes, Files and previews still read this machine's disk, so a server pane whose folder also exists
  here shows this machine's. Revisit with a read through `hc exec` or a refusal for remote panes.
