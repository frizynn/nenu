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

Nenu turns live terminal sessions managed by [Herdr](https://herdr.dev) into a focused web
workbench. It renders conversations, model controls, tool activity, prompts, context usage, skills,
and documents as native UI while keeping the terminal session as the source of truth.

Nenu runs on your machine and is normally exposed only inside your
[Tailscale](https://tailscale.com) network. There is no Nenu account and no hosted relay.

> [!WARNING]
> Nenu can type into terminal panes with your user permissions. Anyone who can control the app can
> run commands and read pane output. Never expose it with Tailscale Funnel or directly to the public
> internet. Read the [security model](docs/USER_GUIDE.md#%EF%B8%8F-security--read-before-you-run-it)
> before installation.

## What it provides

- Conversation-first timelines with compact thinking and tool-call groups.
- Automatic Herdr Projects discovery, with project overviews, coordinators, and thread status.
- A per-chat files and photos browser for references in the available conversation history.
- A Stop control for interrupting an active Codex turn without closing its terminal.
- Local, cached model and reasoning selectors for Codex CLI and Claude Code.
- Searchable skills and command palettes tailored to each agent.
- Context-window and reported-usage visibility.
- Native rendering for Markdown, images, PDFs, and sandboxed offline HTML previews.
- Guarded replies, approvals, special keys, direct typing, and image uploads.
- Mobile-safe navigation, installable PWA support, and optional push notifications.
- Multi-session discovery from one bridge, with per-device write authorization available behind a
  conforming proxy.

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
herdr plugin action invoke start --plugin herdr.collie
herdr plugin action invoke url --plugin herdr.collie
```

Open the printed HTTPS URL on a device connected to the same tailnet. On iPhone, use
**Share → Add to Home Screen** to install the PWA.

The plugin ID remains `herdr.collie` for compatibility with existing installations. Product copy,
icons, metadata, and release names use Nenu.

For a development checkout:

```bash
git clone https://github.com/frizynn/nenu.git
cd nenu
bun install --frozen-lockfile
cd web && bun install --frozen-lockfile && cd ..
herdr plugin link "$(pwd)"
herdr plugin action invoke start --plugin herdr.collie
```

See the [complete user guide](docs/USER_GUIDE.md) for configuration, first-run output, Web Push,
updates, uninstalling, and troubleshooting.

## Common operations

```bash
herdr plugin action invoke status  --plugin herdr.collie
herdr plugin action invoke restart --plugin herdr.collie
herdr plugin action invoke update  --plugin herdr.collie
herdr plugin action invoke stop    --plugin herdr.collie
```

A routine update stays within the installed major version. Read the release notes before crossing a
major version, then use the explicit `update-major` action.

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

Nenu follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) while it remains in the
`0.x` public-preview line. Every published version has:

1. matching versions in the Herdr manifest and both package manifests;
2. a curated entry in [CHANGELOG.md](CHANGELOG.md);
3. a validated commit reachable from `main`;
4. a single annotated `vX.Y.Z` tag; and
5. a GitHub Release created only after version checks, tests, and the production build pass.

Subscribe to [GitHub Releases](https://github.com/frizynn/nenu/releases) for update notifications.
Maintainers should follow [docs/RELEASING.md](docs/RELEASING.md); never push inherited tags in bulk.

## Project status

Nenu is a single-operator, self-hosted public preview. Interfaces and configuration may still evolve
before 1.0, with breaking operator changes reserved for a major release. The compatibility surface
includes the Herdr plugin actions, environment variables, stored state, and bridge HTTP API.

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

## Starting and recovering conversations

Open an empty terminal in Nenu and tap **Start Codex** or **Start Claude Code**. The buttons wait for terminal output before enabling. Complete any native trust or login prompts, then send the first message. Use the terminal icon to switch between conversation and terminal views.

New Codex launches use `--no-daemon`, keeping the session hook in the terminal's own process. Claude launches get an explicit session ID. Both views control the same native session; Nenu does not start a second agent when switching views.

If an existing Codex terminal has no connected history, tap **Find Codex conversations** and select the conversation already running there, or enter the session ID shown by `/status`. **Connect history** restores the chat without sending a prompt or resuming another process. **Change connected conversation** lets you correct that choice later. The connection survives a bridge restart but is discarded if the terminal process or hook identity changes.

Recovery uses the existing local Codex daemon socket under `$CODEX_HOME/app-server-control/`; it does not expose that socket over the network. Claude background sessions can be identified by `claude agents --json` and their exact `attach` target. Older CLIs can still be launched manually and read through their installed Herdr integration.

See [the session architecture decision](.adr/0022-native-agent-sessions-and-explicit-history-recovery.md) for verified versions and limitations.
