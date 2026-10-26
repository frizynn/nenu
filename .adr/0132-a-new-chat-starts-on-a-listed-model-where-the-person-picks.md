# 0132. A new chat starts on a listed model, in the place the person picks

- **Status:** Accepted (2026-10-27). Extends [ADR 0131](./0131-a-desks-home-starts-a-chat-and-lays-the-herd-out-by-state.md)'s
  Start and the New flow. Requested by the operator over Nenu 2.9.0's Start, whose agent menu held
  only "Claude Code" and "Codex": "aca debe ser el buscador de modelos y debes poder elegir ya sea una
  nueva sesion tipo asi nomas efimera, un nuevo workspace, seleccionar un workspace, seleccionar un
  tab, para poder ya sea crear un chat en un workspace, en un tab o en un pane, o algo de cero".
- **Trail:** `bridge/agent-start.ts` (`CLAUDE_MODELS`, `CODEX_DOC_MODELS`, `launchAgent`) ·
  `bridge/models.ts` (`startCatalog`) · `bridge/tab-split.ts` · `bridge/routes/structure.ts`
  (`/api/start/models`, `/api/tab/<id>/split`) · `web/src/lib/start-destination.ts` ·
  `web/src/components/start-pickers.tsx`

## Context

- Herdr's `agent.start` types the command into the pane's shell. It quotes each argument (measured
  on Herdr 0.9.5: `["--model", "opus[1m]"]` arrived as `claude --model 'opus[1m]'`), but what it
  types still runs in a real shell the bridge treats as remote shell access.
- Claude Code takes an alias or a full model name for `--model`; its model configuration page lists
  the aliases (`default` is a reset keyword, not a model). Codex takes a slug, its list changes
  every few weeks, and Codex keeps its own current list in `models_cache.json`.
- Herdr has no throwaway session a client can make and forget: a workspace, tab or pane lives until
  closed. Nenu's New flow already had a "Quick question" that opens a tab of a `scratch` workspace on
  the home folder.
- `pane.split` names the pane it splits `target_pane_id`; a field it does not know is ignored and
  the focused pane is split instead (measured on 0.9.5), and `pane.layout` reports a tab's panes
  with their sizes.

## Decision

1. **A model is a choice from the bridge's list, never text.** The bridge answers
   `/api/start/models` with each agent's default first, Claude Code's documented aliases, and the
   slugs the bridge user's Codex caches (the slugs on the Codex models page where it caches none);
   `/api/pane/<id>/start` checks the chosen id against that same answer and turns it into
   `--model <id>`. The default adds no flag, so the CLI's own configured model stays in charge.
2. **The composer's agent menu is the model menu**: one searchable list grouped by agent, and
   picking a model of the other agent switches the agent. The New flow's forms use the same menu.
3. **Where a chat opens is a choice of its own**, beside the folder under the box:
   - *By folder* (the default, ADR 0131's rule): a tab of the workspace already working in the
     folder, else a workspace of its own.
   - *Quick chat*: a tab of the `scratch` workspace on the home folder, made on the first one. This is
     what "ephemeral" means here: no folder to pick, and closing its tab is all the cleanup. Nothing
     closes it on its own.
   - *New workspace* on the folder, even where one already works there.
   - *A workspace* (a new tab in it) or *a tab* (a new pane beside its largest pane: to the right
     while that pane is at least twice as wide as tall in cells, else down), from searchable lists of
     the live ones. Picking one sets the folder to where its last-moved pane works; another folder
     can still be picked after.
   A destination closed since it was picked opens by folder. The New flow offers the same places
   through its own steps: Quick question, In a new folder, and Here in a workspace with *Opens in* a
   new tab or beside one of its tabs.

## Consequences

- `CLAUDE_MODELS` and `CODEX_DOC_MODELS` age with the CLIs: an alias Claude Code adds is missing
  until the table learns it, and a Codex slug retired upstream stays offered where Codex cached
  nothing. A model the list no longer offers starts on the default rather than failing.
- Reopens this: a free-text model field, a model passed through to the command line unchecked, or a
  "temporary" chat that closes itself (that needs a Herdr lifecycle Nenu does not own).
