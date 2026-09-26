# 0021 — HTML previews run in an opaque, no-network sandbox

Status: **Accepted** (2026-09-11)

## Context

Project files already cross a deliberate read boundary: the live pane supplies the workspace root,
`containedRealpath` checks the resolved target, private paths are refused, and text reads stop at
2 MB. HTML was served and displayed as source because executing agent-influenced markup in Nenu's
document would undo the application's principal XSS boundary and expose its same-origin API.

Design-board files are executable documents, however. Showing their source cannot validate the
artifact an agent actually produced, and disabling scripts makes interactive canvases materially
different from the file under review.

## Decision

**Keep the bridge response inert and execute HTML only in a sandboxed `srcdoc` iframe.** The iframe
grants `allow-scripts` and no other sandbox token. Without `allow-same-origin` it receives a unique
opaque origin, so it cannot inherit Nenu's cookies or storage. The absent permissions deny forms,
popups, top navigation and downloads.

Before assigning `srcdoc`, parse the source without executing it and prepend a CSP as the first head
node. The policy denies all resources by default and explicitly denies connections, forms, objects
and workers. It admits inline scripts and styles so a self-contained artifact can run, plus only
`data:`/`blob:` media and child-frame inputs needed by self-contained design canvases. It admits no
HTTP origin and no `'self'` source.

The user can always switch from **Render** to **Código**. SVG remains text-only: it does not need
script execution to satisfy this capability and historically has a much wider active-content surface.

## Consequences

- A preview can compute and render interactive local UI but cannot call Nenu, Herdr, the internet, or
  ambient browser storage. Sandbox and CSP are separate, test-pinned controls.
- A hostile document can still consume CPU in its own renderer process. Closing the preview destroys
  the iframe; browser-level process isolation remains the bound for compute abuse.
- External fonts, images, styles and scripts intentionally fail. A preview is offline by contract;
  the code view and fetch/render error surfaces remain available for diagnosis.
- The path, privacy, regular-file and byte limits stay wholly bridge-side and unchanged.

Revisit only if browsers provide a narrower capability than `allow-scripts` for self-contained
documents, or if a required canvas feature cannot work without widening a directive. Any widening
must preserve the opaque origin and must not admit network schemes or Nenu's origin.


## Superseded transport, 2026-09-26

The srcdoc transport is superseded by [ADR 0025](0025-artifacts-and-server-message-queue.md). A real browser demonstrated that the parent application CSP blocks inline scripts inherited by srcdoc. The replacement is a contained network document with its own response CSP and the same opaque sandbox and no-network policy.
