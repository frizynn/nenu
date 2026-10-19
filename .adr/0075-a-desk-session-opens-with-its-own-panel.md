# 0075. A desk's session opens with its own panel; the project's sits behind ⋯

- **Status:** Accepted (2026-10-14). The operator chose this layout (desk A) over a panel of
  surfaces opened on demand (desk B). Point 2 superseded by
  [0081](./0081-on-a-desk-the-project-is-the-panels-first-tab.md); its Artifacts tab became a view of Files
  in [0101](./0101-a-threads-panel-opens-on-its-overview.md).
- **Trail:** `web/src/components/session-inspector.tsx` · `web/src/components/inspector-panels.tsx` ·
  `web/src/components/project-frame.tsx` · `web/src/routes/detail.tsx`

## Context

On a desk, the panel right of a project pane's chat was the project's: Threads, PRs, Activity,
Memory. A pane outside a project had nothing there. What an operator reads beside a running session
is what that session did: its diff, its folder, what it handed over. Those lived behind a menu and a
modal sheet. The project's lists are also in the sidebar, which every desk shows.

## Decision

1. From 1024 px, the width at which the workbench shows its sidebar, every pane has a session panel
   on the right with fixed tabs: Changes, Files, Artifacts (no Artifacts for a shell). A fourth tab,
   Terminal, is reserved after Artifacts.
2. A project pane keeps the project's panel one click away, behind the panel's ⋯. It no longer
   opens by default, and the project frame takes its desk layout from the same 1024 px.
3. Each tab reads only while it is on screen and polls nothing; Changes reads the session's diff
   (ADR 0073, amended) with or without a pull request.
4. ⌘⌥B (Ctrl+Alt+B) folds the panel. Open, width and tab are kept per device, and a blocked store
   only forgets them. The panel is a lazy chunk: a phone never loads it.

## Consequences

- From 1024 to 1279 px a project pane is laid out as a desk, where it used to get the phone's
  Chat / Threads / PRs control.
- Reopening the project's panel by default would hide the session's changes again. Revisit only if
  operators keep reaching for ⋯ first.
