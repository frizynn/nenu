# Herdr socket API — empirically verified (v0.9.1, protocol 22)

Probed live against a running Herdr server, most recently re-probed 2026-10-10 on 0.9.1 (protocol 22,
read-only calls only) and cross-checked against the 0.9.3 CLI's schema. Older sections keep the version
they were probed on. Earlier probes were cross-checked
against the bundled machine-readable schema — `herdr api schema [--json | --output PATH]`
(`schema_version 1`, covering requests, responses, errors, and events) is now the fastest way to
re-derive this contract without probing. These are the facts the bridge is built on; they confirm
the socket assumptions behind the design in [`ARCHITECTURE.md`](./ARCHITECTURE.md).

## Transport

- Unix domain socket at `$HERDR_SOCKET_PATH` (default `~/.config/herdr/herdr.sock`).
- **Newline-delimited JSON.** Request: `{"id": <string>, "method": <string>, "params": <object>}`.
  - `id` **must be a string** (integer → `invalid_request`).
- Response: `{"id", "result": {"type": "...", ...}}` or `{"id": "", "error": {"code", "message"}}`.
- **RPC is one-shot: the server closes the connection after a single response.** Send one
  request per connection. (Confirmed: a second request on the same connection never replies —
  the socket is already closed.)
- Malformed requests close the connection too, and the serde error message names the missing/
  wrong field — which is how this contract was reverse-engineered without side effects.
- **Exception:** `events.subscribe` keeps the connection open and streams events.
- **A request line is capped at 1 MiB.** Live-probed 2026-08-17 against herdr 0.7.5: a request of
  1 048 575 bytes (newline included) still gets a normal reply; 1 048 576 gets no reply at all —
  the server drops the connection or simply never answers. Nothing Nenu sends is near that, but
  it is the ceiling to design against, and a hang at that size is the server, not the client. (The
  client-side hazard at large sizes was Nenu's own: Bun's `socket.write()` accepts only what the
  socket has room for, and the unwritten tail must be resumed on `drain` — see
  [`bridge/write-drain.ts`](./bridge/write-drain.ts).)

## Methods the bridge uses (verified params)

| Method | Params | Returns (`result.type`) |
|---|---|---|
| `ping` | `{}` | `pong` → `{version, protocol, capabilities{…}}` |
| `session.snapshot` | `{}` | `session_snapshot` → `snapshot{version, protocol, workspaces[], tabs[], panes[], agents[], layouts[], focused_*}` |
| `pane.get` | `{pane_id}` | `pane_info` → `pane{…}` (one pane record) |
| `pane.wait_for_output` | `{pane_id, source, match:{type, value}, timeout_ms, lines?, strip_ansi?}` | `output_matched` → `{pane_id, matched_line, read{…}, revision}` |
| `workspace.list` | `{}` | `workspace_list` → `workspaces[]` |
| `pane.list` | `{}` | `pane_list` → `panes[]` |
| `pane.read` | `{pane_id, source, lines, format}` | `pane_read` → `read{text, truncated, revision}` |
| `pane.send_text` | `{pane_id, text}` | (ack) |
| `pane.send_keys` | `{pane_id, keys}` | (ack) |
| `agent.send` | `{target, text}` | (ack) — writes **literal** text, no Enter |

- `pane.read` `source` ∈ `visible | recent | recent_unwrapped | detection` — **snake_case on the
  wire**: `recent-unwrapped` gets `invalid_request: unknown variant` (live-probed 2026-08-03,
  herdr 0.7.5; the variant list above is quoted from that error). `detection`'s semantics are
  unverified. `format` ∈ `text | ansi`.
  - **`recent_unwrapped` is a no-op for Claude panes** (byte-identical to `recent` across working
    and idle panes, live-probed 2026-08-03): Claude Code runs on the alt screen, so the read is the
    visible grid, and its renderer hard-wraps prose at the pane width — there are no soft-wrapped
    rows for the unwrap to merge. It only differs on scrollback-accumulating panes (shells: one
    probe measured 199 → 188 lines with logical lines up to 222 cols re-joined).
  - **A `recent` text read can scroll the pane it reads.** Herdr's agent-automation docs state that
    for an idle, recognized agent at the bottom of its transcript, `recent` / `recent_unwrapped`
    reads "automatically use the agent's mouse-scroll interface" when `lines` asks for more than the
    visible screen, collecting overlapping pages and "returning the viewport to the bottom before
    completing the read". Claude runs on the alt screen, which has no host scrollback, so that is the
    only way those rows can be reached — and the operator watches their terminal scroll up and snap
    back, once per read. Live-probed 2026-08-10 (herdr 0.8.0), idle claude pane, `viewport_rows: 71`:

    | `source` | `lines` | `format` | elapsed | lines returned |
    |---|---|---|---|---|
    | `recent` | 70 | `text` | 0.00s | 71 |
    | `recent` | 71 | `text` | 0.00s | 72 |
    | `recent` | 72 | `text` | 0.85s | 73 |
    | `recent` | 400 | `text` | 13.8s | 401 |
    | `recent` | 200 | `ansi` | 0.00s | 71 |
    | `recent` | 600 | `ansi` | 0.00s | 71 |
    | `visible` | 600 | `ansi` | 0.00s | 71 |

    The threshold is exactly `lines > viewport_rows`; one row over is enough. **`format: "ansi"` was
    never observed to harvest** — that is an observation across the probes above, not a documented
    guarantee, so don't lean on it. `visible` is immune by construction: it *is* the rendered
    viewport, clamped to it however large `lines` is, so there is nothing above to collect. A
    background poll that reads panes on a timer must therefore use `visible`
    (`bridge/state-engine.ts`); anything asking for scrollback is asking to move the operator's
    screen, and should be a deliberate, user-initiated read.
  **`format: "text"` returns clean plain text (no ANSI escapes)** → safe to render, no XSS surface.
- `agent.send` writes literal text only; to submit a reply, follow with an Enter keypress
  (`pane.send_keys {keys: ["Enter"]}`) — submit-key name needs live confirmation per agent.
- Nenu's guarded Codex reply now explicitly frames the complete text as bracketed paste
  before calling `pane.send_text` (verified with Herdr 0.9.1 / Codex 0.157.0 on
  2026-09-26). `/reply` accepts `paste: true`; its default stays raw, including direct
  terminal typing. Embedded ESC/C1-CSI characters are refused in paste mode.
  See [ADR 0023](.adr/0023-codex-replies-use-bracketed-paste.md).
- **`pane.send_text` writes RAW bytes — no bracketed paste.** Live-probed 2026-07-27 (herdr 0.7.4) by
  sending into a pane running `/usr/bin/cat -v`, which renders control bytes visibly: the text came
  back bare, with no `^[[200~` / `^[[201~` framing. Two consequences worth keeping:
  - A PTY is an ordered byte stream, so a following `send_keys` **cannot** overtake the text. Any
    "the Enter arrived before the text" theory is dead on arrival — including blaming the settle
    delay between the two calls (`sendReplySteps`, `bridge/server.ts`). See #34, where that was the
    first and wrong hypothesis.
  - A `\n` inside `text` is delivered as a real newline keypress, not as pasted content. What the TUI
    does with it (submit vs. insert) is the harness's choice, not something the paste framing hides.
- **`pane.send_text` has no 1,024-byte cap. Live-probed 2026-08-28 on herdr 0.8.2.** A claim from a
  2026-08-26 herdr **0.8.0** Codex probe said one RPC kept only the first 1,024 bytes. It does not
  reproduce here. Method: a throwaway shell pane running `cat > file`, so the count is bytes that
  reached the PTY, not glyphs a TUI chose to render. One `pane.send_text` per trial, then `wc -c`:

  | Sent (bytes) | Arrived (bytes) | Payload |
  | --- | --- | --- |
  | 1023 / 1024 / 1025 / 2048 / 3000 | identical | ASCII, no newline |
  | 2000 / 8000 / 40000 | identical | ASCII with a `\n` every 40 bytes |
  | 2760 | identical | multi-byte UTF-8, no newline |

  Every RPC acked `{"type":"ok"}`. There is no `truncated` flag and no error on a long send, so a
  future cap would be silent — re-probe before trusting a new herdr with a large paste. Until one
  appears, **do not chunk a send.** Chunking is what [`.adr/0010`](./.adr/0010-long-sends-are-verified-via-the-paste-placeholder.md)
  rejects: `pane.send_text` carries no bracketed paste, so a chunk boundary landing on a lone `\n`
  submits a half-written message.
- **An ack means "herdr took the bytes", never "the TUI acted on them".** Both `send_text` and
  `send_keys` return before the target program has read, let alone rendered, anything. So a
  successful RPC pair is not evidence a reply was delivered — a focused TUI dialog can swallow the
  text and consume the Enter with both calls reporting success. Anything that needs delivery
  *confirmed* must read the pane back and look (`web/src/lib/reply-action.ts`).

> **Herdr answers no `OSC 10` / `OSC 11` background query, and relays SGR verbatim** (live-probed
> 2026-07-29 in a pane running a raw-mode `stty` probe: both queries returned nothing).
>
> Two things follow, and both matter to anything that renders pane output:
> - **A harness that asks what background it is on gets no answer and falls back to dark.** Codex
>   emits both queries at startup; with no reply its output is dark-authored (`#f6e2b7`, `#abdfa7` —
>   L=0.774 and 0.642, light values that only make sense on a dark ground). Nenu cannot answer
>   either: it reads a rendered buffer downstream of the PTY, so the negotiation happens between the
>   harness and herdr on a channel Nenu does not own.
> - **Herdr does not rewrite escape codes into its own theme.** `format:"ansi"` returns what the
>   program wrote — `\x1b[38;5;1m` stays a palette index, never a resolved RGB. So herdr's
>   `[theme]` setting governs how *herdr's own UI* paints a pane, not what a client receives, and the
>   same palette-index colour can legitimately differ between the desktop TUI and Nenu (which
>   applies its own 16-slot table). See [`.adr/0002`](./.adr/0002-invert-the-light-terminal-mirror.md).

## `session.snapshot` — one RPC, the whole herd (new in 0.7.2)

`session.snapshot` `{}` → `{"type":"session_snapshot","snapshot":{...}}`. One-shot like every RPC —
no special connection handling, no streaming. The `snapshot` bundles everything a client needs to
bootstrap or resync in a single round trip:

```jsonc
{ "version":"0.7.2", "protocol":16,
  "workspaces":[ /* same record shape as workspace.list → workspaces[] */ ],
  "tabs":      [ /* same record shape as tab.list → tabs[] */ ],
  "panes":     [ /* same record shape as pane.list → panes[] */ ],
  "agents":    [ /* precomputed subset of panes[] that carry an agent */ ],
  "layouts":   [ /* per-tab PaneLayoutSnapshot, see layout.updated below */ ],
  "focused_workspace_id":"w0…", "focused_tab_id":"w0…:t1", "focused_pane_id":"w0…:p1" }
  // focused_* are string | null
```

Docs-blessed pattern: **bootstrap with `session.snapshot` → `events.subscribe` → re-`session.snapshot`
on reconnect or staleness.** CLI mirror: `herdr api snapshot` prints the raw reply — handy for
diffing shapes without writing a client.

Nenu's bridge polls this method (one RPC per tick instead of the `workspace.list` + `pane.list`
+ `tab.list` trio) and falls back to the trio on older servers that don't know the method. Old-server
detection: the error reply is
``{"id":"","error":{"code":"invalid_request","message":"invalid request: unknown variant `session.snapshot`, expected one of ..."}}``
— the bridge treats an `unknown variant` error on `session.snapshot` specifically as "fall back,"
not a hard failure.

## Protocol 22 additions (live-checked on 0.9.1, 2026-10-10)

All read-only, on the operator's 0.9.1 server (`ping` → `{"version":"0.9.1","protocol":22}`). An
unknown method's error lists the server's 105 methods; `pane.get`, `pane.wait_for_output`,
`agent.list` and `ping` are among them.

- **Protocol probe.** `ping` is the cheapest call (0.13 ms) and reports `version` and `protocol`;
  `session.snapshot` carries the same two fields. Nenu's event stream pings before each subscribe and
  gates the newer subscription types on `protocol >= 22` (see "Event stream").
- **`pane.get {pane_id}`** returns one pane record, the same shape as a `pane.list` entry (0.19 ms vs
  1.25 ms for the list). Unknown id → `pane_not_found`.
- **`pane.wait_for_output`** waits server-side until a `visible`/`recent`/`recent_unwrapped`/`detection`
  read matches `match: {type: "substring" | "regex", value}`, and returns the matching read inline:
  `{type:"output_matched", pane_id, matched_line, revision:0, read:{pane_id, workspace_id, tab_id,
  source, format, text, revision:0, truncated}}`. Measured on 0.9.1: a hit returned in 1.4 ms; a miss
  ends at `timeout_ms` with the error code **`timeout`** (`timed out waiting for output match`, 300 ms
  asked → 308 ms); a bad pattern is `invalid_regex`; an unknown pane `pane_not_found`. `strip_ansi`
  defaults to true. A match is a trigger to look, never the verification: whoever acts on it
  re-derives the screen from `read.text` (ADR 0010, ADR 0048). `HerdrClient.waitForOutput` maps
  `timeout` to `{matched:false}`.
- **`agents[]` in `session.snapshot`** (and `agent.list`) carry agent-only fields on top of the pane
  record: `state_change_seq` (bumps on every status transition, so two equal values mean nothing moved
  between two reads), `completion_seq` (bumps when an idle transition completed work), `name`,
  `interactive_ready`, `launch_pending`. **0.9.1 reports `state_change_seq` and omits
  `completion_seq`** (live-observed on 12 agents); read both as optional. Nenu joins them onto the
  agent view by `pane_id` (`stateChangeSeq`, `completionSeq`); the list-call fallback has neither.
- **New pane-record fields:** `tokens` (key/value strings a plugin reports with a TTL, at most 32, keys
  `^[A-Za-z0-9_-]{1,32}$`), `state_labels`, `title`, `display_agent`, `restore_error`, alongside
  `terminal_title(_stripped)`. Herdr Organizations writes `project`, `thread`, `review`, `rank`,
  `depth`, `parent`, `role`, `tree-order` (300 s TTL) and `org_sidebar`/`org_project`/`org_workspace`/
  `org_heartbeat` (60 s TTL); live panes also carry `hp_group`. **A missing token means unknown, never
  "removed"**: it can simply have expired while its plugin was down. Nenu copies an allowlisted subset
  (`bridge/state-engine.ts` `allowedTokens`).
- **No image API on the socket.** Neither the 0.9.1 method list nor the 0.9.3 schema has an image
  method; pictures in chat come from the journal, uploads or files.

## `pane.send_keys` key grammar (verified)

The server **validates** every key and rejects unknown names with
`{error:{code:"invalid_key", message:"unsupported key <X>"}}` (pane lookup happens first, so probe
against a real pane). Empirically enumerated against Herdr 0.7.0 — it is **NOT** tmux syntax:

- **Special keys (bare, case-insensitive):** `Up` `Down` `Left` `Right` `Tab` `Enter` `Escape`
  `Space` `Backspace` (alias `BS`), and function keys `F1`…`F12`.
- **Literal single characters:** a one-character string is typed as that character — digits (`"1"`,
  `"2"`, …), letters, punctuation (live-verified 2026-07-04). This is what Nenu's prompt-select
  taps send: `{keys:["1"]}` answers a permission dialog; `{keys:["2","Enter"]}` picks option 2 of an
  AskUserQuestion select.
- **Modifier chords (join with `+`):** `ctrl+c`, `ctrl+u`, `ctrl+d`, `ctrl+l`, `ctrl+r`,
  `shift+tab`, `ctrl+left`, `alt+f`, … Modifiers: `ctrl` / `shift` / `alt` / `cmd` / `super`
  (case-insensitive). This is the **same grammar as `config.toml [keys]`**.
- **Multi-modifier chords work, in any modifier order** (live-verified 2026-07-20 against 0.7.3 on
  a throwaway sandbox pane, with `PageUp` → `invalid_key` in the same run as proof the validator was
  active): `ctrl+shift+p` / `shift+ctrl+p`, `alt+shift+p` / `shift+alt+p`, triple
  `ctrl+alt+shift+p` / `ctrl+shift+alt+p`, and modifier+special `alt+Up` all ack. Independently
  confirmed against 0.7.4 by @bnivanov (issue #20).
- **NOT supported** (all return `invalid_key`): tmux-style `C-c` / `BTab`; and the keys
  `PageUp` `PageDown` `Home` `End` `Insert` `Delete` (in any spelling). There is no forward-delete
  and no scrollback paging via keys — the web mirror is scrollable instead.
- ⚠️ Consequence: Ctrl-C is **`ctrl+c`**, not `C-c`. Multiple keys per call are applied in order,
  e.g. `{keys:["Down","Enter"]}`.
- Re-checked against 0.7.2's bundled schema: unchanged.

### Mac keys, rechecked on Herdr 0.9.1 (2026-09-26)

An isolated raw PTY capture verified `cmd+k` → `ESC[107;9u`, `alt+Left` →
`ESC[1;3D`, `alt+Backspace` → `ESC DEL`, and `Backspace` → `DEL`.
Nenu exposes Command as `cmd`, Option as `alt`, and Mac's backward-delete key as
`Backspace`. Command handling depends on the terminal application; these are not macOS
menu/clipboard shortcuts. `Home`, `End`, `Delete`, `PageUp`, and `PageDown` still return
`invalid_key`; the keypad does not substitute a destructive Ctrl chord for them.

## Rename methods — set an object's label (verified)

Three sibling RPCs set a display label on a workspace, tab, or pane. Live-verified 2026-07-18.

| Method | Params | `label` | Returns (`result.type`) | Event |
|---|---|---|---|---|
| `pane.rename` | `{pane_id, label}` | `string \| null` — **null clears** | `pane_info` → `{pane}` | **none** |
| `tab.rename` | `{tab_id, label}` | `string` (non-null) | `tab_info` → `{tab}` | `tab_renamed` |
| `workspace.rename` | `{workspace_id, label}` | `string` (non-null) | `workspace_info` → `{workspace}` | `workspace_renamed` |

- **`pane.rename` is the odd one out, twice over.** Its `label` accepts `null`, which **clears** the
  label (the `label` key then disappears from the pane record); the sibling two take a non-null
  string. And it emits **NO event** — a renamed pane surfaces only on the next `session.snapshot` /
  `pane.list` poll. `tab.rename` / `workspace.rename` DO emit: `tab_renamed` →
  `{type, tab_id, workspace_id, label}`, `workspace_renamed` → `{type, workspace_id, label}` (the
  `event` field is snake_case on the stream, as everywhere).
- **Errors:** an unknown id → `{code:"pane_not_found" | "tab_not_found" | "workspace_not_found",
  message:"<kind> <id> not found"}`.
- **No length limit; empty string accepted** (stored as-is on tab/workspace). Re-verified on
  `tab.rename` 2026-07-19: `label:""` is stored **literally** (the tab's label becomes empty — it does
  **not** reset to the default number), and `label:null` is rejected with
  ``{code:"invalid_request", message:"invalid request: invalid type: null, expected a string"}`` —
  confirming tabs/workspaces have **no "clear"** (only `pane.rename` clears, via `null`). Nenu makes
  its own opposite choices per object: a blank pane "Save" clears (blank → `null`), while a blank tab
  "Save" is refused client- and bridge-side, since a literal-empty tab chip is useless. See
  `bridge/server.ts` (`normalizeTabLabel`).
- **Undocumented field:** once set, a pane's label rides along as **`label?: string`** in `pane.list`,
  `pane.get`, `pane.current`, and `session.snapshot` panes (omitted when unset — so it's absent from
  the base pane shape below). Workspaces already expose `label`; tabs likewise.
- **`agent.rename` `{target, name}`** also exists in the schema, but it is a DIFFERENT operation
  (renames an agent session, not a pane/tab/workspace) — **unverified and unwired by Nenu**. Listed
  only so it isn't mistaken for the label renames above.

## Close methods — kill a pane or a whole tab (verified)

Two sibling structural ops remove panes. `tab.close` live-verified 2026-07-19 on the sandbox session.

| Method | Params | Returns (`result.type`) | Event | Error (unknown id) |
|---|---|---|---|---|
| `pane.close` | `{pane_id}` | `ok` | `pane.closed` | `pane_not_found` |
| `tab.close` | `{tab_id}` (schema: `TabTarget`) | `ok` | `tab.closed` | `tab_not_found` |

- **`tab.close` is a BULK pane-close: closing a tab terminates EVERY pane inside it.** Verified by
  creating a throwaway tab holding a plain shell pane, then `tab.close {tab_id}` — the next
  `session.snapshot` no longer lists the tab **or** its inner pane. So it's no more privileged than
  closing those panes one-by-one (which `pane.close` already allows) — same remote-shell threat model.
- **Success is a bare `{"result":{"type":"ok"}}`** (same shape as `pane.close`), not a record reply
  like the renames — there's nothing left to describe. The closure surfaces on the next snapshot poll;
  `tab.close` also emits a `tab_closed` event (which Nenu doesn't consume).
- **Errors:** unknown id → `{code:"tab_not_found", message:"tab <id> not found"}`; a missing `tab_id`
  → ``{code:"invalid_request", message:"invalid request: missing field `tab_id` …"}``.

## Move methods — reorder tabs and workspaces (verified)

Two sibling structural ops reorder objects. Both live-verified 2026-07-20 on the sandbox session.

| Method | Params | Returns (`result.type`) |
|---|---|---|
| `tab.move` | `{tab_id, insert_index}` | `tab_list` → that workspace's tabs, post-move order |
| `workspace.move` | `{workspace_id, insert_index}` | `workspace_list` → all workspaces, post-move order |

- **Tabs: array order is authoritative, `number` is stable.** `tab.move` reorders the array
  returned by `tab.list` / `session.snapshot` **without renumbering** — after moving `t2` (number 2)
  before `t1` (number 1), the snapshot lists `[t2, t1]` with numbers unchanged. Herdr itself renders
  array order: the default label of an unlabeled tab is **positional** (post-move, `t2` displays as
  "1"). ⚠️ Consequence: a client that sorts tabs by `number` un-does the user's reorder — render
  tabs in array order, never number order.
- **Workspaces are the opposite: `workspace.move` renumbers.** After moving `w7` (number 5) to the
  front, it becomes `number 1` and every other workspace shifts — `number` always equals position,
  so array order and number order never disagree and sorting workspaces by `number` is safe.
- **`insert_index` counts positions in the PRE-removal list** (workspace-scoped for tabs, clamped at
  the end). Moving an item toward the end therefore needs `target + 1`: with `[t2, t1]`,
  `tab.move {tab_id: t2, insert_index: 1}` is a **no-op**; `insert_index: 2` yields `[t1, t2]`.
- The event catalog lists sibling `tab.moved` / `workspace.moved` events (0.7.2); emission not
  observed here (no live subscription during the probe).

## Object shapes (observed)

```jsonc
// workspace.list → workspaces[]
{ "workspace_id":"w0000000000000", "number":1, "label":"demo",
  "focused":false, "pane_count":2, "tab_count":1,
  "active_tab_id":"w0000000000000:t1", "agent_status":"done" }

// pane.list → panes[]
{ "pane_id":"w0000000000000:p1", "terminal_id":"term_…", "workspace_id":"w0000000000000",
  "tab_id":"w0000000000000:t1", "focused":false, "cwd":"/…/demo",
  "foreground_cwd":"/…/demo", "agent":"claude", "agent_status":"done",
  "agent_session":{"source":"herdr:claude","agent":"claude","kind":"id","value":"…"},
  "revision":0,
  "scroll":{"offset_from_bottom":0,"max_offset_from_bottom":128,"viewport_rows":48} }
```

`agent_status` ∈ `idle | working | blocked | done | unknown`. Panes without an agent omit/null `agent`.

> **`agent_session` has TWO kinds, and it can outlive the agent that reported it** (live-verified
> 2026-07-29 against claude, codex and pi panes). Each harness's herdr integration reports through
> `pane.report_agent_session`, and what it reports differs:
> - `kind:"id"` + a uuid — claude (`source:"herdr:claude"`) and codex (`source:"herdr:codex"`, from
>   codex's `SessionStart` hook; verified on codex 0.145.0).
> - `kind:"path"` + an **absolute path to the log file** — pi (`source:"herdr:pi"`). pi's integration
>   prefers `agent_session_path` over an id whenever its session manager has a file open.
>
> Two consequences. A harness only reports at all once `herdr integration install <agent>` has been
> run — pi's was missing on this host and the pane simply carried no session of its own. And Herdr
> keeps reporting the LAST session announced for a pane, so relaunching a pane's agent as a different
> harness leaves the previous one's ref behind: a pane running `pi` was observed still advertising a
> `herdr:claude` id. The record's own `agent` field is what distinguishes the two — compare it against
> the pane's `agent` before trusting the ref (`bridge/state-engine.ts`).

> **Pane records now carry `scroll`** (new in 0.7.2, live-verified 2026-07-07): `pane.list`,
> `pane.get`, `pane.current`, and `session.snapshot` panes all include
> `scroll: {offset_from_bottom, max_offset_from_bottom, viewport_rows} | null` (all `uint64`;
> `offset_from_bottom == 0` means the pane is scrolled to the bottom). Nenu doesn't consume it yet.

> **`revision` is a metadata counter, not a content counter** (re-checked 2026-10-10 on 0.9.1).
> The pane record's `revision` (in `pane.list`, `pane.get`, `session.snapshot`) moves on stripped-title,
> metadata and resume changes; a working pane's output does not move it (a `pane.get` stayed at the same
> revision while the pane worked). `pane.read`'s and `pane.wait_for_output`'s own `revision` is
> **always 0**. On 0.7.x every revision was 0. Never use either as an output-change detector; Nenu's
> prompt-select race guard re-derives the menu from content for exactly this reason.

## Event stream (now wired: event-poked polling)

`events.subscribe` `{subscriptions: [{type, pane_id?}]}` keeps the connection open and streams
events. Empty `subscriptions: []` → ack only, no events ever arrive. The ack and the event frames
are shaped differently — worth calling out explicitly:

- **Ack:** `{"id":"<id>","result":{"type":"subscription_started"}}`.
- **Event:** `{"event":"<snake_case>","data":{...}}`. Note the split: subscription `type` values
  are dot-form (`pane.agent_status_changed`), but the `event` field on each streamed line is
  snake_case (`pane_agent_status_changed`). Real example line:
  `{"data":{"pane_id":"w6:p3","type":"pane_agent_detected","workspace_id":"w6"},"event":"pane_agent_detected"}`.
  **Except pane-scoped events on 0.9.3:** the P0 probe log (2026-10-10) shows
  `"event":"pane.agent_status_changed"` in dot form next to snake_case globals (`pane_updated`), and the
  0.9.3 schema types a subscription event's `event` as `pane.output_matched | pane.agent_status_changed
  | pane.scroll_changed`. Match both spellings.

The full event catalog (subscription `type` values), 0.7.2 additions marked `*`, protocol 22
additions marked `**` (the list is quoted from 0.9.1's own `unknown variant` error, 2026-10-10):

```
workspace.created  workspace.updated  workspace.metadata_updated **  workspace.renamed  workspace.moved *
workspace.reordered **  workspace.closed  workspace.focused
worktree.created   worktree.opened    worktree.removed
tab.created        tab.closed         tab.focused        tab.renamed       tab.moved *
pane.created       pane.closed        pane.updated **    pane.focused      pane.moved        pane.exited
pane.agent_detected  pane.output_matched  pane.agent_status_changed
layout.updated *   pane.scroll_changed *
```

`*` = new to the catalog in 0.7.2 (`workspace.moved`, `tab.moved`, `layout.updated`,
`pane.scroll_changed`); `workspace.updated` and `pane.focused` were already listed but are called
out here too since they're easy to miss in the block above.

- **Scoping, verified:** `pane.agent_status_changed`, `pane.scroll_changed`, and
  `pane.output_matched` **require** `pane_id` in the subscription (omit it →
  ``invalid_request: missing field `pane_id` ``). Everything else is global — subscribe with just
  `{type}`.
- **`layout.updated`** (global) payload is a full `PaneLayoutSnapshot`: `{workspace_id, tab_id,
  zoomed, area, focused_pane_id, panes:[{pane_id,focused,rect}],
  splits:[{id,direction,ratio,rect}]}` — the same shape as `session.snapshot`'s `layouts[]`.
- **`pane.scroll_changed`** (pane-scoped) payload: `{pane_id, workspace_id, scroll}` (`scroll`
  shape as in "Object shapes" above).
- **`pane.output_matched`** (pane-scoped) also takes `source`, `match: {type: "substring" | "regex",
  value}`, `lines?` and `strip_ansi?`, like `pane.wait_for_output`. Payload: `{pane_id, matched_line,
  read}`. A standing regex fired once per new dialog in the P0 probes (9 dialogs, 9 events), and the
  `blocked` status arrived a median ~100 ms after it, in either order (0.9.3,
  `web/src/lib/grammar/PROBES_2026_10_NOTES.md`). Server cost: Herdr re-reads the pane every 100 ms
  for each such entry, so subscribe only the panes that need it.
- **`pane.updated`** (global, protocol 22) carries the full pane record and fires on metadata changes
  (title, session id, tokens), each with a new `revision`. **It does not track status**: in the P0
  probe Claude produced 4 (agent detected, session id, `/clear`, title) and Codex ~1/s while blocked,
  following its animated terminal title. Treat it as a metadata poke only.
- **`pane.agent_status_changed`** (protocol 22) accepts an optional `agent_status` filter, and its
  payload also carries `title`, `display_agent` and `state_labels`.
- **One bad entry rejects the whole subscribe.** An unknown `type` (an older server) and a `pane_id`
  that no longer exists (`pane_not_found`) both fail the request before the ack. Rebuild the per-pane
  entries from a fresh snapshot before retrying.
- **`events_lost`.** Herdr streams from a bounded shared event history; a reader that falls behind it gets
  an `events_lost` error line and the stream closes. The prescribed recovery is resubscribe plus a fresh
  `session.snapshot`, since whatever happened meanwhile is unknown.
- **Rich payloads:** `pane_created` / `workspace_created` carry the **full** pane/workspace
  record, not just ids. `pane_exited` carries `{pane_id, workspace_id}`. `pane_agent_detected`
  carries `{pane_id, workspace_id, agent?}` and can fire in herd-wide bursts on re-detection —
  consumers should debounce it.

Nenu now polls `session.snapshot` (above) as the source of truth, and additionally holds a
long-lived `events.subscribe` stream — global lifecycle events plus a per-agent-pane
`pane.agent_status_changed` subscription, resubscribed whenever the agent-pane set changes —
purely to **poke** the poller: an event triggers an immediate debounced re-poll, it never updates
state by itself. `bridge/event-poker.ts` adds:

- the `**` types above, only when `ping` reports protocol 22 or newer, and the base list for good if
  a server rejects them anyway;
- `pane.output_matched` entries only for watches a caller sets (`setOutputWatches`), delivered to
  `onOutputMatched` listeners at once and never as a poke;
- `pane.updated` pokes only when the pane's agent, label, session ref or allowlisted tokens changed,
  so Codex's animated title does not turn into a poll a second;
- on `events_lost`, an immediate re-poll and resubscribe; on `pane_not_found`, an immediate re-poll
  whose fresh pane set resubscribes (backoff stays the fallback).

While the stream is healthy, interval polling relaxes to `COLLIE_POLL_IDLE_MS`
(default 12000 ms, min 1000 ms); when the stream is down or reconnecting, it drops back to the
fast `COLLIE_POLL_MS` cadence. Events accelerate; the snapshot stays authoritative — a missed
event costs one interval, never correctness.

Also in the schema but unused by Nenu: `events.wait` (on 0.9.1 it only matches agent status;
`pane_output_changed` is rejected: "events.wait currently supports pane agent status matches"), `pane.send_input`,
`agent.list` (the snapshot's `agents[]` already carries its counters) — run `herdr api schema` for
the full catalog (105 methods on 0.9.1).
