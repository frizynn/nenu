# 0079. On a desk, the keyboard is the keys

- **Status:** Accepted (2026-10-15). Amends 0077: the Terminal tab keeps the mirror and the switch,
  and Keys stay on the phone.
- **Amended by:** [ADR 0114](./0114-a-send-from-nenu-never-gets-stuck.md): the Terminal tab, and the
  chat's Terminal view, arm the keyboard while they are on screen.
- **Trail:** `web/src/hooks/use-direct-typing.ts` · `web/src/components/composer.tsx` ·
  `web/src/components/session-inspector.tsx` · `scripts/e2e/run.ts terminal`

## Context

ADR 0077 put the phone's Keys tray in the desk's Terminal tab, above the "Type into terminal"
switch. On a desk the tray repeats the keyboard under the operator's hands, at the phone's size, and
takes most of the tab's height from the mirror it acts on. The operator asked for it gone.

The tray was not redundant everywhere, though. Measured on the bench (WebKit, the real bridge on a
FakeHerdr, 1.7.0) with the switch armed: Esc, the arrows, Tab, Enter and Backspace reached the pane;
Ctrl+C, Ctrl+D, Ctrl+L and F5 sent nothing; Shift+Tab arrived as a bare Tab. Removing the tray as it
stood would have left those keys with no way in from a desk.

## Decision

1. Beside a desk's session panel the Terminal tab holds the pane's mirror and the "Type into
   terminal" switch, nothing else. The + menu there keeps Files and photos, Commands and Context. A
   phone, and a desk chat with no panel beside it (a docked thread), keep the full menu and the tray.
2. Armed, the desk's keyboard sends what the tray sent. Esc, Tab, Enter, Backspace, the arrows and
   F1–F12 go by name with the Ctrl and Option held (`alt+Left`), and with Shift too except on Enter,
   Backspace and Esc (`shift+Tab`), where a phone keyboard's auto-capital would otherwise change the
   key. Ctrl with a printable key is that chord (`ctrl+c`; Shift kept for a letter, `ctrl+shift+r`).
   Arming, and every way the mode ends, stay as 0077 and the header of `use-direct-typing.ts` set them.
3. Command stays the browser's: copy, paste, closing the tab. So does Ctrl+V outside Apple keyboards,
   where it is the paste, and a paste reaches the pane as typed text. Option with a printable key
   stays text, because on a Mac it types characters (`@` on some layouts).
4. Nothing is staged in the tab any more, so the discard confirm 0077 put on the panel's ways out is
   gone. The phone's dock keeps its own (ADR 0005).

## Consequences

- With the switch armed on the bench, every key above reaches the pane under its tray name, and the
  tab shows no key buttons and no Quick replies note.
- A `cmd+…` chord and the operator's `keys.toml` presets have no button beside the panel. A preset's
  keys can still be typed with the switch armed; the presets themselves stay on the phone and in a
  docked thread's +.
- Revisit if a desk operator needs a Command chord inside a terminal app. It would take a named
  control, never the keyboard, since Command belongs to the browser.
