# 0105. A docked thread takes the panel's place at its width; nothing folds to make room

- **Status:** Accepted (2026-10-20). Reverses the fold to the rail of commit `57d594e3`.
- **Trail:** `web/src/components/split-view.tsx` (`DockedThread`) · `web/src/components/session-inspector.tsx`
  (`ColumnEdge`, `slidePanel`) · `web/src/components/ui/resize-handle.tsx` · `web/src/components/workbench-shell.tsx` ·
  `scripts/e2e/panels.ts`

## Context

On a desk, a coordinator's chat has its session panel on the right (ADR 0075). Opening one of its
threads docked that thread beside it at `min(44rem, 50%)` and, so its header was not squeezed at
1440 px, folded the sidebar to the rail until the thread closed. The person read that as the screen
changing size every time a thread was tapped. Measured with `bun scripts/e2e/panels.ts` at
1440×900, before: docking moved the sidebar 272 → 56 px, the chat's left edge 272 → 56 and the right
column 460 → 692 in one frame; closing went back in two frames (the chat 692 → 924 → 708). No edge
but the panel's could be dragged, and the panel's grip had no double-click, Home or End.

## Decision

1. **One right column, one width.** The session panel and a docked thread are the same column:
   the thread takes the panel's place at the panel's width (`PANEL_WIDTH`, 320–960 px, kept per
   device), and the chat beside it keeps 22rem. Docking and closing a thread move nothing; the
   thread only fades in.
2. **Nothing folds to make room.** The sidebar stays as the person left it. A narrow column cuts
   the thread's title and drops its subtitle before any control.
3. **Every desk column edge is one grip** (`ResizeHandle`): the sidebar's (220–420 px, at most 40%
   of the window) and the right column's. Drag, arrows (Shift four steps), Home and End, a
   double-click back to the default; each width kept per device.
4. **Only a press slides the panel.** Its width moves over 200 ms in and 160 ms out, its content held
   at full width; ⌘⌥B and reduced motion open and fold it at once.

## Consequences

- A docked thread starts at 460 px instead of about 700; one drag widens it, and it stays wider for
  the panel too.
- The open and the fold reflow the chat on every frame of the slide. On the bench host under a load
  of 177, beside a 200-turn chat, an instant fold took one 160 ms frame and a slide four of 85–180 ms.
  Revisit the slide (back to an instant change) if it stutters on the person's own machine.
- Revisit point 1 only if people keep widening the column for a thread and narrowing it again for the
  panel: then the two want widths of their own.
