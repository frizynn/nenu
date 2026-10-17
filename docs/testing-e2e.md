# E2E bench: test bridge, fake Herdr, WebKit

This bench checks a change against the real bridge and the real web build without touching the
live service, a real Herdr or a real terminal. Everything lives in `scripts/e2e/` and
`bridge/test-support/fake-herdr.ts`.

## Setup

```sh
cd scripts/e2e && bun install     # playwright-core 1.60.0, pinned, same 7-day cooldown as the repo
cd web && bun run build            # the bridge serves web/dist
```

`playwright-core` downloads no browser. It uses the WebKit already in Playwright's cache
(`~/Library/Caches/ms-playwright` on macOS, `${XDG_CACHE_HOME:-~/.cache}/ms-playwright` on Linux;
revision 2287 for 1.60.0), or `$PLAYWRIGHT_BROWSERS_PATH`. Root
`tsc` does not need it installed, because `scripts/e2e/browser.ts` loads it with a computed import.

## Commands

| Command | What it does |
|---|---|
| `bun scripts/e2e/bridge.ts --port 8797 --fake` | Runs `bridge/index.ts` on 8797 against a FakeHerdr, until Ctrl-C |
| `bun scripts/e2e/bridge.ts --port 8797 --herdr` | Same, against a real Herdr server it starts under its own temporary HOME, and stops with the bridge |
| `bun scripts/e2e/bridge.ts --port 8797 --socket <path>` | Same, against a disposable real Herdr you started, once it proves isolated (below) |
| `bun scripts/e2e/run.ts smoke` | Home screenshots in WebKit at 390x844 (iPhone, @3x) and at 1440x900 |
| `bun scripts/e2e/run.ts stop` | Stop on the working Claude, phone and desk: captures, Escapes sent, a queued message held |
| `bun scripts/e2e/run.ts baseline [--seconds 60] [--sends 5]` | Measures the baselines below |
| `bun scripts/e2e/run.ts inspector [--before]` | A desk session's panel: each tab, folded, ⋯ Project, a session switch, light, a pane with no PR, and the reads each step made |
| `bun scripts/e2e/project-panel.ts [--before] [--idle-only \| --notes]` | A desk's Project panel on a project coordinator's chat: each view in dark and light, a pull request's diff, the panel folded and opened again, the same views against an Organizations without `task list` and `project show`, then idle CPU, memory and DOM. Organizations is `fake-org.ts`, so the run lists the exact argv Nenu ran. `--notes` takes only Notes, at 1440 and 1024 wide (the narrowest desk) in dark and light, against three Organizations: with `project status`, with `task list` only, and with neither. It then opens the problems and Done, and captures 900 wide, where a desk's panel is not drawn |
| `bun scripts/e2e/run.ts surface [--seconds 60]` | Home, a session, a project, Settings, Search, the drawer and the collapsed rail with five projects, phone and desk, dark and light; then idle CPU, resident memory and DOM elements of one fresh WebKit per view (give it a private `PLAYWRIGHT_BROWSERS_PATH` so another bench's WebKit stays out of the count) |
| `bun scripts/e2e/run.ts chat [--seconds 60]` | A finished Claude conversation (tool calls, `turn_duration`, pull request links) on phone and desk, dark and light, folded and open; a third turn while it runs and once it ends; then a long one's DOM elements, idle CPU and memory in a WebKit of its own (private `PLAYWRIGHT_BROWSERS_PATH`, as for `surface`) |
| `bun scripts/e2e/run.ts scroll` | A long chat on a phone whose turn keeps running, read at the tail, up the thread, typed into, with the keyboard open and closed, paging older messages, through a sheet and back from Home: every write to the list's scroll position with its stack, and each move of the line being read that the reader's own drag does not explain |
| `bun scripts/e2e/diff-comments.ts [--before]` | Comments on a diff's lines, phone and desk, dark and light: the "+" on hover, the box, the line marked, the chips over the thread's composer, the diff of another thread opening its chat, and the one message the FakeHerdr received |
| `bun scripts/e2e/start-agent.ts [--before] [--seconds 60]` | A shell's start block, phone and desk, dark and light: at the prompt folded and unfolded, a tap on the terminal folding it, a long command that takes the terminal (the block leaves and the mirror keeps its tail), back at the prompt; Claude Code started on Ask and Codex on Auto with the argv the FakeHerdr received, and a start that times out. The block's height and the terminal's visible height at each step, then the Herdr calls one phone makes for the open shell while idle. `--before` takes the shell views only |
| `bun scripts/e2e/keyboard.ts [--runs 3] [--label NAME]` | The chat's draft tapped on a phone with the keyboard rising as Safari on iOS does it: a stand-in `visualViewport`, the page scrolled as WebKit reveals a focus without `preventScroll`, the viewport's events only once the keyboard is up. Per frame, where the header and the composer stand on screen, then after it settles and once it closes, for an empty draft and a four-line one; the focus, the caret and the layout are WebKit's own, the keyboard and the scroll are the model's. Captures the region above the keyboard, and the desk's chat to compare across builds |
| `bun scripts/e2e/coordinator-start.ts --org-bin <herdr-organizations> [--harness claude\|codex] [--runs 3] [--choose "Claude Code:sonnet:low"] [--light]` | Start coordinator against the `--herdr` server and that real Organizations over the bench's empty registry, with a real agent signed in by links into the operator's credentials (below). Each run makes a fresh project, taps Start and the window's Start, and records in the page when it showed "Starting", what each snapshot said about the coordinator and when the chat opened; outside it, when Organizations recorded the pane and when Herdr saw the agent. `--choose` fills the window and reports the agent's own argv. `--fake` instead captures the window and a refused Start against fake-org.ts, phone and desk, dark and light |
| `bun scripts/e2e/coordinators.ts [--port 8863] [--out DIR]` | A project that organizes coordinators (ADR 0092), Google Chrome headless at 390 and 1440: + lists the projects, a project its coordinators with New coordinator, a pick opens that chat and a new coordinator opens its own; the project page folded and open on a card; Move. Organizations is `fake-org.ts`, so the run checks the exact `node start` and `node move` argv |
| `bun scripts/e2e/asks-answer.ts [--before] [--port 8863] [--out DIR]` | Your asks and a coordinator's card against a registry shaped like a real one (ADR 0093), Google Chrome headless at 390 and 1440: a placeholder line gone from the list and the count, links as chips, the selectors narrowing it, and Answer through fake-org's `asks answer` with the exact argv. `--before` only captures |
| `bun scripts/e2e/run.ts compare A.png B.png` | Share of differing pixels between two captures |

Output goes outside the repo: `--out DIR`, else `$NENU_E2E_OUT/<stamp>`, else
`nenu-e2e/<stamp>` in the same user cache dir. `NENU_E2E_KEEP=1` keeps the test bridge's temp dir (state,
journals, `bridge.log`).

## Isolation

- `bridge.ts` refuses port 8787 (the live service) and any Herdr socket that is the default one, sits
  under its config dir (named sessions), or equals the shell's inherited `HERDR_SOCKET_PATH`. Inside
  a Herdr pane that variable names the live server, so the bench never uses it.
- A socket of its own does not isolate a real Herdr. Herdr keeps `session.json` in its config dir,
  `$XDG_CONFIG_HOME/herdr` or else `~/.config/herdr`, whatever `HERDR_SOCKET_PATH` and
  `HERDR_CONFIG_PATH` say. A server started with only those two read and rewrote the operator's
  `session.json` and restored every live workspace as fresh shells (2026-10-14). So `--socket` finds
  the process serving the socket (`lsof`), reads its environment (`ps -E` on macOS,
  `/proc/<pid>/environ` on Linux) and refuses unless it has an `XDG_CONFIG_HOME` that is not the
  operator's. When the environment cannot be read, it refuses too. `bridge.test.ts` covers both.
- `--herdr` starts that server itself: `herdr server` with the bench's temporary `HOME`, the `XDG_*`
  dirs under it, its own socket, no inherited `HERDR_*` or `COLLIE_*`, the operator's `PATH` without
  the bridge's stubs, and `DISABLE_AUTOUPDATER=1` so an agent started in a pane never updates the
  operator's install. The bridge reads Claude and Codex journals from that same `HOME`, so an agent
  started in a pane shows its conversation, turn state and send check. Ctrl-C stops both.
- Starting Herdr by hand instead, give it the same isolation and keep proof of it:
  `HOME=<tmp>/home XDG_CONFIG_HOME=<tmp>/home/.config HERDR_SOCKET_PATH=<tmp>/herdr.sock herdr server`.
  Copy `~/.config/herdr/session.json` before and `cmp` it after. The live Herdr rewrites it on its
  own, so a difference is yours only if it lists the disposable workspaces.
- The child bridge inherits no `COLLIE_*` or `HERDR_*` variable. `HERDR_PLUGIN_STATE_DIR` alone
  would point it at the live service's state. State, config and every journal root
  (Claude, Codex, pi, OpenCode, Grok) go to a temp dir, and multi-session is off.
- `HOME` is a temp dir too, and so are `HERDR_PROJECTS_ROOT` (an empty project registry),
  `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `GROK_HOME` and the `XDG_*` dirs. The
  bridge therefore never lists the operator's projects or skills, and the Codex pane answers "Codex
  server is unavailable" instead of dialing the live Codex app-server. `bridge.test.ts` checks both.
- The CLIs the bridge runs are stubs placed first on `PATH`. `herdr-organizations` answers "no
  templates" and `claude agents` fails, so Claude session discovery never sees real processes.
  `gh` never reaches GitHub: it prints the JSON file named by `NENU_E2E_GH_PRS` (the output of
  `gh pr list --json …`), or fails. With that variable set the demo panes' folder is a fresh git
  repo on branch `e2e-demo`, so Home's "Ready to review" shows those pull requests.
  `PATH` itself is inherited, and so is everything outside the bridge process: the FakeHerdr and
  the browser run in the bench's own process.
- The FakeHerdr counts calls by method and keeps a log of every call for the whole run (resetting
  the counters leaves it alone). `smoke` and `baseline` print `unexpectedWrites`. `smoke` exits 1 on
  any write or on any project in the snapshot. `baseline` allows only the writes it drives itself:
  `send_text` and `send_keys` on the idle pane, `send_keys` on the blocked one.

## A real agent in the disposable Herdr

The panes of a `--herdr` server run under the temporary `HOME`, so an agent there starts with no login
and no onboarding. What the 2026-10-14 long-send check used, all inside that `HOME`:

- `claude` must be the process name Herdr sees, or the pane gets no agent: link the version you want
  as `<home>/bin/claude` and put that dir first on the pane's `PATH`. A pinned version runs as it is;
  `DISABLE_AUTOUPDATER=1` is already in the server's environment.
- macOS keeps Claude's login in the keychain, which is found through `HOME`: a link from
  `<home>/Library/Keychains` to your own keychain dir lets the pane's Claude use it. A
  `<home>/.claude.json` with `hasCompletedOnboarding` and the work folder's
  `hasTrustDialogAccepted` skips the first-run screens.
- Herdr learns a pane's Claude session from Herdr's Claude hook. Without it the pane reports no
  session, so Nenu shows no conversation and the queue is unavailable. Once `claude` has run (it
  creates `<home>/.claude`), install the hook under that `HOME` and restart `claude`:
  `HOME=<home> XDG_CONFIG_HOME=<home>/.config HERDR_SOCKET_PATH=<tmp>/herdr.sock herdr integration install claude`.
- Codex reads `<home>/.codex/auth.json`; a link to yours logs it in.
- Drive the panes with `HERDR_SOCKET_PATH=<tmp>/herdr.sock herdr pane …` from your shell, never
  with the inherited variable.

## Comparing captures

`smoke` pins the clock. The bridge (through `clock-shift.ts`, preloaded), the demo journals and the
browser all start at 2026-10-10 14:00 UTC and tick from there, in the UTC time zone and the `en-US`
locale. The greeting, the date and the 12-hour activity chart are therefore the same whenever the
capture is taken. Two back-to-back runs measured 0% differing pixels on both captures. What can
still move is the working pane's elapsed seconds, which depend on how long the page took to load.
`baseline` does not pin the clock, so its timers run as they do on a real phone.

## FakeHerdr

`bridge/test-support/fake-herdr.ts` is a real Unix socket server with Herdr's newline-delimited JSON:
one request per connection, `events.subscribe` streaming. It answers `session.snapshot`,
`workspace.list`, `tab.list`, `pane.list`, `pane.get`, `pane.read`, `pane.process_info`,
`pane.wait_for_output`, `pane.send_text`, `pane.send_keys` and `agent.start`. `pane.wait_for_output` re-reads the
screen every 5 ms until a line matches (a leading `(?m)` becomes a JavaScript flag) or `timeout_ms`
ends it with the code `timeout`, as Herdr 0.9.1 does, so the guarded send takes its trigger path
here too. Anything else returns Herdr's `unknown variant` error, which
also logs the call as a write. It reports version `0.9.1-fake`, protocol 22.

Panes render a Claude-shaped screen (rule, `❯ draft`, rule, footer); a pane with no agent renders a
shell instead, its prompt or, while `setForeground` names a command, nothing below the output. Its
`pane.process_info` reports the shell's own process group at the prompt and the command's otherwise,
as Herdr 0.9.3 does. `agent.start` records the argv in `started` and turns the shell into that agent,
refuses a busy shell with Herdr's `agent_pane_busy`, and fails once with `failNextStart`. Typed text appears after
`echoMs`, Enter submits the draft, and a working pane repaints its spinner every `tickMs` (250 ms).
`setDialog` shows a dialog that swallows text, and a digit, Enter or Escape answers it.
`setStatus` emits `pane_agent_status_changed` to subscribers. A working pane names `esc to interrupt`
in its statusline, as Claude 2.1.296 does, and Escape sets it idle after `interruptMs` (0 by default). The demo herd
(`scripts/e2e/scenario.ts`) has these panes:

- a working Claude whose journal grows every 2 s
- an idle Claude
- a blocked Claude showing the captured `claude--permission-bash` dialog
- a Codex pane
- a shell

## Baselines, 2026-10-10 (before the redesign)

MEASURED with `bun scripts/e2e/run.ts baseline` (60 s windows, one WebKit phone per view)
against the FakeHerdr on this Mac. Two runs. Values are per phone. The phone and the bridge share
a host, so there is no network RTT. These numbers count requests and choreography, not real phone
latency.

| View (agent working unless noted) | HTTP req/min, run 1 | run 2 | By route (run 1) | Herdr calls/min (run 1) | Bridge CPU (run 1) |
|---|---|---|---|---|---|
| No client | 0 | 0 | | 5 snapshot + 15 pane.read | 0.1% |
| Home | 6 | 6 | 6 snapshot | 5 snapshot + 15 read | 0.2% |
| Chat view, Claude working | 81 | 81 | 40 history, 15 snapshot, 15 pane, 6 queue, 5 subagents | 30 read, 6 pane.list, 5 snapshot | 0.4% |
| Terminal mirror, Claude working | 85 | 85 | 40 snapshot, 40 pane, 5 subagents | 55 read, 5 snapshot | 0.4% |
| Dialog on screen (blocked) | 96 | 96 | 40 snapshot, 40 pane, 6 queue, 5 history, 5 subagents | 55 read, 6 pane.list, 5 snapshot | 0.5% |

- Socket calls per bridge poll, no client: 4 (1 `session.snapshot` + 3 `pane.read`).
  The bridge polls about 5 times a minute because the event stream is up and the cadence relaxes to 12 s.
- Send, tap to Enter, idle Claude, 5 sends: run 1 p50 113 ms, max 125 ms. Run 2 p50 103 ms, max 119 ms. Each send
  makes 5 HTTP requests before Enter lands: 2 `queue` (the POST and a re-read), 1 snapshot,
  1 pane, 1 history. The idle send goes through the bridge queue, not the direct reply route.
- Dialog answer ("1. Yes" on the permission dialog): run 1 took 2 HTTP requests before the key
  landed (1 pane re-read and 1 `keys`), 45 ms from tap to key. Run 2 also took 2 requests, 30 ms.
  10 requests within 2 s of the tap.
- The planning estimate of about 76 req/min for the chat view, which was INFERRED from code,
  measures at 81. The extra 5 are the subagents poll.

## Baselines, 2026-10-10 (after the redesign)

MEASURED with the same command on `feat/rediseno-herdr-20261010` at `8b8267dc`, two runs
(09:05 and 09:11 UTC), same host and method. The two runs agree within one request per minute.

| View (agent working unless noted) | HTTP req/min, run 1 | run 2 | By route (run 1) | Herdr calls/min (run 1) | Bridge CPU (run 1) |
|---|---|---|---|---|---|
| No client | 0 | 0 | | 5 snapshot + 3 pane.read | 0.2% |
| Home | 18 | 18 | 6 snapshot, 6 interactions, 6 activity | 5 snapshot + 9 read | 0.3% |
| Chat view, Claude working | 59 | 59 | 30 history, 6 snapshot, 6 pane, 6 queue, 6 interactions, 5 subagents | 15 read, 6 pane.list, 5 snapshot | 0.5% |
| Terminal mirror, Claude working | 77 | 77 | 66 pane, 6 snapshot, 5 subagents | 365 read, 5 snapshot | 0.7% |
| Dialog on screen (blocked) | 34 | 34 | 6 snapshot, 6 pane, 6 queue, 6 interactions, 5 history, 5 subagents | 311 read, 6 pane.list, 5 snapshot | 0.4% |

- The phone sends `?watch=` while the mirror or a dialog is on screen, so the socket rate of those
  two views is set by the bridge watcher (`bridge/pane-watcher.ts`), not by the phone's poll. It
  reads the watched pane several times a second, which is why `pane.read` went from 55 to about
  300 a minute while HTTP fell. The mirror's 66 `pane` requests a minute follow the watcher's change events (inferred), and the
  fake's spinner repaints at 4 Hz, so that number tracks the fake, not a real Claude.
- Socket calls per bridge poll, no client: 1.6 (1 `session.snapshot` + 0.6 `pane.read`), down
  from 4.
- Send, tap to Enter, idle Claude, 5 sends: run 1 p50 93 ms, max 110 ms. Run 2 p50 91 ms, max 126 ms.
  Each send is 1 HTTP request (`/send`). These runs predate `pane.wait_for_output` in the
  FakeHerdr: the first send's wait was refused as an unknown method and the trigger then stayed off,
  so they time the polling fallback, not the trigger path a real Herdr 0.9.1 takes.
- Dialog answer: 1 HTTP request before the key (`interactions/…/answer`), 41 ms and 35 ms.
  16 and 15 requests within 2 s of the tap.

Caveats:

- WebKit is not an installed iOS PWA. Background throttling, the service worker and real radio RTT
  are not modeled.
- The fake screen ticks at 4 Hz. Real working Claude panes measured between 1 and 4.5 changes/s.
- CPU is the bridge process only, from `ps` time deltas, at one-decimal resolution.
