# 0061. Nenu reads Organizations through its `--json` contract

- **Status:** Accepted (2026-10-10), shipped in 0.54.0. It depends on the `--json` contract landing in
  Organizations (package O1); until then the file fallback below is the only reader.
- **Trail:** `bridge/projects.ts` · `bridge/org-cli.ts` · `bridge/routes/org.ts` ·
  Organizations `docs/json.md`

## Context

Nenu shows Herdr Organizations' projects, threads and PRs. It writes through the
`herdr-organizations` CLI (`bridge/org-cli.ts`), but it reads by parsing Organizations' private
files: each project's `t-NNNN.toml` thread records and `.state/*.json`, with a small TOML parser of
its own (`bridge/projects.ts`). Those files are Organizations' storage, not an interface. A renamed
key or a new layout breaks Nenu silently, and Nenu would have to replicate logic Organizations
already has (the inbox grouping and its rank, `report_unacked`).

The redesign asks for more: PR state, review, check counts and diff size for a "Ready to review"
list and a PR bar. Organizations' thread record already stores `pr`, `pr_state`, `pr_review`,
`last_group`, `parent_id` and `role` (measured, `organizations/src/thread.rs:66`), but not check
counts or the diff (measured, `pr.rs:219-235`). Today only `thread start`, `thread adopt` and
`node start` print JSON; `thread list` prints tab-separated text (measured, `cli.rs`, `threads.rs`).

Reading more fields from the files would deepen the coupling at exactly the point it is growing.
Reading `.state/ticker.json` for live PR data was also on the table and is worse: it is a cache of
the ticker's own loop.

## Decision

1. **Read through a versioned `--json` contract.** Nenu uses `--json` output (with a
   `schema_version`) from `project list`, `node list`, `thread list`, `overview`, `inbox list` and
   `project new`, including PR state, review, check counts and diff size. Results are cached and
   invalidated by `stat` or `fs.watch` on the project directory, announced as an `org` topic on the
   event stream ([ADR 0054](./0054-the-browser-hears-what-changed-not-the-state.md)).
2. **The files are a fallback, not a source of new fields.** When the installed Organizations has no
   `--json`, Nenu keeps reading the TOML records it reads today and shows no numbers it cannot get
   from them. It never invents a count.
3. **`ticker.json` and the TOML layout are not a contract.** Nenu does not read the ticker's state.
4. **Writes stay CLI commands, and Nenu never merges on its own.** PR actions (Merge, Auto-fix CI and
   address comments, Auto-merge when ready) are Organizations commands Nenu invokes on the person's
   tap. Merge is offered only with green checks and an approving review. Automatic merging happens
   only after the person turns it on for that thread.

## Consequences

A change in Organizations' storage no longer breaks Nenu, and the logic for grouping and ranking
lives in one place. The cost is a process spawn per uncached read; it has not been measured, and the
cache exists to keep it off the hot path.

Nenu now depends on an Organizations version with `--json` for the richer views, and the fallback
path shows less. Both repos must keep `schema_version` honest: a breaking change bumps it, and Nenu
treats an unknown major version like a missing contract.

Revisit if Organizations publishes PR and check summaries somewhere Herdr exposes (for example pane
tokens), which would remove the spawn.
