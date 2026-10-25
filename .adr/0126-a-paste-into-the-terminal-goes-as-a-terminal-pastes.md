# 0126. A paste while typing into the terminal goes as a terminal pastes, and the mirror follows the keys

- **Status:** Accepted (2026-10-24). Requested by the operator ("pegar imágenes también y mejorar la
  calidad, latencia y consumo"); the mechanism was measured, then chosen.
- **Amends:** [ADR 0079](./0079-on-a-desk-the-keyboard-is-the-keys.md) decision 3, "a paste reaches
  the pane as typed text", for the CLIs that take a paste; and [ADR 0058](./0058-the-bridge-watches-the-panes-a-browser-is-looking-at.md)'s
  one `pane` event a second, for a moment after a write.
- **Trail:** `web/src/hooks/use-direct-typing.ts` (`onPaste`, `pasteFiles`) ·
  `web/src/hooks/use-ordered-key-sender.ts` · `web/src/components/composer.tsx` (`terminalWrite`,
  `saveTerminalFile`, `scheduleKeyRevalidate`) · `bridge/guarded-send.ts` (`pasteFile`) ·
  `bridge/routes/reply.ts` (`paste-file`, `exclusive`) · `bridge/pane-watcher.ts` (`wrote`) ·
  `bridge/live-events.ts` (`LiveThrottle`)

## Context

Type into terminal sent every pasted character as a key, so a line break was Enter: a two-line paste
into Claude or Codex submitted its first line and typed the rest into the next prompt. A pasted or
picked picture did nothing. Measured 2026-10-24 on Herdr 0.9.5 and Claude Code at an idle prompt:

- A picture's saved path written as a bracketed paste of its own becomes `[Image #N]` in Claude's box;
  keys sent right behind it land before the token (`xy[Image #6]`), as ADR 0104 found for a send.
- zsh takes a bracketed paste of two lines into its buffer without running either. A program that
  never turned bracketed paste on would print the markers, and Herdr cannot say which panes did.
- While someone typed without pausing, the composer's post-key refresh was a debounce that never
  fired, so the mirror moved only on the watcher's one event a second: from a key to the mirror
  showing it took 443 ms at the median and 903 ms at p95 on a phone viewport (three runs, an idle
  shell, 114 keys at 70 ms).

## Decision

1. **A text paste to a CLI whose adapter reads a bracketed paste (`bracketedPaste`: Claude, Codex) is
   one bracketed paste with no Enter**, through `/reply` with `submit: false, paste: true`, in line
   with the keys around it (ADR 0023, ADR 0076). Every other pane keeps the paste as keys, as a
   terminal does for a program that never asked for the markers. A paste holding an escape goes as
   keys everywhere.
2. **A pasted, picked or dropped file is saved the way the composer attaches one and its path pasted
   in its place.** The upload starts at once (a file past 25 MB is refused before it starts); the keys
   typed meanwhile wait behind it, and a pane change frees the line from an upload (never from a write
   already on its way: the bridge would refuse a second write to that pane). For a picture on a CLI that
   attaches pasted paths (`pastesImagePaths`), the bridge (`paste-file`) counts the box's tokens, pastes
   the path, and waits until the box shows one more `[Image #N]`, or the path kept as text, before it
   answers, so the next keys land after the token; it stops waiting after 15 s, so it answers inside
   the phone's 20 s for a write, and pastes nothing into a box it cannot read. Any other file gets its path alone, as a
   paste where the CLI reads one and as text elsewhere. The route takes only a path straight under an
   uploads directory. A save that fails stops the mode as a failed batch does. A file saved after the
   mode ended, or for a pane no longer on screen, is not pasted.
3. **A write to a watched pane sets when it is read next**: 30 ms after a write that follows a pause,
   300 ms after the last write of a burst, and at least once per 700 ms through continuous typing, which
   can bring that read forward but never push it back; for 1.5 s after the last write the pane is read
   every 700 ms and each change goes out at once instead of once a second. The composer then stops its
   own refresh after a key while the stream is up and the mirror is on screen (it re-read the herd and
   the pane at every burst); without the stream, its refresh is a throttle that fires during a burst,
   never a debounce that waits for the burst to end.

## Consequences

- Measured against base on this host, five interleaved runs each with both bridges kept off the herd's
  journals (the PR description has every run): key to mirror, continuous typing, p50 333 ms and p95
  717 ms where they were 469 and 984; bursts of a word then a pause, p50 153 ms where it was 369, p95
  about level (563 against 523). Mirror reads per paragraph stay level (16 against 15) and bursts take
  14 where they took 33. Browser and bridge CPU came out at or under base at the median in every
  typing case. Under `strace`, the bridge made 560 Herdr calls for three paragraphs where base made 675.
- The gaps are the trade, and they were measured: reading every 30 ms after a write with events every
  200 ms brought the mirror to 61 ms but four times base's reads and about 17% more bridge CPU, and a
  120 ms settle fired between ordinary phone keystrokes. Lower the 700 ms only with a measurement that
  keeps the reads at base.
- A shell paste's first characters show about 150 ms later than when the phone re-read the pane itself
  (the read now waits for the bridge's), though the whole line shows sooner.
- Stopping at 15 s gives up on a starved Claude that reads a picture for longer (ADR 0117): the mode
  ends, the keys behind the picture are dropped, and its token may still arrive later. A send waits
  55 s; typing into the terminal cannot hold the line that long.
- Writes per key are unchanged: one request per key at human speed, fewer over a slow link (in-flight
  backpressure batches them). A paste to Claude or Codex is one request whatever its length.
- Pasting into a shell still turns each line break into Enter, as before. Making a shell's paste
  bracketed would need Herdr to report whether the program asked for it; reopen this then.
- A picture whose token never shows ends the mode with its path delivered and says to check Terminal;
  the keys typed behind it are dropped, never sent after an unknown box.
- A phone file picker that hides the page ends the mode on the way out, as any hidden page does
  (ADR 0077). The picked file then arrives with the mode off and becomes an attachment in the chat's
  draft: nothing reaches the pane that the operator did not see go in.
