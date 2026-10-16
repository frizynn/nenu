# 0087. A file opens in a new tab on its own viewer page, never as its raw bytes

- **Status:** Accepted (2026-10-16).
- **Trail:** `web/src/lib/nav.ts` (`filePagePath`) · `web/src/components/file-link.tsx` ·
  `web/src/routes/file.tsx` · `web/src/components/file-preview.tsx` · `scripts/e2e/files.ts`

## Context

The operator asked to open any file the chat hands over in a new tab. Only an HTML page had a way
there (the sandboxed render URL); every other file opened only in the viewer over the chat, from a
button, so a long-press or a middle click did nothing.

The obvious road is a link to the raw bytes, `/api/pane/:id/file?path=`. It is the wrong page:

- The route answers every file with `Content-Security-Policy: default-src 'none'; sandbox`
  (ADR 0021, 0059). Chromium refuses to run its PDF viewer in a sandboxed document, so a PDF in a
  new tab on the operator's desk browser shows a blocked page (the reason ADR 0063 serves its
  single-use Open link without that header).
- HTML, SVG and Markdown come back as `text/plain`, so a new tab shows source where the viewer
  shows the document.
- Dropping the sandbox for a tab would widen the one header every file response shares.

Reads pass the gate as a top-level navigation: the gate needs an Origin only for writes, and the
device check applies to writes (`bridge/access.ts`). So a page of the app opened in a new tab can read
what the viewer reads.

## Decision

1. **A file has its own page**, `/pane/:paneId/file?path=` (`?s=` for another session): Nenu's viewer
   on the whole screen. It reads the file through the same routes as the viewer in a chat and adds no
   byte-serving route. A link inside a document opens on that page; Done goes to the pane's chat.
2. **Whatever opens a file is a real link to that page** (`FileLink`): a plain tap is caught and
   opens the viewer in place, and the browser keeps a long-press, a middle click and a modified click,
   which open the page in a new tab. The viewer offers the same in its header (More on a phone).
3. **The page is not a way around a refusal.** A file outside the folder still shows the refusal and
   its confirmed Open (ADR 0063), and a private file is refused there as anywhere.

## Consequences

- A new tab costs the app's own load before the file, unlike raw bytes.
- `bun scripts/e2e/run.ts files` follows every link, tab and list in WebKit and asks the bridge for
  what it must refuse. Run it after touching a file route or a control that opens a file.
- Don't link a file to `/api/pane/:id/file` for a tab, and don't relax that route's headers to make
  one render.
