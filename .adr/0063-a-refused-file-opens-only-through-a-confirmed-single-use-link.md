# 0063. A refused file opens only through a confirmed, single-use link

- **Status:** Accepted (2026-10-10). Requested by the operator; a deliberate exception to the
  containment in ADR 0021 and 0059, not a widening of `/file`.
- **Amends:** [ADR 0021](./0021-html-previews-run-in-an-opaque-no-network-sandbox.md) and
  [ADR 0059](./0059-agent-images-svg-and-html-assets-render-without-widening-file-access.md), which
  allowed only two ways to read a file outside the pane's folder (SendUserFile results and Nenu's own
  uploads). The preview routes, their containment and their sandbox do not change.
- **Trail:** `bridge/file-open.ts` · `bridge/routes/files.ts` (`fileOpenRoutes`) ·
  `web/src/components/file-open-dialog.tsx` · `web/src/components/file-unavailable.tsx`

## Context

The preview refuses a file for three reasons: it is outside the agent's folder and was not
delivered with SendUserFile, it is past a preview size cap (2 MB for text and HTML, 20 MB for images
and PDFs), or its type has no viewer. The operator hit all three with real artifacts, for example a
6.2 MB `resultado-shopify.html` in an Obsidian vault outside any pane's folder. The panel then
offered only "Copy path", which is useless on a phone.

Widening `/file` or `/html-preview` to any path would make every agent-influenced link in the
transcript a read of the host, silently, inside the preview. The two existing exceptions were each
scoped to something Nenu or the agent's own tooling proved. Neither applies here. The operator
has to decide each time.

## Decision

1. **The operator confirms each file.** Wherever the preview refuses a file as outside, too large or
   of an unpreviewable type, an **Open** button asks "Open this file outside Nenu's preview?", naming
   the full path and its size. Nothing opens without that tap.
2. **A grant is a write.** `POST /api/files/grant {paneId?, path}` needs Nenu's own origin and a
   write-level device, the same as typing into a terminal. It accepts an absolute path, or one
   relative to the named pane's folder. It resolves the path and refuses private paths (the
   preview's own predicate, applied to the given and the resolved name), anything under Nenu's state
   directory, non-regular files and files over 64 MB. It answers with a link, not the bytes.
3. **The link is single-use, short-lived and bound.** It holds a random 128-bit token, lives in
   memory for two minutes, is spent by its first use whatever the outcome, and works only for the
   device that asked and the resolved path that was checked. Opening it repeats every check, so a
   file swapped or symlinked after the grant is refused. `GET /api/files/open` is read-level only
   because a new tab is a top-level navigation and carries no Origin. The token is the authority.
4. **What the browser can execute runs in the preview's sandbox.** HTML and SVG get the HTML
   preview's no-network CSP plus `sandbox allow-scripts` and `frame-ancestors 'none'`, so they run
   in an opaque origin with no network and no access to Nenu. Text is `text/plain`. Images and PDFs
   are served only when their bytes match their name. Anything else downloads as
   `application/octet-stream`. Every response is `no-store`, `nosniff` and `no-referrer`.
   Sibling assets are not inlined here: the page is the file as it is on disk.
5. **Every grant and open is audited** with its path, size and device, never its content.

## Consequences

The operator can open any non-private file on the host from the phone, one confirmed tap at a time.
The confirmation is the control, so it must stay specific (the full path and size) and must never be
skipped, remembered or batched.

The page opens outside Nenu, so the response CSP is the only boundary. A sandboxed document can
still navigate itself to an external URL and take its own contents along (the residual egress in
ADR 0059). PDFs are left without the sandbox header because it blocks the browser's PDF viewer. They
rely on that viewer's own isolation.

A link cannot be reused for Range requests, so a large video opened this way downloads instead of
streaming. Tokens live in memory, so a bridge restart only costs another tap.

Do not drop the confirmation, lengthen the lifetime, make a link reusable or serve granted HTML
without the sandbox to make something more convenient. Do not reuse the grant to widen `/file`:
the preview stays contained, and this stays the one confirmed way around it.
