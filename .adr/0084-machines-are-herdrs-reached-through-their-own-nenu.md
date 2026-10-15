# 0084. The machines are Herdr's, reached through each one's own Nenu over SSH

- **Status:** Accepted (2026-10-16).
- **Trail:** `bridge/machines.ts` · `bridge/machines-runtime.ts` · `bridge/server.ts` (`peer.sock`) ·
  `bridge/routes/index.ts` (dispatch) · `bridge/routes/snapshot.ts` · `web/src/lib/machines.ts` ·
  `web/src/components/other-machines.tsx` · `scripts/e2e/machines.ts`

## Context

An operator with a second machine saved in Herdr (`herdr machine add`) found no way to reach it from
Nenu, and asked why it should need another list when Herdr already has one. They want to run Nenu on
the bigger machine and drive the laptop from it too, so the code has to work the same from either end.

Herdr keeps its saved machines on the client side (`herdr machine list --json`: id, label, SSH target,
remote session, enabled); its socket API has no method for them. `herdr --machine <label> <command>`
opens one SSH channel per call over a ControlMaster and runs `herdr remote-api-bridge` there, a stdio
pipe to one connection of that machine's socket: a request gets one reply and the pipe closes;
`events.subscribe` stays open. It carries Herdr's socket and nothing else.

A chat needs more than Herdr's socket: its transcript, images and send check come from the agent's
own logs, Stop and the send path from the CLI's session files (ADR 0067), Changes from `git`, previews
and Open from the pane's folder, attachments must land where the agent reads them, and New chat lists
folders under that machine's home. All of that is on the agent's disk, read by the Nenu beside it.

Measured from a laptop to a saved Linux machine (Tailscale SSH, ping 14 to 34 ms), read-only:

| Transport | One read |
| --- | --- |
| `herdr --machine <label> workspace list` | 330 to 440 ms |
| `remote-api-bridge` over an SSH connection of our own | 175 to 182 ms |
| Forward to a remote Unix socket (`-L sock:sock`), new channel per request | 115 to 129 ms |
| Forward to a remote loopback port, new channel per request | 34 to 43 ms |
| HTTPS over the tailnet to the other Nenu | not reachable: the tailnet policy keeps tagged nodes out, and a tagged node sends no `Tailscale-User-Login`, which the gate requires |

## Decision

- **Herdr's list is the only list.** The bridge reads `herdr machine list --json` at start and at most
  once a minute when a snapshot is asked for. Nenu adds, renames and forgets no machine; a disabled one
  is shown as such and never dialled.
- **One `ssh` per machine, as Herdr dials it:** the operator's own `~/.ssh/config` and default keys,
  `BatchMode=yes`, `StrictHostKeyChecking=yes`, the target exactly as Herdr saved it. A short probe
  finds the other Nenu's `peer.sock` and tells apart "SSH did not get there", "Nenu is not running",
  "Nenu is too old" and "no Nenu". Then one `ssh -L <stateDir>/machines/m-<id>.sock:<peer.sock>`
  whose remote command waits on stdin, so the tunnel dies with the bridge, SIGKILL included. Retries
  wait 5 s, 15 s, 1 min, then 5 min.
- **Every Nenu listens on `<stateDir>/peer.sock`** (0600) beside its port, and answers a request there
  as the operator. It never forwards one again.
- **A machine is a session to the browser:** `?s=@<label>` (Herdr refuses `@` in a session name).
  The dispatcher applies its own gate at the route's own level, then hands the request, unchanged, to
  that machine's Nenu. Organizations, settings and push stay on the machine serving the page.
- **No new polling.** The bridge follows each other Nenu's `/api/events`, re-reads its snapshot when it
  names one, and tells its own pages. The snapshot carries `machines` only when Herdr has one saved.

## Consequences

- Opening `peer.sock` to the operator opens nothing new: only the same user (or root) can connect, and
  either can already write to Herdr's own socket, read the journals and run anything. Reaching it from
  another machine takes SSH as that user, which is that machine already. The port's gates are as they
  were, and a read-only device here is read-only on every machine.
- A Unix socket costs about 80 ms more per new channel than a loopback port on Tailscale SSH (table).
  A port would be faster and visible to every local user. Keep-alive connections over the tunnel
  should pay that cost once per connection rather than per request (assumed: no Nenu with
  `peer.sock` was on the far side to measure it).
- The service has no SSH agent unless its environment provides one: a key without a passphrase, or
  `SSH_AUTH_SOCK` in its `.env`. A host key not yet trusted leaves the machine offline with ssh's
  reason; Nenu never answers that prompt.
- Bun 1.4 ignores `server.timeout(req, 0)` on a Unix listener (measured); `peer.sock` runs with no
  idle cut, or every quiet event stream closes after ten seconds.
- A page on another machine hears that machine's events; the lists of the rest refresh on the poll.
- Revisit if Herdr exposes its machines, or a byte stream to them, on its socket; or if Organizations
  needs to span machines (out of scope here).
