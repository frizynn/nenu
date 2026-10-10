# 0059. Agent images, SVG and HTML assets render without widening file access

- **Status:** Accepted (2026-10-10), shipped in 0.54.0. SVG as an image and sibling-asset inlining were
  approved as coordinator defaults, reversible.
- **Amends:** [ADR 0021](./0021-html-previews-run-in-an-opaque-no-network-sandbox.md) (SVG is no
  longer source-only; a preview may carry its own sibling assets) and the artifacts half of
  [ADR 0025](./0025-artifacts-and-server-message-queue.md) (a byte-serving route for journal images,
  and validators on media responses). The opaque origin, the response CSP and the sandbox tokens do
  not change.
- **Trail:** `bridge/pane-files.ts` · `bridge/html-preview.ts` · `bridge/media-preview.ts` ·
  `bridge/routes/*` (journal-image) · `web/src/components/chat-media.tsx` ·
  `web/src/lib/html-preview.ts`

## Context

Three gaps sit on the artifact path that 0021 and 0025 drew.

The images an agent itself looks at never render. Claude's Read on a PNG and Codex's `view_image`
store base64 image blocks in the journal, and the adapters drop them (measured). Some of those images
are not files under the pane's cwd at all (pasted images, MCP screenshots), so the existing `/file`
route cannot serve them, and widening it to arbitrary paths would undo the containment every file
read depends on.

HTML previews that reference `./style.css` or `./app.js` always render broken, because the
no-network CSP blocks the fetch. And SVG is shown as source, a choice 0021 made because SVG as a
document has a wide active-content surface.

Media responses are also `no-store` with no validators, so every remount downloads the full bytes
again (measured).

While researching this, one claim in 0021 turned out to be stronger than the mechanism. The CSP
blocks subresources, but browsers never shipped `navigate-to`, so a previewed document can still
navigate its own frame to an external URL and leak its own contents and the fact it was opened
(inferred from the CSP specification, not reproduced). It cannot read Nenu's data: the origin is
opaque and Nenu's pages refuse framing.

## Decision

1. **Journal images are served by entry and index, never by path.**
   `GET /api/pane/:id/journal-image?entry=<id>&n=<i>` re-reads the pane's contained journal, finds the
   n-th image block of that entry and serves it with byte sniffing, a size cap and the same
   `default-src 'none'; sandbox` headers as other file responses. The client never names a path, and
   the route's reach is exactly the transcript's.
2. **SVG renders as an image.** It is shown through `<img>` from a blob typed `image/svg+xml`, where
   the browser runs no script and fetches nothing. The code view stays available. SVG is never
   rendered as a document.
3. **An HTML preview may carry its sibling assets.** The bridge may inline same-directory relative
   references (styles, scripts, images) into the preview document, each read through the same
   containment and privacy checks as `/file`, under a total byte budget. Anything else stays blocked.
   The sandbox and the response CSP are unchanged, so the document still makes no network request.
4. **Media gets validators.** File and image responses carry an ETag (size, mtime, inode) with
   `private, no-cache`, and answer `If-None-Match` with 304 only after the same containment checks.
   The HTML preview stays `no-store`, so the executed document always reflects the disk.
5. **The residual egress is documented, not denied.** A preview can navigate its own frame away.
   Nenu does not claim otherwise, and tearing the iframe down on a second load is an allowed
   hardening, not a requirement.

## Consequences

The chat can show what the agent looked at, design-board style artifacts render with their assets,
and repeated views cost a 304 instead of the full file.

There is one more byte-serving route. Its privacy scope equals the transcript's, but it is new
surface and must keep the sniffing, cap and sandbox headers the other routes have.

Inlining makes the preview a document the bridge assembled rather than the file on disk byte for
byte, so a bug in the inliner shows a different page from the one the agent wrote. The code view
still shows the file as it is.

Do not widen file access to make an image appear: no route that takes a path outside the pane's cwd
beyond the two existing exceptions (Claude SendUserFile results and Nenu's own uploads). Do not add
`allow-same-origin`, network schemes or `'self'` to the preview to make an asset load.
