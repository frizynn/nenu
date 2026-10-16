# 0086. The chat reads a message once, and offers only the files the bridge found

- **Status:** Accepted (2026-10-16). Replaces the "Not found" card of 7558d695.
- **Trail:** `web/src/lib/markdown.ts` (`parseInline`) · `web/src/lib/chat-files.ts` ·
  `web/src/lib/file-links.ts` · `web/src/components/artifact-card.tsx` (`useFoundFiles`) ·
  `web/src/components/chat-media.tsx`

## Context

The chat read every agent message twice. The Markdown parser drew it, and the file list ran its own
regexes over the raw text to find names to offer as cards. The two disagreed wherever a construct
holds something shaped like a path:

- `https://rise-l.taild6bfcf.ts.net:8443/resumen-del-dia.html` drew as plain text over a
  "resumen-del-dia.html · 8443/ · Not found" card: the colon before the port started a path.
- Fixed for a bare URL, the same card stayed under `[el resumen del día](https://…:8443/…)`: the
  regex that removed links only removed links to local files, and the scan then read the target.
- A fenced block's command drew cards; a path in bold drew none.
- Each fix was another regex over the raw text (strip links, then strip URLs, then scan). The path
  scan restarted at every comma, colon or equals sign, so a 100 KB CSV took 3 s (measured).

The card itself said "Not found" with strikethrough for a name the bridge could not find, so a
mention of something absent left a dead card in the conversation.

## Decision

1. **One grammar reads a message.** `parseInline` recognises, in one pass and in this order, code,
   emphasis, links and images, autolinks, any `scheme://` URL, math, quoted names and paths in plain
   words. A path in words stays text and records the file it names (`files` on the text span). The
   file list walks that parse tree. It never scans raw text, so a URL, a link's target and a fenced
   block are never also files.
2. **A card waits for the bridge.** A page card, an image or a video in the chat appears only once
   `files?inspect=` says the name leads to a file, and it opens the file the bridge found. A name
   with nothing behind it draws nothing; the text still says it.

## Consequences

- A file named before it is written gets no card in that message. The chat looks again when the
  message mounts again, and the final answer usually names it once it exists.
- Images named in prose wait one metadata request before drawing, and draw from where the bridge
  found them instead of 404ing on a name relative to another folder.
- A path the grammar misses (a new shape) is fixed in `parseInline`, where the renderer sees it too.
  Don't add a second scan over the raw text, and don't bring back a card for a missing file.
