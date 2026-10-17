# 0096. A question carries its context

- **Status:** Accepted (2026-10-17). Requested by the operator. Amends
  [ADR 0088](./0088-a-projects-library-is-read-through-one-contained-route.md) points 1 and its "do not
  widen" (the library's root, and a thread's report), and
  [ADR 0091](./0091-your-asks-and-a-coordinators-card-come-from-organizations-fields.md) point 1 (rows
  fold into one question).
- **Trail:** `bridge/projects.ts` (`recordsFolder`, `library`, `report`) · `bridge/org-library.ts`
  (`reportResponse`) · `bridge/routes/org.ts` · `web/src/lib/asks.ts` (`foldRelated`, `unclosed`,
  `reportBody`) · `web/src/components/ask-list.tsx` · `web/src/components/ask-context.tsx` · `web/src/components/thread-report.tsx` ·
  `scripts/e2e/asks-context.ts` · Organizations `docs/json.md` (Thread `report`, `library`; Project
  detail `records`; Asks `mismatch`)

## Context

On 2026-10-17 the operator, at a desk, with four screenshots: "no tengo el contexto suficiente … y
después no cargan las imágenes … y no entiendo por qué no se cierra en Does not close". Measured:

- Every capture of `awam-org` answered 404. Organizations keeps a project's reports, library and status
  files in its records folder (the `records` setting), here an Obsidian folder outside the projects
  root; the bridge looked under `<projects root>/<slug>/library`. `overview --json` gives each thread's
  `library` (`<records>/library/<id>`) and `report`, but not the project's `records`.
- A question in Your asks was one line. The report that explains it (the question, what was measured,
  a table of options, links, what to decide) sat in the thread's report, which Nenu showed only as its
  three-line Summary.
- coord-ia listed one ask and two decisions about task AWA-674 as three loose rows. The decisions
  link only pages; their text opens with the task id the ask links.
- "Does not close" printed `done · a linked task is still to do`, Organizations' fixed reason, without
  saying which task or what to do.

## Decision

1. **The records folder comes from Organizations.** A project's `records` when `overview --json`
   prints one, else the folder above its threads' `library` (`<records>/library/<id>`), else the
   project's own folder (an Organizations that predates both). The library route keeps every rule of
   ADR 0088, rooted at `<records>/library`.
2. **A thread's report is served by its id.** `GET /api/org/report?project=&thread=` reads the path
   Organizations gave, only when it is a regular Markdown file, not a link, whose real path is inside
   the real records folder, under the pane preview's reader (private paths, Nenu's state directory,
   size cap). The client never names a path. Anything else is the same 404. Read when a question's
   context opens, never on a poll and never in the snapshot.
3. **A question opens its context in place.** The report of the first thread its links (or its parts'
   links) name, drawn as written through `MarkdownText` (tables, lists, links), without its `Status:`
   line and its `## Captures` list, which the gallery shows; Answer at its foot. With no thread behind
   it, what each link points at. In place, not a side panel: it reads the same on a phone and a desk,
   and Answer stays next to what it answers. The thread's own page, where "Report of" leads, opens the
   same report under its summary ("Full report"), read only when opened.
4. **Rows about the same thing read as one question.** Within a group (never "Does not close", where
   each row has its own reason and its own ask of the coordinator) and one coordinator, a row joins
   an earlier one when their links name the same thread or task, or when it links no thread or task and
   its text opens with the id of a task that row links. The earlier row heads; each part keeps its line
   and its own Answer, since `asks answer` takes one line. Nothing joins across coordinators or groups,
   and a task id counts only when Organizations confirmed it as a link.
5. **A row that does not close says what is open and where**, from Organizations' reason and the link
   it names (`Marked done, but task ACM-9 is still to do.`, with the task's title), never a state Nenu
   made up. Its remedy is the coordinator, who wrote the line: "Ask the coordinator" sends one sentence
   through the guarded send, after a confirm, only where its pane is live and the device may write. The
   sentence names the line, the state and the link's id, never the ask's words (ADR 0091 point 3).

## Consequences

Any Markdown report in a project's records folder is readable by a device that passes the read gate,
as its captures already were. A records folder under a private path serves nothing. A coordinator that
writes a decision opening with a task id it never linked keeps it as its own row. Organizations' task
links carry no address, so a task cannot be opened from here.

Do not let the client name a report's path, serve a report that is a link, or fold rows by matching
free text against anything Organizations did not confirm. Revisit point 1 when `overview --json` prints
`records`, and point 4 if Organizations groups a decision with its ask itself.
