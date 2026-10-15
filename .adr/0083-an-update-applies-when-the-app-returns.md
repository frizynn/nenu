# 0083. An update applies when the app returns, and waits in a notice only for unsent work

- **Status:** Accepted (2026-10-15). Amends ADR 0026 (an open chat holds automatic reloads) and ADR
  0027 (no update notice outside Settings).
- **Trail:** `web/src/lib/reload-guard.ts` · `web/src/lib/self-update.ts` · `web/src/lib/pwa.ts` ·
  `web/src/lib/local-sends.ts` · `web/src/components/update-banner.tsx`

## Context

An installed phone app kept running a frontend two releases old for over two hours while the bridge
served the new one. Its operator lives in a chat. Three things kept it there, each measured on a
WebKit bench with a real service worker and two builds swapped under the bridge:

- An open chat holds every automatic reload (ADR 0026), so a page that stays in chats never applies
  an update: 0 of 2 runs adopted the new build within 90 s of returning to a chat.
- Each build got one automatic attempt per page session, marked before it ran. A failed download
  left only the once-a-minute worker check, and only while the page was visible.
- Nothing outside Settings said an update was waiting, by design (ADR 0027).

An iOS home-screen app is frozen in the background and resumes without a load. A resume is not a
navigation, so WebKit runs no update check of its own then, and timers stop while frozen
(WebKit source and bug 199110; not measured on a device).

ADR 0026's reason for the chat hold stands: a reload must not interrupt someone reading or lose
what they typed. ADR 0027's reasons for removing the notice stand too: the old one navigated before
the new build was ready, and closing it was local to one page.

## Decision

Split the reasons a reload waits. Unsent work (a draft, an upload, a message on its way or failed
with its text only on its bubble, a form) is never reloaded over automatically. An open view (a chat,
a preview) holds only while someone may be reading: for 15 s after the app returns to the
foreground, views stop holding and a waiting update applies.

On each return (visibility back to visible, or a page restored from the back-forward cache), read
`build-info.json` once, uncached. No new polling. Automatic attempts are retried, at most three per
build in ten minutes, 15 s apart unless the app returns in between; the count survives a reload so a
page that comes back stale cannot loop.

While a confirmed update cannot apply on its own (unsent work or an open view holds it, or it
failed), show one row in the flow above the page, like the connection notice: "New version of
Nenu" and Update. It runs the same shared attempt as Settings, which waits for the new worker
before navigating and keeps the page on failure. It has no dismiss: it leaves when the update
applies. No spinner or continuous animation.

## Consequences

A page in a chat can reload within seconds of the app coming back, which loses its scroll position
and lands on the same chat. That is the cost of taking updates in a chat at all. A draft survives
through its own store; a failed bubble holds the update, and tapping the notice drops it like
Settings' Reload interface always has.

If a return turns out to come while the operator is mid-read (a desk window switching tabs), shorten
the grace or limit it to installed apps. Whether iOS fires `visibilitychange` on every resume is
supposed from WebKit's source, not measured on an iPhone.
