#!/usr/bin/env bash
# Capture a live pane buffer as a byte-faithful test fixture for the block-renderer grammars
# (web/src/fixtures/panes/ by default).
#
#   scripts/capture-fixture.sh [--socket <path>] [--dir <dir>] <paneId> <name> [lines]
#
#   paneId    e.g. "wF:p1" (see /api/snapshot)
#   name      fixture file name, no extension — convention: <agent>--<state>[--variant]
#             e.g. claude--select-menu, claude--working--tool-run
#   lines     scrollback lines to request (default 300, bridge clamps at 10000)
#   --socket  read straight from a DISPOSABLE Herdr server's API socket instead of the local
#             bridge. Probes that type into agents run there, never on the operator's server, so the
#             script refuses the default socket, any socket under ~/.config/herdr/ and the socket
#             of the Herdr session it is running inside.
#   --dir     output directory (e.g. web/src/lib/harness/claude/fixtures)
#
# Both modes make the same read the mirror makes (`pane.read` source "recent", format "ansi") and
# write the text EXACTLY as returned (real ESC bytes, no trailing newline added), because the
# grammar tests must see what the renderer sees.
#
# ⚠ This repo is PUBLIC. Review every captured fixture for private content/secrets
#   before `git add` — pane buffers are real terminal output.
set -euo pipefail

usage="usage: capture-fixture.sh [--socket <path>] [--dir <dir>] <paneId> <name> [lines]"
SOCKET=""
DIR=""
while [ $# -gt 0 ]; do
  case "$1" in
    --socket) SOCKET="${2:?$usage}"; shift 2 ;;
    --dir) DIR="${2:?$usage}"; shift 2 ;;
    *) break ;;
  esac
done
PANE="${1:?$usage}"
NAME="${2:?$usage}"
LINES="${3:-300}"
PORT="${COLLIE_PORT:-8787}"

DIR="${DIR:-$(git -C "$(dirname "$0")/.." rev-parse --show-toplevel)/web/src/fixtures/panes}"
mkdir -p "$DIR"
out="$DIR/$NAME.txt"

# Resolves symlinks in every component, so a link to the real socket cannot slip past the check.
realpath_of() { python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"; }

if [ -n "$SOCKET" ]; then
  [ -S "$SOCKET" ] || { echo "not a socket: $SOCKET" >&2; exit 1; }
  sock="$(realpath_of "$SOCKET")"
  operator_dir="$(realpath_of "$HOME/.config/herdr")"
  case "$sock" in
    "$operator_dir"/*) echo "refusing the operator's Herdr socket: $SOCKET" >&2; exit 1 ;;
  esac
  if [ "${HERDR_ENV:-}" = 1 ] && [ -n "${HERDR_SOCKET_PATH:-}" ] \
    && [ "$sock" = "$(realpath_of "$HERDR_SOCKET_PATH")" ]; then
    echo "refusing the socket of the Herdr session this shell runs in: $SOCKET" >&2
    exit 1
  fi
  SOCK="$sock" PANE="$PANE" LINES="$LINES" OUT="$out" bun -e '
    const req = { id: "capture", method: "pane.read",
      params: { pane_id: process.env.PANE, source: "recent", format: "ansi",
                lines: Number(process.env.LINES) } };
    let buf = "";
    const utf8 = new TextDecoder();
    const done = Promise.withResolvers();
    await Bun.connect({ unix: process.env.SOCK, socket: {
      open(s) { s.write(JSON.stringify(req) + "\n"); },
      data(_s, chunk) { buf += utf8.decode(chunk, { stream: true }); },
      close() { done.resolve(); },
      error(_s, e) { done.reject(e); },
    } });
    await done.promise;
    const reply = JSON.parse(buf);
    if (reply.error) { console.error(JSON.stringify(reply.error)); process.exit(1); }
    await Bun.write(process.env.OUT, reply.result.read.text);
  '
else
  pane_enc="$(jq -rn --arg s "$PANE" '$s|@uri')"
  curl -sf "http://127.0.0.1:${PORT}/api/pane/${pane_enc}?lines=${LINES}" | jq -j '.text' > "$out"
fi

bytes=$(wc -c < "$out")
echo "captured $PANE → ${out#"$PWD"/} (${bytes} bytes, ${LINES} lines requested)"
echo "review before committing: less -R '$out'"
