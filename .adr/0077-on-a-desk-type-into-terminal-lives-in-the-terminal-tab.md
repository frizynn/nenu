# 0077. On a desk, Keys and Type into terminal live in the Terminal tab

- **Status:** Accepted (2026-10-14). The operator chose it with the desk redesign; it fills the
  Terminal tab ADR 0075 reserved.
- **Amended by:** [ADR 0113](./0113-a-send-from-nenu-never-gets-stuck.md): the tab on screen arms the
  mode; the switch turns it off.
- **Amended by:** [ADR 0079](./0079-on-a-desk-the-keyboard-is-the-keys.md): the tab keeps the mirror
  and the switch, the desk's keyboard is the keys, and Keys stay on the phone.
- **Trail:** `web/src/components/composer.tsx` · `web/src/components/inspector-panels.tsx` ·
  `web/src/components/session-inspector.tsx` · `web/src/components/agent-chat.tsx` ·
  `web/src/hooks/use-direct-typing.ts`

## Context

The composer's + menu held the message's actions and the terminal's: Files and photos, Quick replies,
Commands, Keys, Type into terminal, Context. Keys and Type act on the terminal, and on a desk the
conversation sits beside the composer, not the mirror: the + armed typing into a screen nobody could
see. Type's safety rests on looking at the pane while you type into it (`use-direct-typing.ts`).

## Decision

1. Beside a desk's session panel (from 1024 px), the panel's Terminal tab shows the pane's mirror
   as Herdr renders it, every grammar off, then Keys, then a "Type into terminal" switch. The + menu
   keeps Files and photos, Commands and Context; Quick replies stay on the phone. A phone, and a desk
   chat with no panel beside it (a docked thread), keep the full menu.
2. The switch arms the mode the phone's + row arms, in the same composer: a named choice, never a
   gesture. It disarms on everything that disarmed it before (a pane switch, a composer lock, a
   hidden page, a failed batch), is never stored, and on a desk also when the Terminal tab leaves the
   screen: another tab, ⋯ Project, folding the panel. The password notice's Use Type opens the tab as
   it arms.
3. The tab reads nothing of its own. The chat draws the mirror and the composer draws Keys and the
   switch into it, and the pane is watched (ADR 0058) only while the tab is on screen.
4. The key queue's discard confirm (ADR 0005) moves with the tray: every way the panel stops showing
   Terminal asks first.

## Consequences

- On a desk, arming takes the panel open on Terminal, one step more than a + row. That step is the
  screen the keys go into.
- With the tab open the pane is watched as an open mirror is. Measured on the bench: no reads of the
  pane in 5 s with Changes on screen, 27 with Terminal.
- The tray is the phone's, at the phone's size, so the mirror above it gets what is left.
- Revisit if desk operators keep arming from the chat's own raw-terminal view; the switch would then
  belong beside that mirror too, under the same rules.
