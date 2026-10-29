<h1 align="center">
  <img src="assets/brand/nenu-banner.png" alt="Nenu — Herdr agent workbench for mobile and web" width="900">
</h1>

<p align="center">
  A fast, self-hosted interface for supervising your Herdr coding agents from mobile and web.
</p>

<p align="center">
  <a href="https://github.com/frizynn/nenu/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/frizynn/nenu/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/frizynn/nenu/releases"><img alt="Latest release" src="https://img.shields.io/github/v/release/frizynn/nenu?sort=semver"></a>
  <a href="LICENSE"><img alt="MIT License" src="https://img.shields.io/github/license/frizynn/nenu"></a>
  <img alt="Linux and macOS" src="https://img.shields.io/badge/host-Linux%20%7C%20macOS-18181b">
</p>

Nenu is a self-hosted workbench for [Herdr](https://herdr.dev), the terminal multiplexer for coding
agents. It shows every agent you run in Herdr (Claude Code, Codex, Pi, OpenCode, Grok) as a chat you
can read, answer and steer from your phone or browser, with the pull requests open on their branches.

The terminal stays the source of truth. Nenu reads each agent's own session log and screen, and every
action it takes is a keystroke into the same pane you would use at your desk. It runs on your machine
and is reached only inside your [Tailscale](https://tailscale.com) network. There is no Nenu account
and no hosted relay.

> [!WARNING]
> Nenu can type into terminal panes with your user permissions. Anyone who can control the app can
> run commands and read pane output. Never expose it with Tailscale Funnel or directly to the public
> internet. Read the [security model](docs/USER_GUIDE.md#%EF%B8%8F-security--read-before-you-run-it)
> before installation.

## What it provides

| Area | What you get |
| --- | --- |
| Conversations | Each agent as a chat: its answers, compact thinking and tool calls, files and photos it touched, subagents it started, context and account usage. Start Claude Code or Codex in any folder, recover a session's history, stop a running turn. |
| Answering | Approve or deny permission prompts, pick menu options, reply, queue messages, type special keys or straight into the terminal, attach images. Every send is verified against the screen. |
| Workspaces | Herdr's workspaces, tabs and panes as Home's lists and the sidebar's tree, each opening on its pane, with the open pull requests from GitHub on each session's branch. |
| Rendering | Markdown, tables with Copy, LaTeX math, images, PDFs and sandboxed offline HTML previews. A `file://` path in an answer opens the file. |
| Phone | An installable PWA built for one hand: native navigation, a folder picker for new agents, a composer that leaves room for the keyboard. |
| Notifications | Optional Web Push that says who finished, what it answered and where, with one switch per kind (needs input, replies to you, agents another agent started, subagent results, app updates) and one per agent, set from its ⋯ menu or a terminal. |
| Access | Loopback bind behind `tailscale serve` or a conforming reverse proxy, identity and per-device gates, strict CSP. |

Nenu preserves Herdr and the underlying agent CLIs. It does not replace their runtime, permissions,
or model authentication.

## Requirements

- [Bun](https://bun.sh)
- [Herdr](https://herdr.dev) 0.7.0 or newer
- [Tailscale](https://tailscale.com) for the recommended private-network setup
- Linux or macOS as the host; Windows support is experimental

## Install

Run this on the machine where Herdr and your coding agents are running:

```bash
herdr plugin install frizynn/nenu
herdr plugin action invoke start --plugin herdr.nenu
herdr plugin action invoke url --plugin herdr.nenu
```

Open the printed HTTPS URL on a device connected to the same tailnet. On iPhone, use
**Share → Add to Home Screen** to install the PWA.

The plugin ID is `herdr.nenu` since 1.0 (it was `herdr.collie`). An install from before 1.0 carries
its config and service over on the first `start` after the update. Internal names such as `COLLIE_*`
settings, `collie-ctl.sh` and the state directory keep the old name so existing setups keep working
([ADR 0068](./.adr/0068-the-plugin-is-herdr-nenu-and-internal-names-stay.md)).

For a development checkout:

```bash
git clone https://github.com/frizynn/nenu.git
cd nenu
bun install --frozen-lockfile
cd web && bun install --frozen-lockfile && cd ..
herdr plugin link "$(pwd)"
herdr plugin action invoke start --plugin herdr.nenu
```

See the [complete user guide](docs/USER_GUIDE.md) for configuration, first-run output, Web Push,
updates, uninstalling, and troubleshooting.

To finish the setup with Claude Code or Codex, link the
[onboarding skill](skills/nenu-onboarding/SKILL.md) from the plugin checkout and run it on this
host. It checks the bridge, the tailnet front door, the access gates, Web Push, the Claude hooks and
status line, your operator files and updates, reports what is done and what is missing, and offers
to complete each missing item through the plugin actions:

```bash
ROOT="$(herdr plugin list --json | jq -r '.result.plugins[] | select(.plugin_id == "herdr.nenu") | .plugin_root')"
mkdir -p ~/.claude/skills ~/.codex/skills
ln -s "$ROOT/skills/nenu-onboarding" ~/.claude/skills/   # Claude Code: /nenu-onboarding
ln -s "$ROOT/skills/nenu-onboarding" ~/.codex/skills/    # Codex: $nenu-onboarding
```

## Common operations

```bash
herdr plugin action invoke status  --plugin herdr.nenu
herdr plugin action invoke restart --plugin herdr.nenu
herdr plugin action invoke update  --plugin herdr.nenu
herdr plugin action invoke stop    --plugin herdr.nenu
```

A routine update stays within the installed major version. Read the release notes before crossing a
major version, then use the explicit `update-major` action.

Choose which agents send notifications. A new agent starts on only when its pane runs in a
supervisor's folder (`COLLIE_NOTIFY_SUPERVISORS`, by default `~/.firstmate/*,~/Developer/firstmate`);
the agent's ⋯ menu has the same switch:

```bash
herdr plugin action invoke notify-list --plugin herdr.nenu   # every agent, on or off, and why
herdr plugin action invoke notify-off  --plugin herdr.nenu   # the pane focused in Herdr
herdr plugin action invoke notify-on   --plugin herdr.nenu
ROOT="$(herdr plugin list --json | jq -r '.result.plugins[] | select(.plugin_id == "herdr.nenu") | .plugin_root')"
bash "$ROOT/scripts/collie-ctl.sh" notify off <pane-id-or-name>   # any agent, by pane id or name
```

See [Which agents notify](docs/USER_GUIDE.md#which-agents-notify) for the rule and its limits.

## Documentation

| Document | Purpose |
| --- | --- |
| [User guide](docs/USER_GUIDE.md) | Security, installation, configuration, operation, updates, push, and troubleshooting |
| [Deployment guide](DEPLOYMENT.md) | Tailscale Serve, reverse proxies, access gates, and multi-instance deployment |
| [Architecture](ARCHITECTURE.md) | Components, data flow, state, security boundaries, and design decisions |
| [T3 workbench notes](docs/WORKBENCH.md) | Scope and attribution for the native conversation interface |
| [Herdr API notes](HERDR_API.md) | Verified socket behavior used by the bridge |
| [Harness adapter guide](HARNESS_CONTRIBUTING.md) | Adding or maintaining terminal-agent adapters |
| [Contributing](CONTRIBUTING.md) | Development workflow, checks, commits, and pull requests |
| [Release guide](docs/RELEASING.md) | Versioning, release validation, publication, and rollback |
| [Security policy](SECURITY.md) | Supported versions and private vulnerability reporting |
| [Changelog](CHANGELOG.md) | Curated user-facing changes by version |

## Development

```bash
bun install --frozen-lockfile
cd web && bun install --frozen-lockfile && cd ..
bun run build
bun run test
cd web && bun run test
```

The bridge is TypeScript on Bun. The client uses React, React Router, Vite, Tailwind CSS, and a
small service worker. Frontend builds are served from `web/dist`; bridge changes require a service
restart. Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Releases

Nenu follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html). A change the operator must act
on ships only in a major version, with the upgrade command in its release notes. Every published
version has:

1. matching versions in the Herdr manifest and both package manifests;
2. a curated entry in [CHANGELOG.md](CHANGELOG.md);
3. a validated commit reachable from `main`;
4. a single annotated `vX.Y.Z` tag; and
5. a GitHub Release created only after version checks, tests, and the production build pass.

Subscribe to [GitHub Releases](https://github.com/frizynn/nenu/releases) for update notifications.
Maintainers should follow [docs/RELEASING.md](docs/RELEASING.md); never push inherited tags in bulk.

## Project status

Nenu 1.0 is a stable, single-operator, self-hosted tool. Breaking operator changes ship only in a
major version. The compatibility surface includes the Herdr plugin actions, environment variables,
stored state, and the bridge HTTP API.

## Acknowledgements

Nenu stands on the work of two open-source projects:

- [Collie](https://github.com/AltanS/collie), created by
  [Altan Sarisin](https://github.com/AltanS), is the project Nenu originated from. Its Herdr bridge,
  self-hosted PWA, Tailscale access, notifications, and guarded terminal controls form Nenu's
  foundation.
- [T3 Code](https://github.com/pingdotgg/t3code), by
  [T3 Tools](https://github.com/pingdotgg), inspired Nenu's conversation-first presentation. Nenu
  includes MIT-licensed adaptations of its visual hierarchy, model controls, command completion,
  work grouping, context display, and compact notifications.

Nenu remains an independent community project and is not affiliated with or endorsed by either
upstream project. Original copyright, license text, adapted-file details, and vendored dependency
notices are preserved in [LICENSE](LICENSE) and
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Contributing and support

Bug reports and focused pull requests are welcome. Use the issue templates, avoid posting terminal
output that contains secrets, and read [CONTRIBUTING.md](CONTRIBUTING.md). Usage questions belong in
[GitHub Discussions](https://github.com/frizynn/nenu/discussions); reproducible defects belong in
[Issues](https://github.com/frizynn/nenu/issues).

Security vulnerabilities must follow [SECURITY.md](SECURITY.md) and must not be reported publicly.

## License

Nenu is available under the [MIT License](LICENSE). Original copyright and third-party notices are
preserved.
