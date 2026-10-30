# 0136. The lists show machines, not sessions, all at once or one picked

- **Status:** Accepted (2026-10-30). Supersedes the listing half of [ADR 0135](./0135-each-herdr-core-machine-is-its-own-session.md);
  its sessions, journal copy, whole queued rows and `hc put` stand. Amends
  [ADR 0130](./0130-the-bar-lists-chats-by-project-and-a-count-lists-its-state.md): the desk's bar lists
  by spaces, folders, time or state.
- **Trail:** `bridge/routes/snapshot.ts` (`machineGroups`, `joinedMachines`) · `web/src/lib/machines.ts`
  (`shownHerd`, `useMachineFilter`) · `web/src/components/machine-picker.tsx` · `web/src/lib/desk-projects.ts`
  (`SidebarView`) · `web/src/components/workbench-sidebar.tsx` (`ViewPicker`)

## Context

ADR 0135 made each herdr-core machine a session and listed the other machines under their names. On
the Mac the switcher then read `default`, `hc` and `hc@rise-l`: two entries for one machine (Herdr's own
socket and hc's), and to see everything the operator had to read three lists. He asked for one entry per
machine, a way to see every machine at once, and a bar that can list by more than project or time.

## Decision

- **The snapshot joins sessions by machine** while hc is on: this machine holds Herdr's own sessions and
  `hc`, each other machine its `hc@` session. Every machine carries its whole herd, each row naming the
  session it opens in, "" for the primary. Sessions stay as they are inside the bridge; only the lists
  change.
- **The lists show every machine at once by default** (Home, the bar, its rail, Search), or the one this
  device picked in the machine picker (All, then each machine), kept in `localStorage`. A row of a
  machine other than this one names it after its place. The session switcher gives way to the picker.
  A chat page stays in its own session.
- **The desk's bar lists by Spaces, Folders, Recent or State**, picked under Search and kept on the
  device. Spaces is the workspace tree Search already drew; State groups the chats as Home's counts do.
- Don't put sessions back in the picker: the operator thinks in machines, and Herdr's and hc's sessions
  on one machine are one place to him.

## Consequences

- New chat starts in the page's session; choosing where is the New flow's, not the picker's.
- Dialog options and background work are read in the page's session, so another session's agent that
  asks shows in Needs you without its options until its chat is opened.
- ADR 0084's machines (another Nenu) still list apart under their names; only joined machines merge.
- Pane ids must stay apart across sessions (Herdr's `w1:p1`, hc's `t6` and `rise-l:t7` do).
