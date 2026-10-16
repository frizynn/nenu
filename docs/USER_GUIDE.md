# Nenu User Guide

This guide covers installation, security, configuration, daily operation, updates, push notifications,
and troubleshooting. Start with the shorter [project overview](../README.md) if you are evaluating
Nenu, or jump directly to [installation](#install).

> Compatibility note: since 1.0 the plugin id is `herdr.nenu` and the services are `herdr.nenu`
> (launchd) and `nenu` (systemd); before that they were `herdr.collie` and `collie`. The first `start`
> after the update carries an older install's config over and retires its old service. `COLLIE_*`
> settings, `collie-ctl.sh` and the state directory keep their names.

## ⚠️ Security — read before you run it

**Nenu is remote shell access to your machine, by design.** One bridge call types arbitrary
keystrokes into a live terminal pane, so anyone who can reach the URL can read every pane (source,
secrets, env, agent output) and run any command as your user. No sandbox, no command allow-list
(that would defeat the purpose). Treat the URL like a root login.

The sharp edges:

- **It acts as _you_**, with your full privileges — `~/.ssh`, `git push --force`, `rm -rf`, `sudo`.
- **Access is device-level, not person-level.** Tailscale proves the device, not who's holding it —
  no password, no session, so an unlocked or stolen phone is an open shell. The idle lock pauses an
  unattended screen and gates nothing (details:
  [ADR 0007](../.adr/0007-the-idle-lock-is-a-pause-not-a-gate.md)).
- **Every uid on the host can reach it.** Herdr's socket is a file, so its permissions keep other
  local users out; Nenu's port is TCP, so they're all in. The per-device gate closes the write half
  of that; reads stay open, so it bounds damage, not disclosure (details:
  [ARCHITECTURE.md §6](../ARCHITECTURE.md#6-security-model)).
- **One bridge fronts _every_ session** under your config root by default, sandbox ones included
  (details: [Multi-session](#multi-session)).
- **Every write is appended to `<state-dir>/audit.log`** — replies, keys, uploads, pane and tab
  create/close. A trail is not a gate (details:
  [ARCHITECTURE.md §6](../ARCHITECTURE.md#6-security-model)).
- **The defenses:** loopback bind only, never `0.0.0.0` (the bridge refuses to start on a wide bind
  unless you set `COLLIE_ALLOW_NON_LOOPBACK_BIND=1`); exactly one hardened front door —
  `tailscale serve` or a conforming reverse proxy, never `funnel` and never a bare port; a
  same-origin gate and a strict CSP, with pane output rendered as React text nodes rather than
  `innerHTML`. Host-header validation is on by default and fails closed (`COLLIE_ALLOW_ANY_HOST=1`
  turns it off). `COLLIE_TRUSTED_USER` rejects a mismatching *or missing* `Tailscale-User-Login`
  (tagged nodes get no header; `COLLIE_TRUSTED_USER_OPTIONAL=1` restores the old missing-header
  pass). Authorising individual *devices* needs a proxy in front — see
  [`DEPLOYMENT.md`](../DEPLOYMENT.md).

> 🚫 **Never `tailscale funnel` this** — funnel exposes it to the public internet; `serve` keeps it
> tailnet-only. There is no scenario where funneling Nenu is correct.

Narrow the blast radius with Tailscale ACLs and `COLLIE_TRUSTED_USER`. Provided as-is, no warranty.

## Requirements

On the **host** (the tailnet node your agents run on). Need Herdr 0.7.0+ — check with
`herdr --version`.

| Tool | Why |
| --- | --- |
| [**Bun**](https://bun.sh) | Runs the bridge and builds the web UI — the only hard dependency. |
| [**Herdr**](https://herdr.dev) ≥ 0.7.0 | The herd Nenu mirrors; its CLI registers the plugin. |
| [**Tailscale**](https://tailscale.com) | Front door for the default variant (`tailscale serve`); optional if you run [Variant C](../DEPLOYMENT.md#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale) behind your own reverse proxy. Without any front door, the bridge is `127.0.0.1`-only. |
| **git** | Clone, and the `update` command. |

The control script uses **systemd --user** on Linux and **launchd** on macOS; a host with neither
falls back to an unsupervised `nohup` process. You never install JavaScript dependencies by hand —
the build runs `bun install` for you; the backend imports only Bun and `node:*` modules.
[`web-push`](https://www.npmjs.com/package/web-push) is optional and lazy (see [Web
Push](#web-push-optional)).

**Linux and macOS are the supported hosts.** The bridge itself also runs on **Windows**
(experimental) against Herdr's Windows beta — see [Windows](#windows-experimental).

## Install

On the host, not your phone. Two ways in.

**From GitHub (turnkey)** — Herdr fetches and builds for you:

```bash
herdr plugin install frizynn/nenu
herdr plugin action invoke start --plugin herdr.nenu
```

**From a local clone (for development)** — registered by path:

```bash
git clone https://github.com/frizynn/nenu.git && cd nenu
herdr plugin link "$(pwd)"
herdr plugin action invoke start --plugin herdr.nenu
```

Either way, `start` does four things:

1. **builds** `web/dist` if it's missing (typechecked, staged, swapped in atomically),
2. **starts the bridge** as the `systemd --user` service `collie` (`nohup` fallback without systemd),
3. **publishes it on the tailnet** with `tailscale serve`: HTTPS on the host's MagicDNS name,
   `:443 → 127.0.0.1:8787`, tailnet-only,
4. **prints the banner** with the URL to open — walked through line by line in
   [First run](#first-run--what-youll-see).

> No Herdr? Run `scripts/collie-ctl.sh start` directly — same effect (config then lives in
> `~/.config/collie/.env`).

## First run — what you'll see

The transcripts below are the control script's inline output. **Through `invoke start` you get
Herdr's JSON envelope instead** — the same text is the action's *captured stdout*, read with
`herdr plugin log list --plugin herdr.nenu`.

```console
$ scripts/collie-ctl.sh start
building web UI (first run)…                    # linked clone only; a GitHub install already built
…bun install · typecheck · vite build output…
bridge started (systemd --user: collie)
tailscale serve (https) → tailnet :443 -> 127.0.0.1:8787

  ✓ Nenu is running  ·  vX.Y.Z+174c4e4
    service   systemd --user (collie) · active
    local     http://127.0.0.1:8787
    tailnet   https://myhost.tail1234.ts.net
```

The `✓` is a real probe — the script connected to the bridge's port and got an answer, not just
"the unit is active". If you get `⚠ Nenu isn't answering on :8787 yet` instead, see
[Troubleshooting](#troubleshooting).

### What just happened

`start` left three durable things on the host:

1. **`web/dist`** — the built UI, served from disk, so later rebuilds go live without a restart.
2. **A supervised user service** — a `systemd --user` unit named `collie`, or a launchd agent on
   macOS ([Surviving reboots](#surviving-reboots) has the details of both).
3. **A tailnet-only `tailscale serve` mapping** — HTTPS on the host's MagicDNS name,
   `:443 → 127.0.0.1:8787`, TLS terminated by Tailscale. Inspect with `tailscale serve status`;
   remove just this mapping with `scripts/collie-ctl.sh unserve`.

`stop` merely pauses the service; `uninstall` reverses 2 + 3 and keeps your `.env` and the checkout.
Why a service and not a Herdr pane: [`ARCHITECTURE.md`](../ARCHITECTURE.md) §3.

### Open it on your phone

The URL is the banner's `tailnet` line — print it again anytime with `scripts/collie-ctl.sh url`, or
`scripts/collie-ctl.sh qr` to print it as a QR code you can scan. It resolves for any device on your
tailnet, so the phone needs the Tailscale app installed and connected to the same tailnet as the
host.

Then install it as an app: **iOS** — Safari → share sheet → *Add to Home Screen*. **Android** —
Chrome → ⋮ menu → *Add to Home screen* (or *Install app*). Installing (and Web Push) needs the
HTTPS origin the default serve mode already provides; over `COLLIE_SERVE_MODE=http` the page works,
but service worker and install silently no-op.

### Is it actually working?

A sixty-second check, host side then phone side:

```console
$ scripts/collie-ctl.sh status

  ✓ Nenu is running  ·  vX.Y.Z+174c4e4
    service   systemd --user (collie) · active
    local     http://127.0.0.1:8787
    tailnet   https://myhost.tail1234.ts.net

  serve config:
    https://myhost.tail1234.ts.net (tailnet only)
    |-- / proxy http://127.0.0.1:8787
```

```console
$ scripts/collie-ctl.sh logs        # journal timestamps trimmed here
[push] disabled (no VAPID keys configured)
[bridge] listening on http://127.0.0.1:8787  (poll 1500ms)
[bridge] WARNING: COLLIE_TRUSTED_USER is empty — any tailnet device/user that reaches the bridge gets full write access. Set it to your tailnet login (see README → Variant A).
```

**That WARNING is expected on a fresh install** — identity is still open. Host-header validation is
on by default (`collie-ctl.sh` injects the tailnet name). [Configure](#configure) sets the identity.
(The loopback URL in the log is also correct: the bridge itself only ever binds `127.0.0.1` —
`tailscale serve` is what makes it reachable.) `[push] disabled` is expected too: notifications are
opt-in, and [Web Push](#web-push-optional) is three commands.

On the phone: your agents are listed, and the footer build stamp (`vX.Y.Z · debcff9 · …`) matches
`scripts/collie-ctl.sh version`. If the page loads but stays empty, that's the same-origin gate —
see [Troubleshooting](#troubleshooting).

An agent can walk the rest of the setup for you: the
[onboarding skill](../skills/nenu-onboarding/SKILL.md) checks identity, Web Push, the Claude hooks
and status line, your operator files and updates on this host, and offers to finish each missing
item. The [README](../README.md#install) shows how to make it available to Claude Code and Codex.

## Using conversations

### Starting and recovering conversations

Open an empty terminal in Nenu and tap **Start Codex** or **Start Claude Code**. The buttons wait for terminal output before enabling. Complete any native trust or login prompts, then send the first message. Use the terminal icon to switch between conversation and terminal views.

New Codex launches use `--no-daemon`, keeping the session hook in the terminal's own process. Claude launches get an explicit session ID. Both views control the same native session; Nenu does not start a second agent when switching views.

If an existing Codex terminal has no connected history, tap **Find Codex conversations** and select the conversation already running there, or enter the session ID shown by `/status`. **Connect history** restores the chat without sending a prompt or resuming another process. **Change connected conversation** lets you correct that choice later. The connection survives a bridge restart but is discarded if the terminal process or hook identity changes.

Recovery uses the existing local Codex daemon socket under `$CODEX_HOME/app-server-control/`; it does not expose that socket over the network. Claude background sessions can be identified by `claude agents --json` and their exact `attach` target. Older CLIs can still be launched manually and read through their installed Herdr integration.

See [the session architecture decision](.adr/0022-native-agent-sessions-and-explicit-history-recovery.md) for verified versions and limitations.

### Mobile editor

The chat header keeps **Terminal / Chat** visible while writing. **Conversation actions**
contains search, files, history, display settings and the option to reconnect an existing
Codex conversation. Typing no longer hides navigation behind a separate button.

The message box keeps attachments, model selection and Send together. **More message
actions** opens commands, quick replies, terminal keys and usage/context details. Drafts
survive switching between chat and terminal. If verification fails, keep the draft and
retry after inspecting the terminal; a typing acknowledgement is not a model response.

### Subagents within a conversation

The **Agents** button beside Terminal opens the current conversation's delegated tasks. Each row
shows its last known state, task and reported model. Open a row to read that child's conversation;
the parent terminal and draft remain in place. The list includes nested children when their parent
relationship is available. A disconnected or unobserved runtime is shown as unknown, not working.

Codex uses its local App Server and native journal lifecycle events. Claude discovers transcripts under the exact parent
session and can additionally track live start/finish events. To enable those events while preserving
your other Claude hooks, run:

```sh
herdr plugin action invoke subagent-hooks --plugin herdr.nenu
```

The action backs up Claude's user settings before adding Nenu's hooks. Existing sessions that have
not loaded the hooks can still expose history, but their live status may remain unknown. The hook
stores session/agent IDs, agent type, event and timestamp, never prompts or tool arguments. Custom
profiles can run `bun run scripts/install-subagent-hooks.ts /path/to/settings.json /path/to/nenu-state`.
See [the subagent inspector decision](.adr/0024-session-subagent-inspector.md) for scope and limits.


### Artifacts, media and queued messages

Use the paperclip in the session header to open **Project**, a folder tree rooted at the agent's
working directory. Expand folders in place; each folder loads only when first opened.
**Artifacts** collects verified designboard canvases and documents explicitly linked by the agent.
Editing a source file or mentioning an HTML path does not make it an artifact. **Files** and **Media**
keep all conversation references. Search names and paths, filter by artifact type and extension, and sort by the most
recent conversation mention (default), extension or name. Designboard titles come from their embedded
`canvas-doc` data; inspection reads at most 20 contained HTML files per request, with 60 per UI batch.
Older candidates can be inspected on demand. Images and MP4/WebM videos also appear
inside messages. Videos support seeking, and file previews can be refreshed or downloaded.
HTML has Render and Code views in an isolated offline document. Styles, scripts and images in the
same folder are inlined into that document (set `COLLIE_HTML_INLINE_ASSETS=off` to render the bare
file); anything else stays blocked.
Designboards open in view mode; downloading preserves the original editable document.

Use **Add to queue** beside Attach to stage a message. While an agent works, Send queues the
current draft. The list above the composer lets you edit, remove or send an individual message now.
The bridge saves the queue and dispatches when the agent is ready even with the browser closed.
Questions, host drafts and uncertain deliveries pause sending; inspect Terminal before retrying.
Queues stay attached to the connected conversation and never migrate to a replacement session.
See [the implementation decision](.adr/0025-artifacts-and-server-message-queue.md) for limits.

The **Agents** switcher keeps **Main · Parent** available alongside its children. Running agents
are expanded; Finished and other inactive groups start collapsed each time the switcher opens.
Selecting a child opens its live journal in the main chat. Main's draft stays intact when returning.
Child journals currently have no independent input transport: send instructions through Main.


### Claude context and account usage

The composer shows context, five-hour usage and weekly usage without opening More actions.
Claude supplies these values through its native status line. Enable the local capture from this
checkout with `bun scripts/install-claude-statusline.ts`. It backs up user settings, preserves the
existing status-line command and its output, and is safe to run again. Custom profiles may pass
`/path/to/settings.json /path/to/nenu-state` as the two arguments. Project overrides of `statusLine`
need the same installer applied to that settings file. No credentials or conversation text are stored.

The bridge reads a bounded per-session metadata file alongside the existing pane refresh, so the
phone makes no extra polling requests and does not wait for the conversation history. Values remain
provider-reported, with their observation time and reset times in the usage popover. Claude versions
or accounts that omit a limit leave it unavailable; Nenu never estimates account limits from tokens.

### Knowing whether an agent is working

Nenu reads each agent's own record of its turn: Claude's per-process session file
(`~/.claude/sessions/<pid>.json`, plus its transcript while busy) and Codex's rollout file. The phone's
Stop button and the Stop action both follow it, so Stop works with a custom Claude status line, and it
stays hidden while only a background agent runs (Escape would not reach it). Nothing needs installing.

Optional: Claude hooks make the bridge re-read that state the moment Claude reports an event. Install
them with `herdr plugin action invoke claude-hooks --plugin herdr.nenu` and remove them with
`herdr plugin action invoke claude-hooks-remove --plugin herdr.nenu`. The installer only touches
Nenu's own `type: "http"` hooks in `~/.claude/settings.json` (or `$CLAUDE_CONFIG_DIR`), backs up the
file first (`settings.json.nenu-hooks-backup-<time>`), keeps every other hook and setting, and running
it twice changes nothing. Hooks never allow, deny or block anything, and only new Claude sessions
load them.

For background Claude sessions, subagent lifecycle hooks are matched to the live runtime's native
start time. Long tools stay running without a two-minute activity timeout; restarting the parent
cannot revive children from its previous process. If that runtime cannot be verified, stale children
remain Unconfirmed. Explicit stop/completion records still take precedence.

### Math in answers

Nenu renders LaTeX in an agent's answer as math, loaded the first time a formula appears. To have an
agent write math that renders, ask it to use these forms:

| Write | Renders as |
| --- | --- |
| `$E = mc^2$` or `\(E = mc^2\)` | Inline math |
| `$$` or `\[` on its own line, the formula, then `$$` or `\]` on its own line | A block |

- No space right inside the delimiters: `$x$` is math, `$ x $` is text, so prices like `$5 and $10`
  stay text.
- Write `\$` for a literal dollar sign next to math.
- Code spans and code blocks are never read as math.
- Colors (`\textcolor`) and boxes (`\boxed`) render without the color or the border, because inline
  styles are dropped for safety. A formula that fails to parse shows its TeX source.

## Projects and chat controls

Projects come from [Herdr Organizations](https://github.com/frizynn/herdr-organizations) (or the
upstream herdr-projects it grew from). Nenu discovers registered projects automatically. Open a project from Overview or the sidebar
to see its coordinator and threads. Only currently matched panes get chat links; a registered project
still appears when its agents are offline. Ordinary workspaces remain available alongside projects.
Discovery follows `HERDR_PROJECTS_ROOT`, then `root` in `~/.config/herdr-projects/config.toml`, then
`~/.herdr-projects`. Projects are scoped to their recorded Herdr session. The overview reads existing
project records and live panes; it does not create projects or start agents.

Every view of a project (its page, the panel beside a coordinator, the phone's **Threads** tab and
the sidebar) draws the same tree as Herdr Organizations' popup. It shows only what is open, nested
under the coordinators that run it, coordinators first and then needs you, review, working and idle.
Everything resolved sits in one grey **History** at the end, closed until you open it; each resolved
coordinator folds over the threads it ran, newest first. Tapping a node opens its chat when it runs in
a live pane, and its detail page otherwise; nothing jumps elsewhere.

A coordinator's page also has a **Summary** tab: everything under it in three sections, **Needs your
decision**, **In progress** and **Done**, newest first. Each card shows what the agent's last report
says in plain words, its pull request, the pictures it took (swipe the row, tap one to see it large)
and the documents it left; an HTML page or PDF opens in a new tab. The coordinator's own report heads
the page. This needs a Herdr Organizations whose reports carry a status and a summary; with an older
one the page opens on its threads as before, and the Summary shows each thread's state and pull
request only.

**Close** (the check on an open row) stops a node and its view and keeps its branch, worktree and
report. A coordinator that still runs open work is refused until those are closed. **Replace
coordinator** (on the coordinator's row) stops the project coordinator and starts a new one on the
agent you choose (`herdr-organizations coordinator replace`). **New thread** and **New coordinator**
start nodes, from a template when the project has them. The **PRs** tab lists the open pull requests of open threads with their
state in words; pull requests of resolved threads fold into **History**, since Organizations stops
re-reading a pull request once its thread is resolved. These actions need a device with write
access and Herdr Organizations; upstream herdr-projects can only close and start top-level threads.

In a chat, open **Files and photos** to browse file references and images from its available journal.
The browser can load older entries and reports when the underlying journal is truncated. File
previews retain the existing workspace and private-file restrictions; a reference does not guarantee
that a file still exists or is accessible. Photos uploaded through Nenu can also be previewed when
their exact saved path appears in a user message in this chat. Images need a saved local file to
appear here. Uploads are currently retained for 48 hours; deleted uploads and remote image URLs are
unavailable.

While Claude or Codex is working, and right after you send a message, **Stop** takes the place of
Send (with a draft, both show). It interrupts the current turn the way Esc does in the terminal and
leaves the terminal open; on a desk, Esc in the empty composer does the same. The button turns into
**Stopping…** until the agent is idle, so a second tap sends nothing. If the agent has a message in
its own queue that stopping would send, the first tap asks and **Really stop?** confirms. Messages
still waiting in Nenu's queue are held after a Stop and go only when you send them. Other agents get
no Stop until their interrupt key has been measured.

## Configure

Out of the box Nenu runs **open single-user**: anyone on your tailnet who can reach the URL has
full control — that's the TRUSTED_USER warning. Close it:

```bash
# in your .env
COLLIE_TRUSTED_USER=you@example.com           # your tailnet login — the bridge rejects anyone else
```

Config is a `.env` in the plugin's config dir — find it with
`herdr plugin config-dir herdr.nenu` (typically `~/.config/herdr/plugins/config/herdr.nenu`;
without Herdr, `~/.config/collie`). `collie-ctl.sh` resolves this same dir whether you run it
directly or via a Herdr action:

```bash
cp .env.example "$(herdr plugin config-dir herdr.nenu)/.env"
```

The bridge reads `.env` only at startup — after any edit, `scripts/collie-ctl.sh restart`. See
[`.env.example`](../.env.example) for the full option list — commonly `COLLIE_PORT`,
`COLLIE_SERVE_MODE=http` (Headscale / `.internal` domains; read by the control script when it runs
`tailscale serve`), or `COLLIE_SERVE_PORT` (tailnet listener port for the https front door, default
443, https mode only — one Nenu per user on a shared host, see
[DEPLOYMENT.md](../DEPLOYMENT.md#several-nenu-instances-on-one-host)).

Reading history from more than one agent home? List them all in `COLLIE_TRANSCRIPT_ROOT`,
comma-separated.

**Custom domain or reverse proxy?** [`DEPLOYMENT.md`](../DEPLOYMENT.md) has the full front-door setup.
The one rule to know here: Nenu is same-origin only, so a different hostname or TLS terminator
needs the exact origin allowed —

```bash
COLLIE_ALLOWED_ORIGINS=https://nenu.example.com
```

— and until you do, the page loads and stays empty
([Troubleshooting](#troubleshooting) has the symptom).

Release availability checks are opt-in. To let Settings report published Nenu releases, set:

```bash
COLLIE_UPDATE_REPO=frizynn/nenu
```

When it is unset, Nenu makes no GitHub release-check request and shows the local release channel.
This does not change `update`: the update action still advances the checkout from its own `origin`.

### Your own slash commands

Commands only this machine has (a plugin's `/fork-in-herdr`, your own `/deploy`) go in
`commands.toml`:

```bash
cp commands.toml.example "$(herdr plugin config-dir herdr.nenu)/commands.toml"
```

```toml
[[commands]]
scope = "omp"                # optional; omit for every pane
command = "/fork-in-herdr"
description = "Fork this conversation into a new herdr tab"
```

A pane your rows match shows only your rows (narrowest row wins,
[ADR 0018](../.adr/0018-operator-command-rows-replace-the-catalog.md)). Add `confirm = true` for a
two-tap confirm. No restart — edits are live. Verify: open a pane, tap **/**, your rows are on the
first screen. Syntax error? `journalctl --user -u nenu -n 20` names the line.

### Your own key presets

The Keys tray's **Presets** row is yours to replace, in `keys.toml` next to `commands.toml`:

```bash
cp keys.toml.example "$(herdr plugin config-dir herdr.nenu)/keys.toml"
```

```toml
[[keys]]
scope = "claude"             # optional; omit for every pane
label = "Yes"
keys = ["Down", "Enter"]     # several chords go out as one batch
```

A pane your rows match shows only your presets, in place of the shipped Ctrl C/D/U/R/L/Z
([ADR 0018](../.adr/0018-operator-command-rows-replace-the-catalog.md)). Add `danger = true` for a
two-tap confirm. The rest of the tray — Esc, arrows, Enter/Tab/Space, modifiers, digits, F1–F12 —
is fixed and not configurable. Chords are herdr's spelling: `ctrl+c` (never `C-c`), `shift+tab`,
`ctrl+F7`; `PageUp`/`Home`/`End`/`Delete` are not accepted. No restart — edits are live. Verify:
open a pane, tap **Keys → Presets**, your buttons are there. Rejected row?
`journalctl --user -u nenu -n 20` names it and why.

### Your own quick replies

The Quick dock's one-tap phrases are yours to replace, in `quick-replies.toml` next to the other two:

```bash
cp quick-replies.toml.example "$(herdr plugin config-dir herdr.nenu)/quick-replies.toml"
```

```toml
[[replies]]
scope = "claude"             # optional; omit for every pane
title = "confirm"
items = ["yes", "no"]        # sent verbatim, one per button
```

A pane your rows match shows only your groups, in place of the shipped ones
([ADR 0018](../.adr/0018-operator-command-rows-replace-the-catalog.md)). The shipped phrases are
English (`yes`, `commit and push`); this is the way to work in another language, or to give a
harness that wants `approve` the word it wants. `scope = "shell"` reaches a plain shell pane, which
otherwise gets only `y`/`n`. No restart — edits are live. Verify: open a pane, open **⋯ → Quick replies**, your
groups are there. Rejected row? `journalctl --user -u nenu -n 20` names it and why.

### Several machines

Nenu can show the chats of every machine your Herdr has saved, under one URL: their chats in Home, the
sidebar and Search, New chat on any of them, and each chat read, sent to, stopped and started as one on
this machine is. It is off until you turn it on.

1. **Run Nenu on every machine**, this version or later. Each machine's Nenu reads its own agents' logs,
   files and git; the one you open reaches the others through them.
2. **Save the other machines in Herdr**, on the machine whose Nenu you open:
   `herdr machine add <ssh-target>` (for example `user@build-box`). `herdr machine list` shows them.
   Nenu keeps no list of its own.
3. **Make SSH work with no prompt** from that machine, as the Nenu service runs it: no terminal, and
   usually no SSH agent. It uses your `~/.ssh/config` and default keys, so either a key without a
   passphrase or Tailscale SSH works. An agent works only if its `SSH_AUTH_SOCK` is in Nenu's `.env`.
   The other machine's host key must already be trusted: connect once by hand (`ssh <ssh-target> true`).
4. **Check the network goes that way.** SSH has to reach each other machine from the one whose Nenu you
   open. A tailnet policy can let your own devices reach a server and still keep a tagged server away
   from a personal machine.
5. **Turn it on:** Settings → Machines → **Show other machines**. It applies to every device. On, this
   Nenu keeps one SSH connection to each machine Herdr saved; off, it opens none and reads Herdr's list
   only while Settings is on screen.

Each machine's state, in Settings and in the lists:

| State | Meaning | What to do |
|---|---|---|
| Connected | Its chats are listed and usable. | |
| Connecting… | SSH or its Nenu is being reached. | Wait a few seconds. |
| Not connected | SSH did not get there (ssh's own reason is shown), or Nenu there is not running. Nenu retries after 5 s, 15 s, 1 min, then every 5 min. | Check step 3 and 4, or start Nenu there. |
| Update Nenu there | That machine runs a Nenu older than this feature. | Update Nenu on that machine. |
| No Nenu there | SSH got there and found no Nenu. | Install Nenu there (step 1). |
| Disabled in Herdr | `herdr machine disable` was run for it. | `herdr machine enable <label>`. |
| Off | Show other machines is off. | Turn it on (step 5). |

- **Security.** A machine's Nenu answers other machines on a socket in its state dir that only its own
  user can open, whether or not its own setting is on. That adds no way in that SSH as that user did
  not already give, and a read-only device here stays read-only on every machine
  ([ADR 0084](../.adr/0084-machines-are-herdrs-reached-through-their-own-nenu.md)).
- If a machine's Nenu keeps its state somewhere else (`COLLIE_STATE_DIR`), export the same variable in
  that machine's shell profile, so the SSH probe finds it.
- `COLLIE_MACHINE_LABEL` names this machine in the lists (default: its host name).
- Herdr Organizations projects stay on the machine that runs them.

### Multi-session

`COLLIE_MULTI_SESSION=on` (the default) discovers and serves every named Herdr session under your
config root, switchable from the header; `COLLIE_MULTI_SESSION=off` serves only the primary one. Every
session it finds is drivable through the same URL — including a private or sandbox one, which is why
[Security](#%EF%B8%8F-security--read-before-you-run-it) lists this as a sharp edge.

## Dark mode / light mode

**Nenu follows your phone by default.** To pin it, open **Settings → Appearance** and pick
**System**, **Light** or **Dark** — per device, stored in the browser.

The terminal mirror is the exception: it always renders on a **dark ground** and light mode *inverts*
it rather than re-colouring it. Agents emit absolute colours chosen for a black terminal, and
inverting is what keeps the contrast they designed for
([ADR 0002](../.adr/0002-invert-the-light-terminal-mirror.md) has the measurement). So keep your
agents on a dark theme — a light-themed agent emits dark-on-light colours that are unreadable under
either appearance. (Installed on iOS, the status-bar text stays white in light mode; iOS gives web
apps no way to change that at runtime.)

## Commands

Every command works two ways: the **control script** on the host (`scripts/collie-ctl.sh <cmd>`) or
the equivalent **Herdr action** (`herdr plugin action invoke <cmd> --plugin herdr.nenu`, written
below as `invoke <cmd>`). The ones you'll actually use:

| Action | Control script | Herdr action |
| --- | --- | --- |
| **Start** — build if needed, serve, print the URL | `scripts/collie-ctl.sh start` | `invoke start` |
| **Stop** — pause the bridge; removes nothing | `scripts/collie-ctl.sh stop` | `invoke stop` |
| **Restart** | `scripts/collie-ctl.sh restart` | `invoke restart` |
| **Status** — the *Nenu is running* banner + URLs | `scripts/collie-ctl.sh status` | `invoke status` |
| **URL** — print the tailnet URL | `scripts/collie-ctl.sh url` | `invoke url` |
| **QR** — the same URL as a scannable code | `scripts/collie-ctl.sh qr` | — (script only) |
| **Version** — the running version (`0.x.y+sha`) | `scripts/collie-ctl.sh version` | `invoke version` |
| **Update** — advance the checkout + rebuild + restart | `scripts/collie-ctl.sh update` | `invoke update` |
| **Uninstall** — remove the service; keep `.env` + checkout | `scripts/collie-ctl.sh uninstall` | `invoke uninstall` |
| **Logs** — tail the journal / log file | `scripts/collie-ctl.sh logs` | — (script only) |
| **Push keys** — generate the VAPID keypair into your `.env` | `scripts/collie-ctl.sh push-keys` | `invoke push-keys` |
| **Push test** — send one notification to prove it works | `scripts/collie-ctl.sh push-test` | `invoke push-test` |

The actions are declared in `herdr-plugin.toml` and each one shells out to the control script; list
them live with `herdr plugin action list --plugin herdr.nenu`. `build` · `serve` · `unserve` are
script-only too.

`start` and `status` end with the **Nenu is running** banner — annotated line by line in
[First run](#first-run--what-youll-see). Its version comes from the *served* bundle stamp, so it is
the authoritative "what's running". **Through a Herdr action you get Herdr's JSON envelope, not the
banner** — the human-readable output is the action's *captured stdout*, read with
`herdr plugin log list --plugin herdr.nenu` (or run the control script directly to see it inline).

## Manage & update

### Stop or uninstall

Pause the bridge without removing anything (a later `start` brings it right back):

```bash
scripts/collie-ctl.sh stop      # or: herdr plugin action invoke stop --plugin herdr.nenu
```

To tear the service down completely — stop + disable it, remove the service definition (the
`systemd --user` unit, or the launchd agent plist on macOS), and remove
Nenu's own `tailscale serve` mapping (port-scoped, so other tailnet mappings on the host survive) —
use `uninstall`. It leaves your `.env` and the checkout untouched:

```bash
scripts/collie-ctl.sh uninstall # or: herdr plugin action invoke uninstall --plugin herdr.nenu
```

Then `herdr plugin uninstall herdr.nenu` (or, for a linked clone, just deleting the directory)
removes the plugin registration itself.

### Update to a new release

The checkout *is* the plugin, and Herdr has no `plugin update` of its own. One command does the lot:

```bash
scripts/collie-ctl.sh update    # or: herdr plugin action invoke update --plugin herdr.nenu
```

It advances the checkout, rebuilds the UI and restarts the bridge (re-execing itself, so it's safe
even when the update rewrites the script). Confirm via the footer build stamp. Pinned to a version
with `--ref`? Keep refreshing with `herdr plugin install --ref …`.

**`update` goes to the newest release of the major you are on, and never crosses one.** A major
means you have to change something, so it is never inherited from a routine update: the command says
a new major is out and names the one that takes it —

```bash
herdr plugin action invoke update-major --plugin herdr.nenu   # or: scripts/collie-ctl.sh update --major
```

The flag is the whole consent; there is no prompt, because a Herdr action has no terminal to answer
one on. The reasoning is [ADR 0020](../.adr/0020-a-major-upgrade-is-consented-by-flag.md).

Fails with *"You are not currently on a branch"*? That's a GitHub install made before 0.23.1, and
[Troubleshooting](#troubleshooting) has the one-time repair.

#### What `update` actually does to the checkout

The two install routes differ in *when* the UI builds — a GitHub install at install time, via the
manifest's `[[build]]` step; a linked clone on first `start`.

They also leave two different shapes on disk, which is what `update` has to cope with.
`herdr plugin install` doesn't clone: it fetches one commit and detaches onto it, so the checkout has
no branch. A linked clone sits on one, the way you'd expect.

One command handles both ([ADR 0006](../.adr/0006-update-advances-the-checkout-herdr-installed.md)):

- **Linked clone** (on a branch) — `git pull --ff-only`, then **re-links the plugin** so Herdr picks
  up any new actions and the new version.
- **`herdr plugin install`** (detached, shallow) — fetches the newest stable tag in the installed
  major and re-detaches onto it. `--depth 1` only if it is already shallow, so a full history is never truncated; `--force` so a
  lockfile the build rewrote can't wedge the *next* update. It deliberately does **not** re-link:
  linking re-registers the plugin as a local path, after which Herdr refuses `herdr plugin install` —
  which is your recovery path if this checkout ever breaks.

By hand: frontend (`web/`) → `collie-ctl.sh build` (live, no restart — served from disk); backend
(`bridge/`) → `systemctl --user restart nenu`. Run `scripts/install-hooks.sh` once to enable the
repo's pre-commit / pre-push checks.

## Major-version upgrades

A major release means the operator must change something. Routine updates remain inside the
installed major. Read the newer major's release notes and migration steps, then cross explicitly:

```bash
herdr plugin action invoke update-major --plugin herdr.nenu
```

### Surviving reboots

A `systemd --user` service only runs while you have a login session. On a host that should serve
Nenu unattended, enable lingering once:

```bash
loginctl enable-linger $USER
```

The unit is `enable`d, so with lingering it starts at boot with your user manager; the
`tailscale serve` mapping is persistent (`--bg`) and comes back on its own. Inspect the unit with
`systemctl --user status nenu`.

**On macOS there's nothing to enable.** `start` installs a launchd agent
(`~/Library/LaunchAgents/herdr.nenu.plist`) with `RunAtLoad`, so the bridge comes back when you log
in and launchd restarts it if it exits abnormally. Inspect it with
`launchctl print gui/$(id -u)/herdr.nenu`. It's a *LaunchAgent*, not a daemon, so it starts at
**login** rather than at boot — a Mac sitting at the login window is not serving Nenu. (Neither
supervisor? A `nohup` process with a pidfile in the config dir instead.)

## Deployment variants

The bridge always binds **loopback only**; what changes between deployments is *what sits in front
of it* and *how a request proves who it is*. Variant A is the default and sits below; the other four
are in [`DEPLOYMENT.md`](../DEPLOYMENT.md). Pick one.

### Variant A — `tailscale serve` + person identity (default)

The happy path from [Install](#install). `tailscale serve` terminates TLS on your MagicDNS name and
injects `Tailscale-User-Login`; set `COLLIE_TRUSTED_USER` to your tailnet login and the bridge
rejects anyone else.

```bash
# in your .env
COLLIE_TRUSTED_USER=you@example.com
```

- **Granularity:** the tailnet *person*, not the device.
- **Why it's safe on bare `tailscale serve`:** serve is the *trusted injector* of
  `Tailscale-User-Login` — it sets that header itself and a client can't forge it through the proxy.
- Nothing else to configure; origins match automatically on the MagicDNS name.

This is the right choice unless you specifically need per-device control. If you do, or if Tailscale
isn't in the path at all, [`DEPLOYMENT.md`](../DEPLOYMENT.md) has the rest:

- **[B — identity-aware proxy, authorised by device](../DEPLOYMENT.md#variant-b--identity-aware-proxy--per-device-authorisation)** — a proxy on this host; some devices drive, others watch.
- **[C — reverse proxy as the only front door](../DEPLOYMENT.md#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale)** — no Tailscale anywhere in the path.
- **[D — off-host identity proxy over the tailnet](../DEPLOYMENT.md#variant-d--off-host-identity-proxy-over-the-tailnet)** — one central ingress node fronting Nenu among your other services.
- **[E — any other mesh or tunnel](../DEPLOYMENT.md#variant-e--any-other-mesh-or-tunnel-netbird-zerotier-cloudflare-tunnel)** — NetBird, ZeroTier, Cloudflare Tunnel: you own the ingress, Nenu publishes nothing.

## Windows (experimental)

The **bridge** runs on Windows against Herdr's Windows beta; the **launcher** does not. Herdr there
exposes its control socket as a *named pipe* named after the full socket path, not an AF_UNIX
socket, so Nenu dials it through `node:net` instead of `Bun.connect` — one shim,
[`bridge/dial.ts`](../bridge/dial.ts), which explains the mapping at the top of the file.

What that means in practice:

- **Run the bridge directly** — `bun run bridge/index.ts`. There's no systemd unit, and the Herdr
  action buttons shell out to `bash`, so they only work if Git Bash is on `PATH`. The manifest
  therefore still declares `linux`/`macos` only, rather than advertising buttons that may not fire.
- **`tailscale serve` isn't wired up here.** Use the
  [Variant C](../DEPLOYMENT.md#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale) posture: loopback bind, your own ingress in front, `COLLIE_PUBLIC_HOSTS` pinned. The security
  rules in [§Security](#%EF%B8%8F-security--read-before-you-run-it) are not relaxed on Windows.
- **Set `COLLIE_MULTI_SESSION=off`** — session discovery derives POSIX paths.
- The socket path defaults to `%APPDATA%\herdr\herdr.sock`; override with `HERDR_SOCKET_PATH`
  (an explicit `\\.\pipe\…` value is passed through untouched).

**Want the lifecycle too?** The bridge has spoken Windows' named pipe since 0.15.0; a
community-maintained Task Scheduler setup (start/stop/update, no supported-tree guarantees) lives in
[`contrib/windows/`](../contrib/windows/README.md).

**Is it actually working?** The bridge logs `[events] stream up` on start — the event stream works
over the pipe, so Windows gets the same live updates as Linux, not degraded polling.

`COLLIE_HERDR_DIAL=net` forces that same dialer on Linux/macOS. It exists so the Windows code path
can be exercised — and regression-tested — without a Windows box; `bridge/dial.test.ts` uses it.

## Web Push (optional)

Off unless you opt in. Three steps, and nothing to install — the sender (`web-push`) is already an
optional dependency, installed by the build:

```bash
herdr plugin action invoke push-keys --plugin herdr.nenu   # 1. generate + write the VAPID keys
herdr plugin action invoke restart   --plugin herdr.nenu   # 2. the bridge reads them at start
#                                                              3. on your phone: Settings → notifications
```

Step 1 is the one that used to be fiddly. `push-keys` generates the keypair *and* writes
`COLLIE_VAPID_PUBLIC` / `_PRIVATE` into the `.env` the service actually reads, at mode 600.

**Worth one extra keystroke:** pass a *subject* — the contact address RFC 8292 wants, so a push
service has a way to reach whoever is sending. An action carries no arguments, so this form is the
shell one:

```bash
bash scripts/collie-ctl.sh push-keys mailto:you@example.com
```

Two behaviours worth knowing. It **refuses to replace keys that are already live** unless you pass
`--force`, because new keys invalidate every existing subscription: each device must re-enable
notifications, and until it does it silently receives nothing. But passing a subject on an
already-configured install is *not* that — it updates the contact address and leaves the keys alone,
so fixing a typo never costs you your subscribers.

> **On a Herdr install older than 0.8.0**, actions are the set cached when the plugin was installed
> ([ADR 0006](../.adr/0006-update-advances-the-checkout-herdr-installed.md)), so `push-keys` and
> `push-test` won't appear until the next `herdr plugin install`. Use
> `bash scripts/collie-ctl.sh push-keys` until then — it does the identical thing.

**Did it work?** Fire a notification at every subscribed device without waiting for an agent to
block:

```bash
bash scripts/collie-ctl.sh push-test                 # or: push-test "Title" "Body"
```

You should get it within a second or two. If it says push is disabled, the bridge didn't get the keys
— restart it (step 2). If it says there are no subscribed devices, step 3 hasn't happened on that
phone yet.

Push needs a **secure context (HTTPS)**, which any HTTPS-terminating front door provides — the
default `tailscale serve` (Tailscale manages the MagicDNS cert; nothing to obtain or renew) or a
[Variant C](../DEPLOYMENT.md#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale) proxy that
terminates TLS. Plain-HTTP modes (`COLLIE_SERVE_MODE=http`) are **not** a secure context, so the
browser won't even offer the subscribe button — Settings flags it `insecure`.

Nenu pushes when an agent **needs your input**, and when an agent **finishes something a person
asked**: a message you sent from Nenu, or text typed into a loose agent or a coordinator. It does not
push for Herdr Organizations' own back-and-forth (its inbox nudges and a coordinator's messages to
its threads) or, unless you switch them on, for a subagent's result or for an agent another agent
started with `herdr agent start <name>` (Nenu treats an agent with a Herdr name as one; a message you
send it from Nenu still notifies). Each agent gets its own
notification, and only once until you look at it in Nenu; **tapping it opens Nenu at that agent**.
Nothing is pushed while Nenu is open on a screen, and the app closes the notifications you have
handled when it opens. Settings → **Notify when** has Needs input, Replies to you, Agents started by an
agent, Subagent results and App updates.

## Troubleshooting

Symptoms below, in order — search the page for yours. **`Os { NotFound }` from `herdr plugin`** ·
**`update` says "not currently on a branch"** · **`tailscale serve failed`** · **isn't answering
(service won't start)** · **phone can't open the URL** · **page loads but stays empty (blank page,
403)** · **a password prompt won't take your reply** · **no push notifications** · **gone after a
reboot** · **`herdr plugin list` shows the old version** · **stale UI after a rebuild**.

**`herdr plugin …` fails with `Error: Os { code: 2, kind: NotFound, message: "No such file or
directory" }`** (plugin install fails, action invoke fails)**.** This is *not* a Nenu problem — it
means the **Herdr server isn't running**, so its CLI can't reach the control socket
(`~/.config/herdr/herdr.sock`). The tell is the *raw* `Os {…}`
error: a reachable server answers path/manifest problems with structured JSON (e.g.
`plugin_manifest_not_found`), so a bare `Os { NotFound }` is a failed socket connect, before Nenu
or your path is ever examined. It hits `link`, `install`, `action invoke` — every subcommand that
talks to the server — while `herdr plugin --help` still works (it never opens the socket). Fix: start
Herdr first (`herdr server &`, or just launch the Herdr TUI — it boots the server), confirm
`ls ~/.config/herdr/herdr.sock` now exists, then retry the install. `herdr plugin list` is a quick
probe: if it throws the same error, the server is down.

**`update` fails with `You are not currently on a branch`.** A GitHub install made before **0.23.1**
([upstream #63](https://github.com/AltanS/collie/issues/63)). `herdr plugin install` fetches one commit and
detaches onto it rather than cloning, so the old `update` — which ran `git pull` — had no branch to
pull into, and no install of that vintage could refresh itself. The fix ships inside the checkout it
repairs, so it takes one reinstall to land; `update` works normally from then on:

```bash
herdr plugin install frizynn/nenu --yes          # replaces the checkout, rebuilds the UI
herdr plugin action invoke restart --plugin herdr.nenu   # reinstall doesn't restart the service
herdr plugin action invoke version --plugin herdr.nenu   # expect 0.23.1 or newer
```

Your `.env` and `tailscale serve` state live in the plugin config dir, outside the checkout, so they
survive.

**`start` prints `note: tailscale serve failed`.** The bridge itself is fine (still up on
`127.0.0.1`) — only the tailnet ingress didn't come up, and the script prints tailscale's own error
right below the note. Usual causes: your user isn't the Tailscale operator
(`sudo tailscale set --operator=$USER`), the node is logged out (`tailscale up`), or — on
Headscale / `.internal` tailnet domains — HTTPS certs aren't available, which is exactly what
`COLLIE_SERVE_MODE=http` is for: set it in `.env`, then `scripts/collie-ctl.sh restart`. Verify with
`tailscale serve status`.

**Banner shows `⚠ Nenu isn't answering on :8787 yet`** (service won't start, connection
refused)**.** The service was started but the HTTP server isn't answering the probe. Check the unit
first — `systemctl --user status nenu` — then `scripts/collie-ctl.sh logs` (or
`journalctl --user -u nenu -f` to watch live) for why: most commonly the port is already taken
(set `COLLIE_PORT` in `.env`, then `scripts/collie-ctl.sh restart`, which also re-runs
`tailscale serve` against the new port) or the first build failed (the log says so; fix and run `scripts/collie-ctl.sh build`). The unit
auto-restarts every 5 s, so once the cause is fixed it usually comes back on its own.

**Phone can't open the tailnet URL.** Work down the list: (1) the phone runs the Tailscale app and
is *connected* to the same tailnet as the host; (2) you're opening the banner's `tailnet` URL
(`scripts/collie-ctl.sh url`), not the `local` one — `http://127.0.0.1:8787` only works on the host
itself; (3) MagicDNS is enabled in your tailnet's DNS settings (the URL is a MagicDNS name); (4) the
host is online — check `tailscale status` on the host, or ping the host from the phone's Tailscale
app; (5) **your tailnet policy actually admits a peer to this node** — if it doesn't, the banner now
says so under the `tailnet` line, and nothing else will: the front door is published correctly, the
cert is valid, and `curl` from the host itself returns 200, because loopback never touches the packet
filter. Two things make this one especially misleading — `tailscale ping` **succeeds** (disco pings
bypass ACLs), and blocked traffic is dropped rather than refused, so the phone just hangs and reads
as "server down". Fix it in your ACL policy (<https://login.tailscale.com/admin/acls> on Tailscale;
your policy file on Headscale). The check is best-effort and deliberately unsure of itself: it speaks
up only when this node's filter admits *nothing* — which can equally mean no other device has joined
the tailnet yet — and stays quiet whenever it can't tell.

**Page loads but stays empty** (blank page, white screen); **API calls fail
`403 cross-origin rejected`.** You're reaching Nenu through an origin the bridge doesn't expect — a
custom domain, or a proxy that rewrites `Host`. Allow the exact public origin with
`COLLIE_ALLOWED_ORIGINS` (see [Configure](#configure)), or make the proxy forward `Host` unchanged —
the fourth proxy requirement in
[`DEPLOYMENT.md`](../DEPLOYMENT.md#variant-b--identity-aware-proxy--per-device-authorisation).

**A `sudo` (or SSH passphrase, or `gpg`) prompt won't take your reply.** Use **⋯ → Type into
terminal** in the pane header, not Send. Send *verifies* what it typed by reading it back off the screen before it
presses Enter ([upstream #34](https://github.com/AltanS/collie/issues/34)), and a password prompt turns echo
off, so there is nothing to read back — typing into the terminal sends your keystrokes straight to the pane, Enter
included. Nothing you type that way is stored, echoed into a draft, or restored later, and the
moment Nenu recognises a password prompt it drops the stored draft too
([upstream #103](https://github.com/AltanS/collie/issues/103)).

**No push notifications arriving.** Fire one by hand: `bash scripts/collie-ctl.sh push-test`. Three
causes, in the order the command distinguishes them:
push says it's disabled (the keys never reached the bridge — run `push-keys` and restart, see
[Web Push](#web-push-optional)); it says there are no subscribed devices (this phone never enabled
them in Settings → notifications); or it reports a send and nothing arrives (the phone is on a
plain-HTTP origin, which is not a secure context — Settings flags it `insecure`).

**Nenu is gone after a reboot.** On Linux this is almost always lingering — see
[Surviving reboots](#surviving-reboots) for the one command. On macOS the launchd agent starts at
**login**, so check you're actually logged in (not sitting at the login window) and that the agent is
loaded: `launchctl print gui/$(id -u)/herdr.nenu`.

**`herdr plugin list` shows the old version after an `update`.** Expected — Herdr caches the manifest
it read at install or link time. The authority on what's running is the footer build stamp, or
`scripts/collie-ctl.sh version`. For a linked clone `update` re-links and that self-heals (force it
with `herdr plugin link "$(pwd)"`); on Herdr ≥0.8.0 the manifest is re-read from disk anyway.

**Phone shows a stale UI after a rebuild.** A PWA's service-worker cache is per-origin, so reaching
Nenu at two origins (a custom domain *and* the raw `host:8787`) gives you two installs, each
caching its own bundle. The footer **build stamp** (`vX.Y.Z · sha · time`) shows the bundle you're
running; the bridge reports what it serves via the legacy-compatible `X-Collie-Build` header and `/api/config`. On a
mismatch, the footer offers **"new build — tap to update."** Otherwise reopen the PWA a couple times
(the SW auto-updates) or clear that origin's site data. Best practice: **pick one HTTPS origin and
stick to it.** (Over plain HTTP the SW can't register — always fresh, but no PWA features.)

## Architecture

A small Bun process sits between your phone and Herdr — the browser never touches the socket.

```
  phone (PWA)
     │  HTTPS over the tailnet
     ▼
  tailscale serve        terminates TLS, injects the identity header
     │  127.0.0.1:PORT    (the bridge binds loopback only)
     ▼
  Nenu bridge (Bun)    serves the UI + a small JSON API; polls Herdr
     │  one-shot JSON-RPC over a Unix socket
     ▼
  Herdr server           owns the panes, agents and terminal state
```

Under [Variant C](../DEPLOYMENT.md#variant-c--reverse-proxy-as-the-only-front-door-no-tailscale) a
reverse proxy replaces the `tailscale serve` box; everything below the front door is identical.

- **One module touches the socket** (`bridge/herdr-client.ts`); everything else speaks the bridge's HTTP API.
- **Polling is still the model** — the bridge polls Herdr (via `session.snapshot`, one RPC per tick) and the browser polls `/api/snapshot`; a long-lived Herdr event stream only pokes the bridge's poll to go faster, it never replaces it. No resync logic.
- **Actions are plain HTTP** — a reply or key `POST`s to `/api/pane/:id/{reply,keys}` → Herdr `pane.send_keys`, which types into a real terminal (hence the security posture).
- **The UI is a static PWA** — Vite builds `web/dist`, served from disk, so a rebuild is live with no restart.

Full design rationale in [`ARCHITECTURE.md`](../ARCHITECTURE.md).

## Developing this plugin

Clone it and `herdr plugin link` it ([Install](#install) above), then edit in place.

- **The manifest is the plugin.** `herdr-plugin.toml` declares the actions listed in
  [Commands](#commands), and each one shells out to `scripts/collie-ctl.sh`. Both are
  commented — read them, not a paraphrase of them here.
- **One asymmetry in the dev loop:** `web/` rebuilds go live with no restart (the bridge serves
  `web/dist` from disk); `bridge/` changes need `systemctl --user restart nenu`. Build, test and
  versioning rules are in [`CLAUDE.md`](../CLAUDE.md) — versioning is hook-enforced, so skim it before
  your first commit.
- **Why a supervised service and not a plugin pane** — [`ARCHITECTURE.md`](../ARCHITECTURE.md) §3.
  That decision is why the manifest uses `[[actions]]` and `[[build]]` and nothing else.

Herdr's plugin system itself is upstream's to document:
[authoring](https://herdr.dev/docs/plugins/) ·
[CLI reference](https://herdr.dev/docs/cli-reference/) ·
[example plugins](https://github.com/ogulcancelik/herdr-plugin-examples).

## See also

- Deployment variants B–E — [`DEPLOYMENT.md`](../DEPLOYMENT.md)
- Design & rationale — [`ARCHITECTURE.md`](../ARCHITECTURE.md)
- Verified Herdr socket API — [`HERDR_API.md`](../HERDR_API.md)
- Ops, versioning & conventions — [`CLAUDE.md`](../CLAUDE.md)
- Changes — [`CHANGELOG.md`](../CHANGELOG.md)

Several machines under one URL: see [Several machines](#several-machines).
