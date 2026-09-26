# 0026. Keep open clients usable across frontend updates

Status: Accepted

## Context

An open 0.45.1 client requests file-preview-DKl8QUfT.js after the bridge switches
to 0.45.2. That immutable module had disappeared and returned 404. React cached
the rejected lazy import, so reopening the viewer could not repair it. The same
failure was reproduced with an open browser, a retained draft and a build swap.

The artifacts scan also blocked the browser on slash-heavy tool output: its repeated
path segment could consume the same slash as the enclosing repetition. Excluding
separators from segments removes that ambiguous backtracking.

Separately, the updater reloads when a new build is announced and no unsent-work
hold is active. Reading a chat was not a hold. An empty composer could therefore
be interrupted by an automatic page reload. The root build scripts also bypassed
the staged deployment already implemented by collie-ctl.

## Decision

Retain only hashed public build assets in the bridge state directory. Cache them
at startup and when the served build changes. Static requests first use the current
build, then the retained asset. Never retain or substitute index.html, service
workers, API responses or project files. Restrict names, reject symlinks, keep at
most 128 MiB and remove assets unused by a build for seven days. Retention failure
must not take the current application offline.

An open chat or terminal holds automatic reloads, even with an empty composer.
The existing update action can explicitly adopt a new build; leaving the session
also releases the hold. Draft and upload guards remain in force. A failed viewer
has an explicit reload action because a failed module import cannot be repaired
by remounting the same React.lazy object.

Both root build commands use the existing staged build pipeline. The frontend
package's direct Vite command remains the low-level build step.

## Consequences

Old open pages can load deferred modules across restarts and linked-worktree
changes. Assets older than the retention window can still require a reload.
This does not claim to repair a phone's network or Tailscale connectivity: those
must be measured independently of frontend updates and module loading.
