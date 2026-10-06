# 0055. The folder picker lists folder names under home, and nothing else

Status: Accepted

## Context

Starting a chat used to take a typed directory. On a phone that meant typing full paths, so the
new-chat sheet gained a folder browser. It needs the bridge to list directories, and it is the first
filesystem read not anchored to a live pane's cwd or a contained journal: before it, the client
could only name paths inside a pane's project or ones a harness reported delivering.

The obvious next asks are wider: browse from `/` (worktrees under `/private/tmp`, `/Volumes`,
`/srv`), show files so a folder can be recognised, or show dot-directories everywhere. Each turns a
picker into general host file discovery behind a route any read-level client can call.

## Decision

`GET /api/dirs` lists **directory names only** under the bridge user's home directory, gated at
write level (`bridge/home-dirs.ts`): only a device that can start a chat needs the names, so a
read-only viewer never learns the home tree.

- The requested path (`~`, `~/x`, relative to home, or absolute) is resolved with `realpath` and must
  stay inside the real home; `..`, absolute paths elsewhere and symlinks out of home are refused the
  same way as a missing folder.
- No files, sizes or timestamps. A symlinked entry is listed only if it resolves to a folder inside
  home.
- Dot-directories are hidden unless the filter asks for them, and the private names previews refuse
  (`.ssh`, `.config`, `.git`, …) are never listed or entered.
- A directory is read lazily and stops at 500 folders out of at most 5 000 entries scanned.

A path outside home can still be **typed** in the picker; it is sent to create unlisted, and Herdr
decides whether it exists.

## Consequences

Folders outside home are reachable only by typing them. If the operator really works outside home,
the fix is a configured extra root contained the same way, never dropping containment or listing
from `/`. Showing files would need its own decision: this route deliberately reveals less than the
project file browser does.
