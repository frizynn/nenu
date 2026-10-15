# 0082. A Codex with no turn has nothing to link

- **Status:** Accepted (2026-10-15). Narrows ADR 0022's manual recovery to conversations that exist,
  and adds an exact identity next to ADR 0028's title match.
- **Trail:** `bridge/codex-sessions.ts` · `bridge/conversation-service.ts` · `bridge/routes/history.ts` ·
  `web/src/components/live-conversation.tsx`

## Context

Every Codex the operator started showed "No conversation linked" with Find and Enter a session ID,
including a project coordinator opened a minute earlier. Measured on Codex 0.162.1:

- Herdr's SessionStart hook fires at the first turn, not at startup. Before it, a Codex has no
  `agent_session` whether it runs on the shared daemon or with `--no-daemon`.
- A client of the shared daemon runs that hook inside the daemon, with the pane environment the
  daemon inherited when it first started. On the reported host it named a pane closed days before,
  so even after a turn Herdr never learned the coordinator's session.
- Until its first turn a conversation has no name, no preview and no rollout on disk, and its
  terminal title is the folder alone. ADR 0028's match needs a name, so it found nothing, and the
  history answered `no-session`: the card.
- A process started with `--no-daemon` holds its rollout open from its first turn on. A daemon
  client holds none; the daemon holds them all, and it publishes no client-to-conversation map.

## Decision

1. History tells a Codex that provably has not started (`notStarted`) from one Nenu cannot identify.
   The chat then waits for the first message and offers no link. Provable means: for a `--no-daemon`
   process, it holds no rollout and its title is the bare folder; for anything else (not
   `--remote`), it holds no rollout, its title is the bare folder, and the complete list of
   conversations loaded in that folder has no unnamed one with a message or a running turn.
2. A process that holds exactly one rollout is that conversation. This is exact, so it wins over
   the title match, and a `--no-daemon` process never consults the daemon's titles: its
   conversation cannot be there, and a same-named one would be someone else's.
3. Between a daemon client's first message and the moment Codex names the thread (5 to 8 s
   measured), the card shows. Nenu does not bind the only unnamed conversation in the folder to
   close that gap: a second Codex in the same folder, or one outside Herdr on the same daemon,
   makes that the wrong conversation, and nothing on the daemon tells them apart.

## Consequences

- A new Codex opens as an empty chat. A first message sent from Nenu shows as pending in the
  meantime; one typed in the terminal sees the card until the title names the thread. For about
  3 s after Codex names the thread and before it repaints the title, the pane can read as not
  started: it shows the empty chat, never another conversation.
- Starting Codex with `--no-daemon`, as Nenu's own launcher does (ADR 0022), removes the gap: the
  hook reports the right pane and the held rollout names the session at the first turn (under 1 s
  measured). Launchers that start Codex on the shared daemon keep the gap.
- Reading a process's open files costs one `lsof` (60 to 100 ms on macOS) or a `/proc` walk; the
  service reuses it for five seconds, since a process opens its rollout once.
- The checks depend on Codex's current title (`<name> | <folder>`) and protocol fields (`name`,
  `preview`, `status`). If either changes, a new Codex falls back to the card, never to a guess.
