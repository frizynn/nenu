# 0134. Each agent has its own notifications switch, and supervisor folders are an opt-in default

- **Status:** Accepted (2026-10-29). Builds on [ADR 0072](./0072-a-push-always-shows-and-says-only-what-answers-a-person.md):
  the kind switches and Snooze stay as they are; this adds a switch per agent in front of them.
- **Trail:** `bridge/agent-notify.ts` · `bridge/notifications.ts` (`agentOn`) · `bridge/routes/settings.ts`
  (`/api/notifications/agent`) · `bridge/routes/snapshot.ts` (`notify`) · `scripts/notify.ts` ·
  `herdr-plugin.toml` (`notify-list`, `notify-on`, `notify-off`, `notify-supervisors-clear`) ·
  `web/src/components/agent-chat.tsx`

## Context

The operator runs a herd where a few supervisor agents (a Firstmate and its second mates) each
launch many short-lived workers. The workers' finishes are for their supervisor, not for a person;
the kind switches cannot tell them apart, because a worker's turn and a supervisor's turn look the
same to Nenu (a person-started finish of a named or unnamed Claude). The operator asked to choose
which agents push, from the phone and from a terminal, with new agents off unless they are a
supervisor, without the rule being tied to Firstmate's names, and, on review, without changing
anything for anyone who has not configured it: no install may lose a notification on upgrade.

What Nenu can observe about an agent, measured on the live herd (Herdr 0.9.5, 2026-10-29, 28 agents):

| Signal | Supervisors | Workers | Verdict |
| --- | --- | --- | --- |
| Pane folder (Herdr `cwd`) | `~/.firstmate/<home>`, `~/Developer/firstmate` | `~/.firstmate/<home>/projects/<repo>` | Separates every one; reported by Herdr for every pane, on Linux and macOS |
| Launch arguments (`pane process-info`) | `--settings …secondmate…` on some, bare `--resume <id>` on the main one | `--add-dir …inbox` | A resumed supervisor loses its launch arguments: not stable |
| Process environment | `FM_HOME` set | `FM_TASK_ID` set | Linux `/proc` only, reads another process's environment, and is Firstmate's own vocabulary |
| Herdr agent name | none | a few | Most agents are unnamed |
| Terminal title | "Firstmate operational inbox message" on both | same | Says what the turn is about, not who the agent is |

Herdr offers no per-agent setting a plugin can keep, and `herdr plugin action invoke` takes no
arguments. It does hand an action its invocation context as `HERDR_PLUGIN_CONTEXT_JSON`, whose
`focused_pane_id` names the pane focused when the action was invoked; an action may declare the
`pane` context to be offered on a pane.

## Decision

1. **A switch per agent, in front of every push.** An agent is a pane, keyed `<session>/<paneId>`
   like the activity ledger. The notification coordinator reads the switch when a transition arrives
   and again when the debounced alert is decided, so an agent turned off mid-debounce sends nothing.
   An agent that is off never pushes; one that is on follows the kind switches and Snooze as before.
   herdr-core's agents (`COLLIE_HC_CORE`, its own session `hc`) go through the same session factory,
   so they get the same switch, rule and decision point, keyed apart from Herdr's panes.
2. **The default changes nothing.** With nothing configured every agent, new or existing, Herdr's or
   herdr-core's, starts on, so every push decision is the one 2.12.0 made under the same kind switches.
3. **Supervisor folders are opt-in.** The operator sets them from a terminal,
   `collie-ctl.sh notify supervisors set '<pattern>,<pattern>'` (whole-path patterns: `~/`, `*` for one
   folder name, `**` for any depth), kept in the same state file and read by the bridge on its next
   look. While they are set, an agent first seen afterwards starts on only when its pane folder matches
   one; `clear` (also the `notify-supervisors-clear` action) turns the rule off. Neither changes a switch
   already decided. On this host `~/.firstmate/*,~/Developer/firstmate` matches every Firstmate home and
   the Firstmate checkout, never the `projects/<repo>` folders their workers run in.
   There is no environment setting for it: a second source would need an order of precedence and a
   restart, and the state file needs neither.
4. **An upgrade silences nobody, even with folders set.** The file records which Herdr sessions it has seen. A session's
   first herd ever starts every agent in it on ("existing"); afterwards only agents first seen later
   follow the rule. Recording sessions, not the file's existence, keeps a terminal command run before
   the bridge's first start from costing the upgrade its seeding.
5. **One file, two writers.** `<stateDir>/agent-notify.json` is read by the bridge and by
   `scripts/notify.ts`. Every read checks the file's stamp first; every change is read, made and
   written (a temp file and a rename) under a short exclusive lock file, so neither writer overwrites
   the other's change. The ⋯ menu's row and the terminal change the same entry, and neither needs a
   restart.
   A closed agent is kept for a week, so a pane Herdr restores under the same id keeps its switch.
6. **The terminal is four plugin actions and one shell verb.** `notify-list` prints the rule and every
   agent with its switch and why; `notify-on`/`notify-off` act on the pane in the action's context
   (Herdr's focused pane); `notify-supervisors-clear` turns the rule off;
   `collie-ctl.sh notify on|off <pane id | session/pane id | name>` names any agent, and
   `collie-ctl.sh notify supervisors [set '<folders>' | clear]` shows or sets the rule.

## Consequences

- An operator who never sets folders sees one new row in the ⋯ menu, always checked, and nothing else.
- The folder is a convention, not an identity. With folders set, a worker launched directly in a
  supervisor's folder starts on, and a supervisor launched elsewhere (a Firstmate in a worktree, for
  one) starts off; either is one tap or one command to fix, and the choice then sticks.
- The rule reads Herdr's `cwd`, the folder the pane was launched in, not the agent's current folder
  (`foreground_cwd`, which a worker moves into its worktree).
- A pane id is per Herdr server. If a Herdr restart gives a restored agent a new id, it is a new agent
  to Nenu and the rule, when set, decides again.
- `notify-on`/`notify-off` from a plain shell act on whatever pane Herdr reports as focused, which is
  the agent's only when invoked from its pane in Herdr's palette; naming the agent through
  `collie-ctl.sh` is the reliable path from a script.
- A writer that dies holding the lock leaves it behind; it is taken over after ten seconds. While the
  lock is held the other writer waits up to two seconds, then fails loudly (the terminal command) or
  tries again on the next poll (the bridge).
- A Herdr session first seen after the upgrade, such as a new named session, is seeded too: its first
  agents all start on, whatever the rule says.
- Revisit if Herdr gains per-agent plugin metadata or a launcher field: either would identify a
  supervisor without a folder convention.
