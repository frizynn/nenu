# 0027. Keep intermittent connectivity and updates out of the conversation

Status: Accepted

## Context

The slow-success fix in 0.45.4 did not cover actual intermittent failures. Two
six-second failures produced connection, history and queue notices followed by
Connected flashes. A service-worker check delayed for 13 seconds caused the old
page to reload after eight seconds, before the update finished. Closing the
floating update notice was also local to that page instance.

## Decision

Remove the floating interface-update notice. Discover builds in the background,
retain open-session/draft guards and allow explicit updating from Settings.
Share one pending update attempt. Wait for worker activation before navigating;
a failed check or a one-minute deadline leaves the current page intact and enables
Retry. Do not clear a working offline cache because a download failed.

Retry short read failures quietly while retaining data. Keep the header static.
After 15 seconds without a live connection, show one neutral status and Retry,
without Reload. Dismiss it after five seconds of stable recovery, without a
Connected flash. Do not infer Herdr failure from a successful config probe.

A brief transport failure does not prevent an explicit send attempt. Existing
server preflights, draft retention and queue idempotency still apply; never
retry mutations automatically. Explicit Herdr unavailability, sustained outages
and access restrictions continue to block writes. Mutation errors remain visible
and are separate from background-refresh errors.

## Consequences

This refines the client behavior in ADR 0026 without changing its asset retention
or deployment rules. A network outage is still an outage: cached text may be old,
and a sustained loss is marked. Tests must include alternating failed/successful
reads and an actual controlled service worker, not only slow successful HTTP.
