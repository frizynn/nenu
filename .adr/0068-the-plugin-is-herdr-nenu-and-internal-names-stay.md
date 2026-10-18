# 0068. The plugin is herdr.nenu; internal names stay collie

- **Status:** Accepted (2026-10-13). Lands with 1.0.0. Point 3 amended for uploads by
  [ADR 0098](./0098-uploads-live-beside-the-state-under-nenus-name.md).
- **Trail:** `herdr-plugin.toml` · `scripts/collie-ctl.sh` (`migrate_legacy_config`,
  `retire_legacy_service`, `refresh_registry`, `unit_tailscale_hosts`) · `scripts/collie-ctl.test.sh`
  (`test_renamed_plugin_takes_over_from_herdr_collie`) · `contrib/windows/collie-ctl.ps1`

## Context

The product has been Nenu since it left Collie, but every command an operator typed still said
`herdr.collie`: `herdr plugin action invoke restart --plugin herdr.collie`, the LaunchAgent
`herdr.collie`, the systemd unit `collie`. The operator asked why the plugin is not called Nenu.

Herdr's behaviour around an id change, measured on Herdr 0.9.3 with a throwaway linked plugin:

- Herdr reads the id from the manifest on every call. Once the manifest says a new id, the plugin
  answers to that id only (`plugin_not_found` for the old one), and `HERDR_PLUGIN_CONFIG_DIR` points
  at a new, empty directory named after it.
- The registry keeps a link under the id it was made with. `herdr plugin unlink <new id>` reports
  `removed: false`; only the old id removes it. Re-linking the same path after the change adds a
  second key, and both stay until each is unlinked.

So a bare id change leaves an upgraded install with no `.env`, no record of the tailscale mapping it
owns, the old service still holding the port, and a phantom registry key.

## Decision

1. The plugin id is `herdr.nenu`. The LaunchAgent is `herdr.nenu`, the systemd unit `nenu`, the
   Windows task `herdr.nenu`. Every command and document uses them.
2. An install from before 1.0 carries over on its own. The first run as `herdr.nenu` copies the files
   of the `herdr.collie` config dir that the new dir lacks, once, and leaves the old dir untouched.
   `stop` stops and disables the old service; `start` also removes its definition, after discovery
   has read the host allowlist the old unit carries. A linked checkout's registry refresh unlinks the
   `herdr.collie` key unless some checkout still declares that id.
3. Everything the operator does not type keeps its name: `COLLIE_*` settings, `scripts/collie-ctl.sh`,
   the state directory `~/.local/state/collie`, browser storage keys, headers and notification tags.

## Consequences

- Renaming `COLLIE_*` was rejected: it would make every operator's `.env` wrong at once, or make the
  bridge read two prefixes forever, for a name nobody types in daily use. `collie-ctl.sh` cannot move
  at all ([ADR 0006](./0006-update-advances-the-checkout-herdr-installed.md)): the update action of an
  older install runs the script at that path. The state directory holds uploads, queues and retained
  assets that open clients still load ([ADR 0026](./0026-open-clients-survive-frontend-updates.md)).
- The 1.0 upgrade itself is invoked with the old id, because that is what the install answers to until
  it updates: `herdr plugin action invoke update-major --plugin herdr.collie`.
- A Herdr-managed install keeps the `herdr.collie` registry key: the refresh never re-links a managed
  checkout (ADR 0006). If `herdr plugin uninstall herdr.nenu` reports nothing removed there, uninstall
  with `herdr.collie`.
- Revisit only if Herdr gains a rename that moves the config dir and the registry key itself.
