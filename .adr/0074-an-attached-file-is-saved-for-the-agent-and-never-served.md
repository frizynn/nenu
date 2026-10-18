# 0074. An attached file is saved for the agent and never served

- **Status:** Accepted (2026-10-14). The operator chose any file type and 25 MB per file.
- **Amends:** the upload half of [ADR 0059](./0059-agent-images-svg-and-html-assets-render-without-widening-file-access.md),
  which only knew uploaded images. The chat preview of an uploaded image does not change.
  Where uploads are saved is amended by [ADR 0098](./0098-uploads-live-beside-the-state-under-nenus-name.md).
- **Trail:** `bridge/uploads.ts` (`saveUpload`) · `bridge/routes/files.ts` (`upload`) ·
  `bridge/pane-files.ts` (`nenuDirs`) · `web/src/hooks/use-composer-attachments.ts` ·
  `web/src/components/file-drop.tsx`

## Context

The composer only attached images. The bridge sniffed the first bytes, refused anything that was not
PNG, JPEG, GIF or WebP, and capped a file at 10 MB, so a PDF, an archive or a source file could only
reach the agent by being somewhere the agent could already read. The agent CLIs open any file by its
path, which is all an attachment is on the wire (`serializeMessage`).

Taking any type changes what sits in `<state>/uploads`: HTML, SVG, scripts, archives. Nenu already
runs HTML in a sandbox (ADR 0021) and serves files under a pane's folder. A pane opened in the home
folder holds the state directory, so before this decision `/file` and Render served an upload back
from there (`pane-files.test.ts`, "never serves Nenu's own state").

## Decision

1. **Any file goes, up to 25 MB.** The bridge reads the declared length before buffering and the
   size after, and the composer refuses a bigger file before it uploads, naming it. A message holds
   at most ten files. The bytes are never interpreted past the image sniff.
2. **The name is Nenu's.** Every upload is `<pane>-<time>-<random>`: an image adds the extension its
   bytes prove, anything else adds a flat copy of its name (last segment only, accents folded,
   `[A-Za-z0-9._-]`, no dot runs, 64 characters) so the agent can still tell a `.pdf` from a `.zip`.
   No client path, `..` segment or device name can become the file name. A non-image named like an
   image ends in `.bin`, because Claude attaches any path with an image extension as an image.
3. **An upload is never served or run by Nenu.** Only an image keeps its chat preview, through the
   journal-proved route of ADR 0059, which sniffs again. Nothing in the state directory or the
   uploads folder (ADR 0098) is served by `/file` or Render, even from a pane folder that holds it,
   and ADR 0063's Open already refuses it.
4. **The 48 h sweep and the 0700 directory stay as they were.**

## Consequences

- A PDF or an archive attached from the phone shows as a chip with its name, kind and size, never
  as a preview. Previewing one would mean serving it from the state directory; reopen that as its
  own decision, never by widening `/file` or the upload preview.
- A file is in memory once on the bridge while `formData()` parses it, so the cap is also the
  bridge's memory bound per upload. Raising it should come with streaming the body to disk.
- The agent sees a generated name with the original after it. A tool that needs the exact original
  name gets it from the operator's message, not from the path.
