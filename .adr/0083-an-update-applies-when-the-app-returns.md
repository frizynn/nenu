# 0083. An update applies when the app returns, and waits in a notice only for unsent work

- **Status:** Accepted (2026-10-15). Amends ADR 0026 (an open chat holds automatic reloads) and ADR
  0027 (no update notice outside Settings).
- **Trail:** `web/src/lib/reload-guard.ts` · `web/src/lib/self-update.ts` · `web/src/lib/pwa.ts` ·
  `web/src/lib/local-sends.ts` · `web/src/components/update-banner.tsx`

## Context

An installed iPhone app ran a frontend at least two releases old. The bridge had served the newer
build for two hours, and the newest one for 17 minutes, when the app mounted (its push subscription
was rewritten then, with an iPhone user agent) and drew a screen only the old code can draw. A load
answered from the old worker's precache, and nothing replaced it. Measured from the served build's
files and the subscription write; what the phone's worker did is not observable without the device.

On a WebKit bench with a real service worker and two builds swapped under the bridge (two runs
each), the current code:

- in a chat, after the app is hidden and shown: never takes the new build (0 of 2 within 90 s). An
  open chat holds every automatic reload (ADR 0026), and its operator lives in chats.
- with a draft: the same, and nothing on screen says an update waits (ADR 0027 keeps it to Settings).
- after a failed first download: takes it 58.5 s later, only through the once-a-minute worker check.
  Each build gets one automatic attempt per page session, marked before it runs.
- on Home: 18.6 s.

An iOS home-screen app is frozen in the background and resumes without a load. A resume is not a
navigation, so WebKit runs no update check of its own then, timers stop while frozen, and
`visibilitychange` may only fire on resume, sometimes twice (WebKit source; bugs 199110 and 207256).
Not measured on a device.

ADR 0026's reason for the chat hold stands: a reload must not interrupt someone reading or lose
what they typed. ADR 0027's reasons for removing the notice stand too: the old one navigated before
the new build was ready, floated over the page, and closing it was local to one page.

## Decision

Split the reasons a reload waits. Unsent work (a draft, an upload, a message on its way or failed
with its text only on its bubble, a form) is never reloaded over automatically. An open view (a chat,
a preview) holds only while someone may be reading: for 15 s after the app returns to the
foreground, views stop holding and a waiting update applies.

On each return (any `visibilitychange` that ends visible, counted once per 2 s, or a page restored
from the back-forward cache), read `build-info.json` once, uncached. No new polling. Automatic
attempts are retried, at most three per build in ten minutes, 15 s apart unless the app returns in
between; the count survives a reload so a page that comes back stale cannot loop.

Applying on its own comes first. Only when unsent work holds a confirmed update, or its automatic
attempts are spent, show one row in the flow above the page, like the connection notice: "New
version of Nenu" and Update. Not over the conversation and not in a chat with nothing unsent, where
the next return applies it. It runs the same shared attempt as Settings, which waits for the new
worker before navigating and keeps the page on failure. It has no dismiss: it leaves when the
update applies or the work is sent. No spinner or continuous animation. This is what changes from
ADR 0027: an update now speaks outside Settings, in that one case.

## Consequences

A page in a chat can reload within seconds of the app coming back, which loses its scroll position
and lands on the same chat. That is the cost of taking updates in a chat at all. A draft survives
through its own store; a failed bubble holds the update, and tapping the notice drops it like
Settings' Reload interface always has.

If a return turns out to come while the operator is mid-read (a desk window switching tabs), shorten
the grace or limit it to installed apps. Whether iOS fires `visibilitychange` on every resume is
supposed from WebKit's source, not measured on an iPhone.
