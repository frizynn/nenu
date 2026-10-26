# 0130. The bar lists chats by the project their folder works in, and a count lists its state

- **Status:** Accepted (2026-10-26). Amends [ADR 0129](./0129-the-desks-bar-ends-in-homes-counts-and-small-actions.md):
  point 3's counts no longer open Home, and the bar's chats are no longer only a list by time. Requested
  by the operator, pointing at T3 Code's sidebar: "la sidebar tiene que ser, por default, ordenada tipo
  por proyecto … y que haya un botoncito que sea tipo un toggle que se muestre la otra como que si
  fuesen threads", and "cuando yo toco Done … no hace nada".
- **Trail:** `bridge/pane-project.ts` (`projectOf`, `ProjectCache`) · `bridge/state-engine.ts` ·
  `web/src/lib/desk-projects.ts` · `web/src/components/desk-nav.tsx` (`ProjectList`, `OnlyList`) ·
  `web/src/components/workbench-sidebar.tsx` (`DeskStatus`, `ViewToggle`, `PhoneLists`)

## Context

Measured on the operator's herd on 2026-10-26 (31 agents, Nenu 2.7.0):

- The bar listed every chat by when it last moved. Sixteen of them worked on one repo (four clones and a
  pool of worktrees of `comercio-saas`), thirteen were firstmate's coordinators; nothing on screen said so,
  and "Show 16 more" hid most of them.
- The counts at the bar's foot (Needs you, Working, Done) opened Home with no filter. On Home a tap on
  one changed nothing on screen: same URL, same list, same page (reproduced headless on the live app).

## Decision

1. **A pane's project is the repo its folder sits in**, named by the repo its `origin` remote names (else
   its first remote, else the checkout's folder), so a repo's clones and worktrees share one name; a
   folder in no repo is named by itself, and a pane with no folder by its workspace. The bridge reads it
   off the filesystem without running git, once a minute per folder, and sends it as the pane's
   `project`. Only the last segment of a remote's path leaves the bridge.
2. **The bar lists chats by project by default**: one row per project with its name, the most pressing
   state among its chats and how many it holds, folded until opened. Projects where something needs you
   come first, then those at work, then by the last move; like the chats, a project keeps its place while
   on screen until "N updates" or a return to the window. Opened projects and the view are remembered per
   device.
3. **A toggle switches to the list by time** (ADR 0129's), on a desk beside Search and on a phone at the
   end of the drawer's list heading. The drawer by time is the 2.7.0 drawer.
4. **A count lists only the chats in its state**, in the bar, pressed until tapped again, Show all or
   Escape. The phone's drawer shows the same counts side by side above its foot. Home is the brand's.

## Consequences

- This reads a folder, never an organizer: [ADR 0123](./0123-nenu-draws-herdr-alone.md) stands. A project
  here is where an agent works, not who delegated to it.
- Two repos with one name are one project on screen, as they would read the same anyway.
- A folder that becomes a repo, or a remote that changes, shows within a minute.
- Putting the counts back as links to Home, or the flat list back as the only view, reopens this.
