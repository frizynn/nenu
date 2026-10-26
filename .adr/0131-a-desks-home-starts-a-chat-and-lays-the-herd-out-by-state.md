# 0131. A desk's Home starts a chat, and lays the herd out by state on its Board

- **Status:** Accepted (2026-10-26). Changes what a desk's Home draws; a phone's Home is unchanged.
  Requested by the operator after ten directions drawn side by side: "y falta en la home meter algo
  mejor en desktop no se, se siente raro", then "me gusta el 1 pero que tmb se pueda ver el kanban en
  algun lado". Direction 1 was "Composer first" (T3 Code's empty thread), the kanban "Board by state".
- **Trail:** `web/src/components/desk-home.tsx` (`DeskHome`, `StartComposer`, `BoardView`) ·
  `web/src/lib/home-board.ts` · `web/src/routes/home.tsx` · `web/src/components/home-panels.tsx`
  (`HomeSessions`, its list chosen by the header)

## Context

Measured on Nenu 2.8.0 and 2.8.1 at 1440×900 (the e2e bench's herd and the operator's own captures):

- Home was one 760px column centred in a 1168px main area: 204px empty on each side, its left edge on
  no line the sidebar draws, and below its last row 35–41% of the screen empty.
- It had no header aligned with the sidebar's top row, as every chat has, and it led with a negative
  ("Nothing needs you", 22px) while the useful counts sat in a muted line under it.
- Recents repeated the sidebar's chats wider, with the same marks and places; Workspaces and PRs sat
  behind a tab though the screen had room. Nothing on the page could start anything: New was a 16px
  icon in the bar.

## Decision

1. **A desk's Home has a header of views**, aligned with the sidebar's top row: Start, Board, Recents,
   Workspaces and PRs (PRs while GitHub lists one), the herd's counts at its end (needs you, working,
   to review, PRs), each opening the view that lists it. The view is remembered per device; a link that
   names a list (the bar's Pull requests) opens on it.
2. **Start asks what to start, and in which folder**, over a new chat's composer: the agent, how much
   it may do, the folder and More ways to start. The folder is the one this device last chose in the
   New flow, else the one the herd last moved in, and it stays put once shown: the herd's last folder
   is often another agent's worktree, and a chat being written must not move with the herd. It starts through the New flow's own create, never a parallel path: a tab of the workspace
   already in that folder, else a workspace on it, then the agent and the first message. Under it,
   what needs you (answered in place, as before) and three chats to pick up, finished turns first.
3. **The Board lays the herd out by state**: Needs you, Working and Ready to review side by side, the
   chats at rest folded at its foot. A card shows only what the snapshot carries (name, agent, project
   and tab, how long, the terminal title its process sets, its PR's size); it never reads a pane's
   screen ([ADR 0058](./0058-the-bridge-watches-the-panes-a-browser-is-looking-at.md)).
4. **Recents, Workspaces and PRs stay whole** as views, with their order, Reorder and PR filter; a
   phone keeps them under its tabs, below the headline, as it did.

## Consequences

- The sidebar's counts still list their state in the bar ([ADR 0130](./0130-the-bar-lists-chats-by-project-and-a-count-lists-its-state.md));
  only the header's counts open the Board.
- The composer attaches nothing and names no branch: an upload needs a pane to belong to
  (ADR 0074) and the snapshot carries no branch. A card's current step and a finished turn's summary,
  drawn in the Board's direction, would need a read of every chat's journal or screen; until one is
  cheap, the terminal title and the PR's size stand in.
- Putting the single column back on a desk, or a Board card that reads every pane's screen, reopens this.
