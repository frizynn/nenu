#!/usr/bin/env bash
# A throwaway herdr-core for the hc-*.ts benches, apart from the operator's own core.
#
#   source scripts/e2e/hc-isolated-core.sh <dir>   # env for this shell: HC_SESSION + XDG dirs under <dir>
#   hc server start                                # then start agents with `hc run ...`
#   hc_isolated_stop                               # kills its terminals, stops it, checks the claude link
#
# Agents started here must not touch the operator's install: Claude's self-updater writes into
# XDG_DATA_HOME and repoints ~/.local/bin/claude there, which dangles once <dir> is gone (observed).
# So DISABLE_AUTOUPDATER=1 is exported, and the link is compared before and after.
# A macOS socket path holds 103 bytes, so the core's state and runtime dirs live under /tmp.

dir="${1:?usage: source hc-isolated-core.sh <scratch dir>}"
mkdir -p "$dir"/{config,data,cache}
run="/tmp/hc-e2e-$$"
mkdir -p "$run/state" "$run/run" && chmod 700 "$run/run"

# Inside a Herdr or hc terminal these name the operator's core and agent; none may leak in.
unset HC_TERMINAL_ID HC_TERMINAL_SOCKET HC_SCOPE HERDR_ENV HERDR_SOCKET_PATH HERDR_PANE_ID
for v in $(env | grep -E '^(CLAUDE|CLAUDECODE)' | cut -d= -f1); do unset "$v"; done

export HC_SESSION="e2e$$"
export XDG_CONFIG_HOME="$dir/config" XDG_DATA_HOME="$dir/data" XDG_CACHE_HOME="$dir/cache"
export XDG_STATE_HOME="$run/state" XDG_RUNTIME_DIR="$run/run"
export DISABLE_AUTOUPDATER=1
HC_ISOLATED_CLAUDE_LINK="$(readlink "$HOME/.local/bin/claude" 2>/dev/null || true)"

hc_isolated_stop() {
  local t
  for t in $(hc ls --json | python3 -c 'import json,sys; print(" ".join(t["address"] for t in json.load(sys.stdin)["terminals"]))'); do
    hc kill "$t" >/dev/null
  done
  hc server stop --json >/dev/null
  local now
  now="$(readlink "$HOME/.local/bin/claude" 2>/dev/null || true)"
  if [ "$now" != "$HC_ISOLATED_CLAUDE_LINK" ]; then
    echo "ALERT: ~/.local/bin/claude moved from '$HC_ISOLATED_CLAUDE_LINK' to '$now'; restore it with: ln -sfn '$HC_ISOLATED_CLAUDE_LINK' ~/.local/bin/claude" >&2
    return 1
  fi
}
