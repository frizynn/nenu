# 0088. A project's library is read through one contained route

- **Status:** Superseded by [ADR 0123](./0123-nenu-draws-herdr-alone.md) (2026-10-24). Before that: Accepted (2026-10-16). Amended by [ADR 0096](./0096-a-question-carries-its-context.md):
  the library is rooted in the project's records folder, and a thread's report is served by its id. Depends on Organizations adding `captures` and `deliverables` to
  each thread in `overview --json`; until it does, nothing links to the route.
- **Trail:** `bridge/org-library.ts` · `bridge/routes/org.ts` · `bridge/projects.ts` (`library`,
  `summaries`) · Organizations `src/thread.rs` (`copy_home_local`)

## Context

A coordinator's Summary shows what each thread left behind: pictures with captions and documents
(HTML and PDF). Organizations copies them home into `<project>/library/<thread id>/` and
refuses to copy a library that is a symbolic link, or a link inside one (measured,
`copy_home_local` and its tests). Once a thread is resolved its worktree and pane are gone, so the
pane preview (`/file`, rooted at a live pane's folder) cannot serve them, and the confirmed Open
(ADR 0063) costs a write-level device and one tap per file, which a gallery of 24 pictures cannot ask.

Three roads were on the table: widen `/file` to the project's library, which needs a live pane that
resolved work does not have; mint Open links for the gallery, which skips the confirmation ADR 0063
says must never be skipped; or a route of its own, rooted at the library folder.

## Decision

1. **One route, rooted at the library.** `GET /api/org/library?project=<slug>&path=<absolute path>`
   serves a file only when the project is one the registry lists, `<projects root>/<slug>/library`
   is a folder and not a link, the file's real path is inside that folder's real path, and the name
   asked for and the real file share an extension from png, jpg, jpeg, webp, gif, html and pdf.
   Everything else is the same 404.
2. **Read-level, like `/file`.** A read-only device sees what the agents showed; a link opened in a
   new tab carries no Origin.
3. **The preview's readers serve the bytes.** Pictures and PDFs go through `paneFileResponse` (bytes
   must match the name, size caps, private paths, never the state directory). HTML goes through the
   preview's opaque, offline sandbox, with sibling assets inlined from the same folder. A PDF drops
   the sandbox header for the browser's own viewer, as in ADR 0063.
4. **The text and the paths are read on demand.** `/api/org/summary` returns each thread's summary,
   captures and deliverables from the last overview read; the snapshot carries only the verdict.

## Consequences

Any picture, HTML page or PDF in a project's library is readable by any device that passes the read
gate: the exposure the pane preview already has for the same files while they sit in a worktree.
A projects root under a private path part (inside `~/.config`, say) serves nothing, because the
private-path policy reads the real path.

Do not widen the route to other folders of the project (its threads, reports or `.state`), follow a
library that is a link, or serve a kind the browser could execute outside the sandbox. Revisit if
Organizations serves its library itself.
