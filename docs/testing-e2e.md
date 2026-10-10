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
| `bun scripts/e2e/bridge.ts --port 8797 --socket <path>` | Same, against a disposable real Herdr session |
| `bun scripts/e2e/run.ts smoke` | Home screenshots in WebKit at 390x844 (iPhone, @3x) and at 1440x900 |
| `bun scripts/e2e/run.ts baseline [--seconds 60] [--sends 5]` | Measures the baselines below |
| `bun scripts/e2e/run.ts compare A.png B.png` | Share of differing pixels between two captures |

Output goes outside the repo: `--out DIR`, else `$NENU_E2E_OUT/<stamp>`, else
`nenu-e2e/<stamp>` in the same user cache dir. `NENU_E2E_KEEP=1` keeps the test bridge's temp dir (state,
journals, `bridge.log`).

## Isolation

- `bridge.ts` refuses port 8787 (the live service) and any Herdr socket that is the default one, sits
  under its config dir (named sessions), or equals the shell's inherited `HERDR_SOCKET_PATH`. Inside
  a Herdr pane that variable names the live server, so the bench never uses it.
- The child bridge inherits no `COLLIE_*` or `HERDR_*` variable. `HERDR_PLUGIN_STATE_DIR` alone
  would point it at the live service's state. State, config and every journal root
  (Claude, Codex, pi, OpenCode, Grok) go to a temp dir, and multi-session is off.
- `HOME` is a temp dir too, and so are `HERDR_PROJECTS_ROOT` (an empty project registry),
  `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, `PI_CODING_AGENT_DIR`, `GROK_HOME` and the `XDG_*` dirs. The
  bridge therefore never lists the operator's projects or skills, and the Codex pane answers "Codex
  server is unavailable" instead of dialing the live Codex app-server. `bridge.test.ts` checks both.
- The two CLIs the bridge runs are stubs placed first on `PATH`. `herdr-organizations` answers "no
  templates" and `claude agents` fails, so Claude session discovery never sees real processes.
  `PATH` itself is inherited, and so is everything outside the bridge process: the FakeHerdr and
  the browser run in the bench's own process.
- The FakeHerdr counts calls by method and keeps a log of every call for the whole run (resetting
  the counters leaves it alone). `smoke` and `baseline` print `unexpectedWrites`. `smoke` exits 1 on
  any write or on any project in the snapshot. `baseline` allows only the writes it drives itself:
  `send_text` and `send_keys` on the idle pane, `send_keys` on the blocked one.

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
`pane.send_text` and `pane.send_keys`. Anything else returns Herdr's `unknown variant` error, which
also logs the call as a write. It reports version `0.9.1-fake`, protocol 22.

Panes render a Claude-shaped screen (rule, `❯ draft`, rule, footer). Typed text appears after
`echoMs`, Enter submits the draft, and a working pane repaints its spinner every `tickMs` (250 ms).
`setDialog` shows a dialog that swallows text, and a digit, Enter or Escape answers it.
`setStatus` emits `pane_agent_status_changed` to subscribers. The demo herd
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

Caveats:

- WebKit is not an installed iOS PWA. Background throttling, the service worker and real radio RTT
  are not modeled.
- The fake screen ticks at 4 Hz. Real working Claude panes measured between 1 and 4.5 changes/s.
- CPU is the bridge process only, from `ps` time deltas, at one-decimal resolution.
