# 0098. Uploads live beside the state, under Nenu's name

- **Status:** Accepted (2026-10-18). Amends [ADR 0068](./0068-the-plugin-is-herdr-nenu-and-internal-names-stay.md),
  point 3, for uploads only, and the location in [ADR 0074](./0074-an-attached-file-is-saved-for-the-agent-and-never-served.md).
- **Trail:** `bridge/uploads.ts` (`uploadDirs`, `nenuDirs`, `sweepUploadDirs`) · `bridge/config.ts`
  (`defaultStateDir`) · `bridge/chat-upload-preview.ts` · `bridge/pane-files.ts` (`insideNenuDirs`) ·
  `bridge/file-open.ts` · `bridge/project-files.ts`

## Context

ADR 0068 kept the state directory's name, `~/.local/state/collie`, because nobody types it. An upload
is the exception: its path is the message. An operator attaching a photo from the phone hands the
agent `~/.local/state/collie/uploads/<name>`, reads it in the chat, and asked why it still says
Collie.

Moving the whole state directory is still wrong for the reasons ADR 0068 gives: it holds queues,
push subscriptions and the assets open clients load (ADR 0026). Uploads are different. Each one is
read once by path and swept after 48 hours, so nothing carries over except the files already
waiting.

## Decision

1. **With the default state directory, new uploads go to `~/.local/state/nenu/uploads`**, a sibling
   of `~/.local/state/collie`, created 0700 like before. A state directory the operator chose
   (`COLLIE_STATE_DIR`, `HERDR_PLUGIN_STATE_DIR`) keeps its uploads inside it: that path is theirs
   and does not say Collie unless they named it so.
2. **The old folder keeps working until it empties.** `<state>/uploads` is still accepted by the
   chat's image preview and still swept, so a photo sent before the update previews until it
   expires.
3. **The new folder is Nenu's own, like the state directory.** `/file`, Render, the file tree,
   artifact inspection and Open refuse it exactly as they refuse the state directory (ADR 0063,
   ADR 0074), through one list, `nenuDirs`.

## Consequences

- The rest of the state directory, the `COLLIE_*` settings and `collie-ctl.sh` keep their names;
  ADR 0068 still holds for them.
- `uninstall` removes neither folder, as it never removed the state directory.
- `<state>/uploads` stays accepted for good, not only through the migration: a state directory the
  operator chose still writes there.
