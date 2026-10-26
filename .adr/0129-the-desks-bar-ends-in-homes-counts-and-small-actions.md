# 0129. The desk's bar ends in Home's counts and a row of small actions; its chats say where they live

- **Status:** Accepted (2026-10-26). Amends point 1 of [ADR 0080](./0080-the-desks-bar-lists-projects-and-chats-the-tree-is-searchs.md):
  the bar still lists chats and leaves the tree to Search, but it no longer leads with New chat,
  Search and Home as three rows. Requested by the operator, pointing at T3 Code's desktop sidebar:
  "fíjate abajo a la izquierda cómo está hecho esto que tiene configuración … sería bueno que en
  desktop sea algo parecido".
- **Trail:** `web/src/components/workbench-sidebar.tsx` (`DeskStatus`, `HostRow`) ·
  `web/src/components/desk-nav.tsx` (`ChatRow`) · `web/src/styles/nav.css` ·
  `web/src/components/home-panels.tsx` (`HomeSessions`, a list named by the link that opened Home) ·
  `web/src/components/app-header.tsx` (`SettingsGear`)

## Context

Measured on the operator's herd on 2026-10-26 (40 sessions, Nenu 2.6.0, 1440×900):

- The bar's chats were one 13px line each. Eight of the twelve on screen began with the same three
  words and ended in an ellipsis: nothing on screen told them apart.
- Three stacked 32px rows (New chat, Search, Home) sat above the list, and its foot held only the
  host and a Settings icon, so the bar spent its top on actions and its bottom on nothing.
- Settings had two doors on a desk: the bar's foot and a sliders icon at the page's top right.
- Pull requests and Usage had no place in the bar: PRs were a tab three clicks down Home, Usage a row
  inside Settings.

T3 Code's sidebar, the operator's reference, puts Search with small icon actions in one row, gives each
thread a name and a quiet line under it, and ends with status groups and their counts above a row of
small icon buttons (settings, PRs, stats).

## Decision

1. **Search leads the bar, New is a small action at its end.** ⌘K and ⌘N are unchanged; the
   collapsed rail keeps its own New, Search and Home icons.
2. **A chat in the bar is two lines:** its glyph and name with when it last moved, then where it lives
   (workspace · tab) one step quieter. A screen reader hears the name, the state, "new" and where it
   lives, so chats of one name read apart by ear too; when it moved is for the eye.
3. **The bar ends in Home's counts:** Needs you, Working and Done, each with its count (zero included,
   so the rows never move) and its glyph only while it counts something, each opening Home. The brand
   at the top carries Home's "page on screen".
4. **Its foot is a row of small actions:** Settings, Pull requests (opening Home on its PRs, there
   while GitHub lists one) and Usage, then the host in the quiet ink; the phone's drawer ends the same
   way. The page header's Settings icon is a phone's only.

## Consequences

- Home has no row of its own in the expanded bar; its counts are its way in. Bringing a Home row back
  on top of the counts reopens this.
- A list can be named by the link that opens Home (`state: { list }`), and it is remembered as a tap on
  its tab would be. Nothing else names one.
- Counts that filter (a Working view, a Done view) would need a page that lists by state; until one
  exists, every count opens Home.
