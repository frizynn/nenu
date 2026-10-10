# Architecture decision records

Decisions with a **blast radius wider than the diff that made them** — the ones a future
contributor (or a future agent) would otherwise re-derive from scratch, or quietly reverse because
the reasoning lived only in a PR thread.

One file per decision, numbered in the order they were accepted:

```
.adr/NNNN-kebab-case-title.md
```

Format is [Michael Nygard's](https://cognitect.com/blog/2011/11/15/documenting-architecture-decisions):
**Context** (the forces, including what was actually measured), **Decision** (what we do, in the
imperative), **Consequences** (what this costs, and what would justify revisiting it).

## When to write one

Write an ADR when a decision **closes off an option someone will reasonably propose again**. The
signal is that you find yourself explaining *why not* rather than *how*.

- ✅ "We manage exactly one front door" — a NetBird PR, then a Cloudflare Tunnel PR, then a ZeroTier PR
- ✅ "Polling, not an event stream" — perennial, and the reasoning isn't obvious from the code
- ❌ "Use Vitest for the web suite" — that's just what the repo does; `CLAUDE.md` covers it
- ❌ Anything already legible from the code, a test name, or a commit message

**The bar is high, and it is meant to be.** These are for the handful of decisions that shape the
system, not a record of work done. A merged PR is not an occasion for an ADR; neither is a decision
that merely took some thought, nor one you'd like on the record because it was hard-won. If a
directory of ADRs reads like a changelog, it has stopped being useful — the signal drowns, and the
few entries that genuinely close off a road get skimmed past with the rest.

Before adding one, both of these must be true:

1. **Someone has actually argued for the other road, or demonstrably will.** A real PR, a real issue,
   a proposal you had to talk someone out of. "A future contributor might wonder" is not enough — that
   is what a comment is for.
2. **The argument has nowhere better to live.** If it fits at the line that would change, put it
   there: whoever reopens the question is reading that code, not this directory. An ADR is for
   reasoning that spans files, or that argues against a road with no single line to attach to.

When in doubt, don't. A comment at the point of change costs nothing and is read by exactly the
person who needs it; an ADR that didn't need writing dilutes the ones that did. Two candidates were
turned down on this basis in one day (bundled-font laziness, and the direct-typing lifecycle) — both
became file-header comments, and both are better for it.

## Relationship to the other docs

Nothing here restates what lives elsewhere; the point is the *reasoning*, once.

| Where | What belongs there |
| --- | --- |
| [`CLAUDE.md`](../CLAUDE.md) | The **rule** — short, normative, linking here for why |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | How the system is **built**, as it stands today |
| [`README.md`](../README.md) | How an operator **runs** it |
| `.adr/` | Why a road **wasn't** taken |

A superseded ADR is never deleted or edited into agreement with the present. Mark it
`Superseded by NNNN` and write the new one — the wrong turn is the useful part.

## Index

| # | Decision | Status |
| --- | --- | --- |
| [0001](./0001-one-managed-front-door.md) | Nenu manages exactly one front door | Accepted |
| [0002](./0002-invert-the-light-terminal-mirror.md) | The light terminal mirror is inverted, not re-themed | Accepted |
| [0003](./0003-one-shared-seen.md) | "Seen" is one shared fact, and only Nenu's own reads count | Accepted |
| [0004](./0004-the-statusline-run-is-bounded.md) | The statusline run is bounded, but the bound guards less than it looks | Amended in scope by 0048 |
| [0005](./0005-a-composed-key-queue-never-outlives-its-dock.md) | A composed key queue never outlives its dock | Accepted |
| [0006](./0006-update-advances-the-checkout-herdr-installed.md) | `update` advances the checkout Herdr installed, and never re-links it | Accepted |
| [0007](./0007-the-idle-lock-is-a-pause-not-a-gate.md) | The idle lock is a pause, not a gate | Accepted |
| [0008](./0008-collie-does-not-run-a-terminal-emulator.md) | Nenu does not run a terminal emulator | Accepted |
| [0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md) | A generic menu is driven by the keys it names, never by digits | Accepted |
| [0010](./0010-long-sends-are-verified-via-the-paste-placeholder.md) | Long sends are verified via the paste placeholder, not by chunking them | Accepted |
| [0017](./0017-recognising-a-password-prompt-changes-what-collie-says.md) | Recognising a password prompt changes what Nenu says, never what it sends | Accepted |
| [0018](./0018-operator-command-rows-replace-the-catalog.md) | The operator's command rows replace the catalog, never merge into it | Accepted |
| [0020](./0020-a-major-upgrade-is-consented-by-flag.md) | A major upgrade is consented by flag; routine update follows tags within the major | Accepted |
| [0021](./0021-html-previews-run-in-an-opaque-no-network-sandbox.md) | HTML previews run in an opaque, no-network sandbox | Accepted; transport superseded by 0025, amended by 0059 and 0063 |
| [0022](./0022-native-agent-sessions-and-explicit-history-recovery.md) | Native agent sessions and explicit history recovery | Accepted; manual-only recovery superseded by 0028 |
| [0023](./0023-codex-replies-use-bracketed-paste.md) | Codex replies are sent as bracketed paste | Accepted |
| [0024](./0024-session-subagent-inspector.md) | Subagents are read within their parent session | Accepted |
| [0025](./0025-artifacts-and-server-message-queue.md) | Artifacts and a server-owned message queue | Accepted; queue half partially superseded by 0056, artifacts half amended by 0059 |
| [0026](./0026-open-clients-survive-frontend-updates.md) | Open clients stay usable across frontend updates | Accepted |
| [0027](./0027-quiet-recovery-on-intermittent-networks.md) | Intermittent connectivity and updates stay out of the conversation | Accepted |
| [0028](./0028-automatic-codex-history-recovery.md) | Automatic Codex history recovery from the live terminal title | Accepted |
| [0048](./0048-the-input-box-is-found-by-its-own-frame.md) | The input box is found by its own frame; the statusline bound only bounds what is stripped (amends 0004) | Accepted |
| [0053](./0053-an-unread-dialog-still-has-a-way-out.md) | An unread dialog still has a way out: a footer phrase never silences a grammar (only that half is in Nenu) | Proposed |
| [0054](./0054-the-browser-hears-what-changed-not-the-state.md) | The browser hears what changed, never the state | Accepted; amended by 0058 |
| [0055](./0055-the-folder-picker-lists-names-under-home-only.md) | The folder picker lists folder names under home, and nothing else | Accepted |
| [0056](./0056-queued-messages-follow-each-clis-native-queue.md) | Queued messages follow each CLI's native queue, with a send-time choice while the agent is busy (supersedes the queue half of 0025) | Accepted |
| [0057](./0057-the-bridge-reads-and-answers-dialogs-through-the-screen.md) | The bridge reads and answers dialogs; the screen is the actuator and hooks only observe | Accepted |
| [0058](./0058-the-bridge-watches-the-panes-a-browser-is-looking-at.md) | The bridge watches the panes a browser is looking at (amends 0054) | Accepted |
| [0059](./0059-agent-images-svg-and-html-assets-render-without-widening-file-access.md) | Agent images, SVG and HTML assets render without widening file access (amends 0021, 0025) | Accepted; amended by 0063 |
| [0060](./0060-codex-panes-stay-off-the-daemon.md) | Codex panes stay off the daemon (launching Codex daemon-backed was rejected) | Rejected |
| [0061](./0061-nenu-reads-organizations-through-its-json-contract.md) | Nenu reads Organizations through its `--json` contract | Accepted |
| [0063](./0063-a-refused-file-opens-only-through-a-confirmed-single-use-link.md) | A refused file opens only through a confirmed, single-use link (amends 0021, 0059) | Accepted |

The gaps are reserved by decisions that remain in the upstream history and are not part of Nenu's
current contract. New ADRs continue from the highest number already used; existing numbers are never
reassigned.
