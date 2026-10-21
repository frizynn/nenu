# Changelog

All notable changes to Nenu are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and the project uses
[Semantic Versioning](https://semver.org/). The newest `## [x.y.z]` heading **must** match the
`version` in `herdr-plugin.toml`, `package.json`, and `web/package.json` (enforced by
`scripts/check-version.sh`). See [`CLAUDE.md`](./CLAUDE.md) → *Versioning* for the bump policy.

## [Unreleased]

## [1.42.0] - 2026-10-21

### Added

- A running turn looks alive: "Working" glows with its time beside it in a quiet ink (9s), the step in progress and "Thinking…" glow, and the working mark turns slowly in the bar, Home, a project and the chips; only on screen, never under reduced motion (e6fc4d17, 5ebe2770, ab86cb45, f0bf4605, 721a6df7).
- Between steps a "Thinking…" row stands where the next step lands; the step in progress sits in its run and turns done in place, with no row jumping up (e6fc4d17).
- Steps, thoughts and the agent's words that arrive while you read ease in (e6fc4d17).
- A waiting message has Edit and Remove on its line, one tap each; one already in Claude's own queue is taken back from it, its words kept whole (a7f47870, 14060638, 62814399).
- `bun scripts/e2e/one-bubble.ts` fails when a sent message is on screen twice in any frame; `bun scripts/e2e/live-motion.ts` measures what the live motion costs (e89703c0, ab86cb45).

### Changed

- A message Claude reads mid-turn sits between the work it split: "Worked for 4s" above it and "Continued for 11s" under it add up to the turn (b028cbff, e0e3a118).
- A turn's line stands where it will be before Claude's log shows the turn; a queued message reads "Claude reads it after this step." (e0e3a118, ab79be90).
- A message Claude reads mid-turn is dated when Claude read it, not when it was queued (ab79be90).
- "Working for" counts seconds through its first minute everywhere (b028cbff).

### Fixed

- A message sent from Nenu no longer shows twice for a moment, as its bubble beside its queue row or beside the journal's turn (08c97564).
- Your message's bubble no longer shows its time as a faint tooltip over itself on a desk (721a6df7).
- Nenu again sees Claude's box when a draft of two lines puts "ctrl+g to edit in Vim" right after a long statusline; until now it refused to send and hid the text left there (b9d83a54).

## [1.41.1] - 2026-10-21

### Fixed

- A send to an idle Claude goes as one paste with Enter right behind it, confirmed by Claude's own log of that message, so a loaded host no longer strands it in the box or answers "check Terminal" for a message Claude took (5e4e9a8b, 20f584a0, 0209b5f6).
- Every wait of a send ends on its event within 15 s instead of a fixed 2.5 s window; a picture's wait runs on while Claude says Pasting…, and stops 55 s into the send (448928ae, 7f52df3a, 75deda75, dd44b6c0).
- A dialog Claude's session file reports refuses a send before typing and stops it before Enter, with no key pressed into it (5ade17f4, 31782d35, 9b23547f).
- A retry Claude's log places is answered sent without typing again; a picture that arrives after a send gave up is cleared too (0209b5f6, 9af7ccfa).
- The phone waits 110 s for a send, past the bridge's bound for a loaded agent (e7b8de48).

## [1.41.0] - 2026-10-21

### Changed

- A chat's work reads as T3 Code draws it, on a phone and a desk alike: "Worked for 12s" folds the turn with its time, several calls fold under "Ran 3 commands", a command is its row and opens in a shell's colours over its output in grey, a failure as "Error: Exit code 1"; thoughts are a row with a brain; a run keeps its rows and its state as calls join it or finish (0b29b720, 3aadc6af, 22e7ce9a, 12366e0f).

### Added

- Opening and closing a turn, a group, a command or a thought folds open in 180 ms and shut in 120 ms; under reduced motion it only fades; a search hit inside one is simply there (0b29b720, 3aadc6af, 22e7ce9a).
- `bun scripts/e2e/run.ts commands` replays the command demo at 1440×900 and 390×844 and checks the grouping (c5f2088b).

## [1.40.0] - 2026-10-21

### Added

- A coordinator's chat holds what its page did: the desk panel's Overview and a new Status tab on a phone, with Waiting on you, Routines, Status, Move and Close (120093ed, a50b25ae).

### Changed

- A tap anywhere on a coordinator's row enters its chat, on a desk and a phone; its threads fold down under the row, and the page in between is gone (only a coordinator with no live pane keeps one). 3 taps from Home to its box become 2 (120093ed).
- A ← back at the top left climbs coordinator → project → Projects, now on a desk too (120093ed).

## [1.39.0] - 2026-10-21

### Added

- Text in the agent's box shows beside the composer with Send it first, Add to my message and Discard; a Send over it waits for that tap and then goes, instead of sweeping it or queueing behind it for good; Don't send mine takes it back (14755815, 111c8994, b60eed62, 1a7befeb).
- Send after this turn, a row of the + while the agent works (111c8994).

### Changed

- Send while the agent works goes now, as its terminal's Enter: no "When should it read this?" question (111c8994).
- In the chat's Terminal view and a desk's Terminal tab the box types into the pane; back in the chat it is the chat's box, with its draft (111c8994).
- A stopped send says what is left in the agent's box and which button settles it, not "check Terminal" (14755815).

### Fixed

- Messages waiting in the queue are drawn in the thread at its end, with their pictures, never as a section over the chat (14755815, 111c8994).

## [1.38.5] - 2026-10-21

### Changed

- A state is a still glyph instead of a coloured dot, in the bar, Home, a project and the chat: a red alert waits on you, a blue check is to review, a grey dashed circle works, nothing at rest (13a17b47, e344eee0).
- The desk's bar reads resting chats in the muted ink, on 32px rows; what is alive keeps the full ink (65e2b047).

### Fixed

- A long chat name no longer widens the desk's bar: it ends in "…", and a sideways swipe can no longer cut the projects to "M" or float "N updates" past the rows (762beb09).

## [1.38.4] - 2026-10-21

### Changed

- Needs you, Working and PRs sit in the row under the box, beside the model; no line above the box takes the thread's height. In a narrow box (a phone, a docked thread) only Needs you keeps its word, the model's effort and context number step aside for them, and the branch and machine are one tap (1d576f22, 35381102, 289f8f7e, 1bb500ed).

### Fixed

- A picture pasted or attached with the phone's keyboard up no longer pushes the draft off the box's right edge (ebd2ccd6, 9c4b75bb).

## [1.38.3] - 2026-10-21

### Fixed

- Without a project, a desk's bar, its heading and the folded rail no longer say Projects; Home already opened on Recents (6411b5cf).

## [1.38.2] - 2026-10-21

### Fixed

- A picture sent while the agent works goes through the queue piece by piece, so Claude attaches it instead of leaving its path typed in the box (e576f3b0).
- A picture the agent keeps as its path goes as that path; a send that stops before Enter clears what it typed, and a queued row it cleared goes again, three times at most (5c076acd).
- Take over clears the terminal's copy of the draft while it still holds that text, so the queue and Type into terminal are no longer stuck behind it; a picture or paste only the CLI holds is left (55aed6e8, 7ebc9d44, ffd14340, d2aba238, fa27bb47).

## [1.38.1] - 2026-10-21

### Changed

- Everything that moves uses three lengths (120 ms controls, 180 ms panels, 280 ms pages) and one curve, `cubic-bezier(0.2, 0, 0, 1)`, script timers included (52a0efe8, 16c7f636).
- One 6 px status dot everywhere; one hover fill for rows and controls (cfd8f63f, d0660324).
- A desk's Home tabs are underlined like a project's (00559da8).
- Buttons and panel text sit on the type scale: no 14 px labels; row titles stay a step above their detail (24ba3b9a, 2c325a8e, 16c7f636).
- Icons at 12, 14, 16 or 20 px; icon buttons take the button's corner (de344040).
- A coordinator's page no longer repeats the Threads tab's count (4aec1cd0).

### Fixed

- Context: one mark per file header, repositories and branches drawn as the files' rows, prose line height, and a link to a listed file, also beside the linking file, opens it in place (fa4b694e, 13667a8e, 16c7f636).
- Routines read "next in 4h", not "next in in 4h" (01bebb07).

## [1.38.0] - 2026-10-21

### Added

- Projects is Home's first tab, beside Recents, Workspaces and PRs: projects where something moves first, the quiet ones folded at the end (63be049c).

### Changed

- On a phone a coordinator opens its page (its work and Open chat) from the project page and the drawer; Home reaches a project's coordinators in 2 taps, one more for each coordinator they sit under (020e76e4, df3ba4b5).
- A project's row on Home always opens the project; its page on a phone heads with what waits on you and leaves the goal out (63be049c, 020e76e4).
- Less on a phone's first screen: no idle count in Home's headline, no date, no History or task counts in the drawer, no workspace or agent counts in its footer, and Close coordinator moved to the end of its page (63be049c, 020e76e4).
- A coordinator's page on a phone offers New thread and New coordinator under it (0060e6f9).

### Fixed

- A working thread without a pane no longer reads "not running" in the navigation (a9878c0c).

## [1.37.0] - 2026-10-21

### Changed

- A coordinator's page lists only its live work; what finished is one "N finished" line to its History, no Summary and no report cards (3069c4af, d142080d).
- A tap anywhere on a coordinator card's head opens its page; the fold is its own chevron (bcd3105b).
- Open chat and New thread, Project chat and New: one button, same size and fill (bcd3105b).
- A coordinator's Waiting on you shows only what waits on you; its asks are on Status, done ones folded to one line everywhere (3069c4af, 5c06d6a1).
- An Asked line outside the format (`[in-progress] …`) reads as a request in progress or done, never under "Other lines" (5c06d6a1).
- A thread whose PR merged reads "merged, closes on its own" and no longer counts as to review, Home included (bcd3105b, 94b385df, d142080d, 28e2aad6, e1a24161).
- History sits after the live work on the project and coordinator pages, never beside it (b2dec9d9).

### Fixed

- An opened STATUS.md is drawn whole and scrolls with the page; it was clipped at 288 px and a wheel moved nothing (a3029ec6).

### Added

- `bun scripts/e2e/coordinator-page.ts`: the project card, the coordinator page, its buttons, Waiting on you, Status and its scroll, desk and phone (f5b7630f).

## [1.36.1] - 2026-10-21

### Fixed

- iPhone: closing the keyboard no longer drops the chat off its latest line behind the ↓ button; the terminal mirror follows the same rule (c12a566f, 38b922e0).

### Changed

- `bun scripts/e2e/keyboard-close.ts` fails when the thread leaves its tail (7e11cbca).

## [1.36.0] - 2026-10-21

### Changed

- The line above the box shows only what asks for you or runs (Needs you, Working, PRs); finished work and routines moved to the chat's ⋯ menu, which opens the same panel on its rows (5c33fb09, 12423225, 21ab5094).
- Stop is a round button in the box beside Send, so a running turn no longer takes a line of its own above the box (5c33fb09, 12423225).

### Fixed

- Opening a project's chat no longer folds an empty line shut two seconds in (2cb05671).

## [1.35.1] - 2026-10-21

### Fixed

- iPhone: closing the keyboard no longer leaves the app squeezed into the top half; it takes the keyboard's height only while a field is focused (00c928f3, d67cb9e1).
- iPhone: the app and the chat re-read the screen on focus, rotation and return, past a lost event, a zoom or iOS 26's leftover offset (00c928f3, d67cb9e1).

### Added

- `bun scripts/e2e/keyboard-close.ts`: seven ways to close the keyboard, in Safari and as the installed app (44062cbc, c51a2b03).

## [1.35.0] - 2026-10-21

### Added

- Home lists your projects: what waits on you there, how many agents work, how many to review and when each last moved; a row with asks opens where they are answered; rows chosen over cards and chips by a readers' test (8fcb8247, 5d430fff, cc81f7c6, 0d92303e).
- `bun scripts/e2e/home-projects.ts`: Home and the desk's chats over a busy herd, folded and unfolded, phone and desk (6a22aac1).

### Fixed

- The desk's chats no longer show empty "Last 7 days / Last 30 days / Older" headings: only periods with a chat on screen, named Today, Yesterday, Previous 7 days, Previous 30 days and Older; "Show N more" folds and unfolds with motion; period names stay on top while scrolling (6a22aac1).
- A chat's pull request glyph says what it asks: a draft's own glyph, red while checks fail, green once approved; rows take an inset focus ring and a 120 ms hover fill (6a22aac1, cc81f7c6).

## [1.34.1] - 2026-10-21

### Fixed

- Opening a chat asks for its conversation beside the pane, and a desk's panel code with it, instead of after the first render; only the chat's first read takes it, and only where the chat reads one (6f18064a, c50028d4, 555c6e0a).
- Artifacts reads the conversation in one or two requests, checks its files together, and no longer flashes "No artifacts" before and between them; three checks at a time (6067f081, 3848c844, d1303fa1).
- Context draws the last read at once on a return, starts reading when the pointer comes over the tab, and shows each file as its own card with its Markdown drawn, hanging from the file's name (2b3dd41a, 9ef22c34).
- Files draws a folder's last listing at once when it opens again, instead of "Loading files…" (4a7df066).

### Added

- `bun scripts/e2e/perf.ts`: tap to content on Context, Work, a thread, the project chat, Files and Artifacts, over a copy of a real project and real conversations, with each tap's reads in order; the copy's Herdr sockets all point at the bench's and nothing is written outside it (3c66e021, c94be377, 7dc8c70e, f5885ff5, 6d9b3736, 18517701).

## [1.34.0] - 2026-10-20

### Added

- Edit a routine from its project's Routines: when it runs, whom it reaches and what it asks, through Organizations' `routine set`; the first routine opens beside the list (05a641bc, 27a2ad10, 6d4fe864).
- History on a project's Work: everything finished by day, with a search; `bun scripts/e2e/project-page.ts` captures the page at a real project's size (27a2ad10, e56e58a1, 6d4fe864).

### Changed

- Work shows only the open work; coordinators that never ran a thread no longer show, so no name repeats; a row keeps its merged or closed pull request; a fold no longer re-reads the tree (27a2ad10, b3448861, 6d4fe864).
- Waiting on you reads as questions: the kind in red, what it asks, the recommendation, then Answer as a button; Your asks on a phone too (27a2ad10, 6d4fe864).
- A project's and a coordinator's header buttons share one size and centre on the title; tab counts are pills (27a2ad10).

## [1.33.0] - 2026-10-20

### Added

- Desk: drag the sidebar's edge and the right column's to resize them; arrows, Home/End and a double-click work too, and each width is kept per device (78333131).
- `bun scripts/e2e/panels.ts`: what moves when a thread docks and the panel folds, each grip, Changes beside a coordinator (78333131).

### Changed

- Desk: a thread opened beside its coordinator takes the panel's place at its width, and the sidebar no longer folds for it: nothing moves (78333131).
- Desk: the session panel slides open and shut instead of jumping, from a press only; ⌘⌥B stays instant (78333131).

### Fixed

- Changes beside a coordinator read its project's repository instead of saying its folder is not one; with none, it names the folder; a private-named folder is never read (537562e3, 44ff5dba).
- Desk: a narrow docked thread keeps its title whole (a3b9771f).
- Desk: a column that leaves mid-drag no longer leaves the page unable to select text (44ff5dba).

## [1.32.1] - 2026-10-20

### Added

- `bun scripts/e2e/run.ts phone-scroll`: every phone screen and two sheets scroll one box, and a drag moves nothing else, in Safari and the home-screen app; red on 1.31.1 (172fb86e, 60e7813a, bae05320).

## [1.32.0] - 2026-10-20

### Added

- A picture goes where you put it in the message: a numbered chip in the text and a thumbnail with the same number above it, the agent (Claude, Codex) gets it in that place as from the terminal, and the conversation shows it there (197235c9, cee5a98d, b5d781c0, 2c77c109).

## [1.31.2] - 2026-10-20

### Fixed

- On a phone only the thread scrolls: a drag on the box, the header or the thread no longer moves the chat, and the root opts out of the vertical rubber-band (9678c138, c02574ca).
- A conversation (`keep_open` thread) that ended its turn reads as a chat at rest, not as Needs you: off Home's headline, its list, the tab's badge and its workspace's state. A dialog on its screen still needs you; its own approved PR still reads as review, and a coordinator kept open reads as any coordinator (89006a72, c02574ca, 931327ec).

## [1.31.1] - 2026-10-20

The redesign's last polish pass (#101), ported onto the desk redesign. Parts main had already redone are left as main draws them.

### Fixed

- A Herdr outage is named once in a thread: the banner, else the question card, else one line above the box; the header keeps the pane's place (80e79104, 3d97ace0, 4e50db8e, 79023bec).
- Safari: the composer's placeholder no longer cuts in half at 375 px, and the box grows with a draft where the browser has no `field-sizing` (4e50db8e, e3d36a74).
- Settings in an iPhone's Safari tab says to add Nenu to the Home Screen for notifications, or that push needs HTTPS first over plain HTTP (d9ec7579, 7f1fe748, 07d58223).
- Native selects draw one field with a chevron in WebKit (56e550de).
- The model chip says Choose model until a model is known; the phone's Model sheet has a sheet's title, its rows on the same gutter (2474ae96, 31f2cd34).
- Docks and popovers share one header, named by the row that opens them: Quick replies, Model (dbd70f36).
- The send-while-working choice uses the cards' option list (b346a299, 1e3ea2ed).
- Project, Node, the activity views, the PR checks, the menus and the palette read on the type scale (15a667f7, bf51f75e, 508dc48b, 190f5d18, 482986e4).
- An empty Codex pane, Project not found and Thread not found use the shared empty state and button sizes; previews close on Done (a3f5a7f4, b3757f8f, 2c24d1f5).
- Touch targets reach 44 px (drawer home, Take over, the PR number, the PR toggles), and hovers fill only where a pointer hovers (cf61df37, 5374e8a5, 0e13adc3, 8d2e984c, c910cce5).
- A selected chat's age clears 4.5:1 in light (0a0c603b).

## [1.31.0] - 2026-10-20

### Added

- Desk: Projects in the bar, every project as a card; a project's page has Work (a card per coordinator with its threads, Open or Finished), Waiting on you by coordinator, Routines and Context (37f386af).
- Desk: a coordinator's page has Threads, Waiting on you, Routines and Status (37f386af).
- Routines say whom they reach and what they ask, and turn on and off from Nenu through `routine toggle` (37f386af).

### Changed

- Desk: Routines and Your asks leave the bar; their old links land on Projects and on each project's tabs. A project no longer opens on its coordinator's chat; Project chat does. The phone is unchanged (37f386af).

## [1.30.0] - 2026-10-20

### Added

- On a desk, a project pane's panel opens on Overview: this thread's state, coordinator, pull request, agent and context, its changes, and its coordinator's open threads (53c833d6, ef1c9bda).

### Changed

- The panel's tabs are Overview, Changes, Files and Terminal; Artifacts is a view inside Files (53c833d6).
- The project's Notes, Agents, PRs and Context are no longer in the panel (53c833d6).
- The Overview's changes refresh when the thread or its agent moves (98b173da).

## [1.29.0] - 2026-10-20

### Added
- Desk chat: the steps between two of the agent's texts fold into one line ("Ran 4 commands, read 2 files", +N −M), a table of steps when open, each opening onto its command and output with its exit code; the running step stays outside (c16199e7)
- Journal: a Claude command keeps its description and an edit its lines added and removed (3abb96ea)

## [1.28.0] - 2026-10-19

### Added

- A report reads in plain words once Herdr Organizations' summary agent wrote them for it; the agent's own words are one tap away (361f2145).
- "In plain words" asks the summary agent for them where Organizations offers it, on devices that may write (361f2145).

## [1.27.1] - 2026-10-18

### Fixed

- A file attached from the phone is saved to `~/.local/state/nenu/uploads`, so the path the agent gets no longer says collie; uploads already in `~/.local/state/collie/uploads` still preview and expire as before (c8dd64fb).
- `/file`, Render, the file tree and Open refuse the new uploads folder as they refuse the state dir (c8dd64fb).
- History's "off" notice, `collie-ctl.sh` hints, the Windows refresh hint and the user guide no longer say Collie where the operator reads them (63b25d49).

## [1.27.0] - 2026-10-18

### Added

- A thread whose pull request only waits for its merge reads Awaiting merge, folds with what ended around a chat and counts as done in a coordinator's Summary (fe945637).
- `bun scripts/e2e/origin.ts` walks twelve ways into a thread, a coordinator and a project in WebKit at 390 and writes where ‹ lands (b4faa5ce).

### Fixed

- ‹ returns to the screen you came from (Your asks with its filter, Home, Search, a thread's page) with its scroll, as the iPhone's swipe back does, instead of jumping to the coordinator or the project; only a screen opened from outside Nenu goes to its parent, once (b4faa5ce).

## [1.26.0] - 2026-10-17

### Added

- A question in Your asks and on a coordinator's card opens its context in place: the whole report of its thread, with tables, links, captures and documents, and Answer at its foot (37a6e23a).
- An ask and the decisions about the same thread or task read as one question, each part with its own Answer; rows that do not close stay apart (37a6e23a, 200ded52).
- A row that does not close says what is still open and where, and can ask its coordinator to close it or update the line (37a6e23a).
- A thread's page opens its whole report under the summary (Full report) (200ded52).
- `bun scripts/e2e/asks-context.ts` captures a records folder outside the projects root, a long report, a folded question and a row that does not close at 390 and 1440 (37a6e23a).

### Fixed

- Captures and documents of a project whose records folder is outside the projects root load instead of answering 404 (992d2378).

## [1.25.0] - 2026-10-17

### Added

- The model picker applies a model with one tap, checks the one running with its version, and keeps a failure in the sheet to retry (dca070f7).
- Effort sits under the model list: where the agent's picker has arrows beside it the value opens them, and tapping the running model confirms it; elsewhere it shows the value and when it is chosen (dca070f7, fa5e7c68).
- A phone's Back closes the model picker (dca070f7).
- `bun scripts/e2e/run.ts reading` captures tables, nested lists, the way back and the model picker on a phone and a desk (dbcdf59b).

### Changed

- On a phone, a table too wide for its grid reads one entry per row: its first cell as the title, the rest after their headers; a row is half as tall (41e1590f).
- A list item indented under another is drawn as its sub-item, one level in (41e1590f).

### Fixed

- The last line of a chat stands clear of the button back to the latest message (6c0dc8f4).

## [1.24.1] - 2026-10-17

### Fixed

- A project page no longer jumps when its STATUS.md arrives: it waits up to a second for it, and draws it at once when opened again (40c2cb32).
- A chat opened again paints its last conversation at once and refreshes behind it, no skeleton; a failed refresh says so (3951d4c1).
- A chat drawn from memory says it is updating when its read takes over half a second; losing read access forgets them all (8df71221).
- A direct load or reload shows one boot screen, the app's own frame, not the splash and then the frame (bbbda476).

### Added

- `bun scripts/e2e/load.ts` measures layout shift on a project, skeleton frames on a chat opened again and boot screens (3943d3d1).

## [1.24.0] - 2026-10-17

### Added

- "N updates" on Recents and on the desk's chats counts the rows with news and puts them in order on a tap (8973e065, cf7f209a).
- `bun scripts/e2e/calm.ts` measures taps while agents finish, Escape on Search, rows that move while quiet and how long an off-screen ask takes to show (de51bf50, 53943310, 0f74a2a7).

### Fixed

- A phone raises no toast when an agent finishes, only when one asks; the finish is New on its row (ADR 0094) (1b330e5d).
- Recents and the desk's chats keep their order while on screen: a row that finishes stays put with its New or +1, and reorders on a return to the page (a3291bd6, 8973e065, 8dfd31af).
- On a desk, a chat that asks for you past More still shows, after the rows on screen (8973e065).
- Escape on the phone's Search sheet clears a typed query and keeps the box, then closes the sheet (beec331c, f0d582f7).

## [1.23.0] - 2026-10-17

### Added

- On a desk, a thread's header goes up to its coordinator, named, and a node's to its parent (00fd14de).
- `bun scripts/e2e/run.ts back` walks into a project's threads and back, three ways, counting the history (33f76be0, 73a46e14, a4b2679b).

### Changed

- On a phone a thread shows the Chat, Threads and PRs band its coordinator does, in place of the sibling chips and the Threads button (00fd14de).

### Fixed

- The back control goes back instead of pushing its parent: three backs from a thread leave three entries, not eight more, and the system's Back from Home leaves Nenu (00fd14de, af59c3ee, 4841b653).
- A sibling takes the thread's place in the history; a phone's tab lives in the URL, so a reload or a way back lands on it (00fd14de).
- A coordinator's thread slides in as a push and back out as a pop; siblings cross-fade (00fd14de).
- The motion bench waits for its row in the page, not the sidebar's hidden copy (33f76be0).

## [1.22.1] - 2026-10-17

### Fixed

- A read of Organizations that failed is tried again with no file changed, so a restart no longer serves no asks until the registry moves (486c4b04).

## [1.22.0] - 2026-10-17

### Added

- A chip's panel floats over the thread: opening it moves neither the box nor the chat; a press outside, Escape and a phone's Back close it (3daf8f3c).
- A phone's row under the box keeps model, effort and context; branch and machine are one tap away, whole (3daf8f3c).
- Threads that ended fold into Working's Done group, muted; a chip with only finished work is drawn quietly (3daf8f3c).
- `bun scripts/e2e/run.ts composer` measures the box, the thread's scroll and layout shifts around each chip (89f6a4db, ca786daf).

### Fixed

- Opening a chat no longer folds its chips open and walks the conversation up (99cf86fe).
- A project's chat keeps its chips' line height while it settles, so chips that land late move nothing (ca786daf).

## [1.21.1] - 2026-10-17

### Fixed

- A coordinator reads as working, needs you or idle, never "Ready for review", on the project page, +, its page and for the project's own (c97249ae).

## [1.21.0] - 2026-10-17

### Added

- A decision waiting on you has its links as chips and Answer on its own line, where Organizations prints decision rows; answered, it waits on no one (ADR 0093) (fdd9dd55, 13bad973).
- `bun scripts/e2e/asks-answer.ts` answers a decision too (97e68ace).

## [1.20.0] - 2026-10-17

### Added

- Your asks narrows by project and coordinator, kept in its address; a coordinator's card lists its own the same way (ADR 0093) (33de679f, 4a7f3382).
- Answer on an ask that waits on you, through `asks answer` where Organizations takes one; answered, it waits on no one (9fd50c9b, 33de679f, 92dadefa).
- `bun scripts/e2e/asks-answer.ts [--before]` captures Your asks and a card at 390 and 1440 px (334de240).

### Changed

- An ask's links read as short chips with their state, not raw text (33de679f).

### Fixed

- A line that is only a parenthesis is no longer an ask or a decision, nor counted as waiting on you (9fd50c9b, 92dadefa).

## [1.19.0] - 2026-10-17

### Added

- + lists the projects; a project's step lists its coordinators and New coordinator, and a pick opens that chat (ADR 0092) (d81fde80, 062bf383, e6c8f5d8).
- A project with coordinators under it is their page: each folds over its card and work, its own first while it runs (9b2d5632, 7792d023, 062bf383).
- Move to…: an open node goes under another coordinator where Organizations offers `node move` for it (a026e2fb, 9b2d5632, a0526cf3).
- `bun scripts/e2e/coordinators.ts` captures both at 390 and 1440 px (f2fd8b4d).

### Changed

- A coordinator started from Nenu names `--can-spawn --kind=tab` instead of leaning on defaults (a026e2fb).
- New's Thread row moves into each project's step (d81fde80).

### Fixed

- A task row's age no longer shows through its actions (7792d023).

## [1.18.0] - 2026-10-16

### Added

- Your asks: every ask to every coordinator, grouped as Organizations' popup groups them; a row opens its coordinator (ADR 0091) (4a5e15e2, 44f75606, ff49cc08).
- A coordinator's page opens on its card: objective, what waits on you, asks, agents, PRs and tokens; the project's own at `node/root` (44f75606, e768bff2).
- `bun scripts/e2e/asks.ts [--quiet]` captures both in Chrome headless, with and without the fields (44f75606).

### Fixed

- An edit in the clock tick after the bridge hashed a file still changes its code stamp (53d05e10).
- The ctl suite's minimal-PATH case ignores a Tailscale installed in `/usr/bin` (f7a477bf).

## [1.17.0] - 2026-10-16

### Added

- Every file the chat hands over opens in a new tab as well as in place: links, code paths, images, cards and the Files, Artifacts and Project lists are real links to the file's own viewer page, `/pane/:id/file?path=`, which a long-press or a modified click opens; the viewer offers it too (More on a phone). It reads through the same routes as the viewer, never the raw bytes (ADR 0087) (0f90a91e).
- `bun scripts/e2e/run.ts files` follows every way to open a file in WebKit, the confirmed Open of a file outside the folder, and what the bridge must refuse (0f90a91e).

### Fixed

- One private-path policy guards every file reader: `.claude.json`, `.mcp.json`, Docker and Yarn credentials, shell histories and more are refused like `.env`; Mac keychains and browser profiles are refused by the preview and the lists as well as by Open; Nenu's own state is never listed; a pull request's diff names a private file without its lines (05cd0567, abd271c2).

## [1.16.1] - 2026-10-16

### Fixed

- The chat reads a message once, and its file list reads the same parse: a web URL or a link to one, its port included, opens as a link and draws no file card, `<https://…>` opens too, a fenced block names no file, and a 100 KB CSV reads in a millisecond instead of 3 s (cd99f097, 605ac859).
- A file card, an image or a video in the chat shows only once the bridge finds the file, and opens what it found; a name with nothing behind it draws nothing instead of a "Not found" card (605ac859).
- A table a phone would cut at its edge reads as rows, each cell under its header; one that fits stays a grid, its columns wrapping (dc83ee22).
- A push held back while Nenu was open on a screen no longer counts as sent, so that agent's next finish still reaches the phone; the bridge's journal logs what it did with each alert (26747a52).

## [1.16.0] - 2026-10-16

### Added

- Settings → Usage (off by default): tokens and API-list-price cost of Claude Code and Codex from their own logs, per day, agent, account, model and repo, with each account's plan limits, a year's activity map and the weeks and month by agent, model or repo. A background process reads the logs once and then only what is new; the cost is what the tokens would cost on the API, not what a plan charges (0c6b535f).

## [1.15.0] - 2026-10-16

### Added

- Settings → Machines → Show other machines (off by default): every machine Herdr has saved, its chats in Home, the sidebar and Search, New chat on any of them, each reached through its own Nenu over SSH. Off, Nenu looks and runs as before. Docs: "Several machines" in the user guide (505d34ef).

## [1.14.1] - 2026-10-15

### Fixed

- A shell's agent launcher is one folded row (Start Claude Code · Ask, its options a tap away), giving a phone's terminal 156px back, and it leaves while the shell runs a command, where Herdr can only refuse a start (f859e63d).

## [1.14.0] - 2026-10-15

### Added

- A tab of several panes is a row of its own in Home's Workspaces, the drawer and Search that folds its panes one level in, open when it holds the open chat or one needs you (b37539b9).

## [1.13.2] - 2026-10-15

### Fixed

- An open page takes a new build when the app comes back to the foreground, even in a chat, and offers it in a row only when unsent work holds it; a failed attempt is retried. Read this if your phone kept an old Nenu: open Settings → Updates → Reload interface once, and later builds arrive on their own (0d495895, ed0c966b, c0e83001).
- A video, picture or file the agent names relative to a repo below the pane's folder opens on the first request, from the newest folder the conversation names, inside the pane's folder only. Thanks @FacuVCanale (9d1a2c21, 69e6d88e, 6d5baa51).
- The chip that counts only the session's own work says Background, so it no longer reads as a second Working beside the turn (31e85e9d).

## [1.13.1] - 2026-10-15

### Fixed

- A workspace holding one session opens it from its row in Home's Workspaces, the drawer and Search, even with tabs of shells beside it (410b01a8).
- On a working chat the chips and Stop share one line above the box, giving the thread 40px back on a phone (b2b463e6).

## [1.13.0] - 2026-10-15

### Added

- Start and Replace coordinator ask for the harness, model and effort, with the last launch preselected; it needs Herdr Organizations with `open --harness/--model/--reasoning-effort`, and an older one still offers its profiles (f659522a, b742fe29, 921f835e).

### Fixed

- Start coordinator says it is starting until the chat opens, which now takes about a second instead of up to six, and a coordinator pane back at its shell can be started again (066c56d1, b742fe29).
- A Codex just started opens as an empty chat instead of the "No conversation linked" card, and one running without the shared daemon is recognised by the rollout it holds (8116d0c8).

## [1.12.1] - 2026-10-15

### Fixed

- On an iPhone, tapping the chat's draft opens the keyboard without sliding the header and the thread off screen: the tap focuses the draft with `preventScroll`, so Safari no longer scrolls the whole app up while the keyboard rises (351b8e8c, 6b9a436b).
- A workspace with one tab opens that tab from its row in Home's Workspaces, the drawer and Search, with no fold in between (8cf928b0).

## [1.12.0] - 2026-10-15

### Added

- Comment a changed line in any diff; comments wait as `file:line` chips over that thread's composer and go first in its next message (e736215f).

### Fixed

- A project's icon and tone picked in Herdr Organizations now draw in Nenu instead of its slug's mark (3e28abd6).
- A light chat on a desk no longer shows a grey band under its header or strip (aebd3c5d).

## [1.11.0] - 2026-10-15

### Added

- Each pull request shows the one button its state calls for (Merge, Resolve conflicts, Fix CI or Address comments), in Herdr Organizations' order, and a pushed branch without a PR offers Create PR; Organizations writes the request to the thread and says when it was already asked (5f81821a, 1f7ea7a4, f53ec136).

## [1.10.1] - 2026-10-15

### Changed

- A quieter desk: project glyphs never hash to red or amber (4d423046), the bar shows shortcuts only on hover and just the host in its footer (05381fd2, 50d888b9), and Home gets text tabs, a 22 px headline, grey state words, an outlined Answer and a flat PR row (0795e77f). The phone is unchanged.

## [1.10.0] - 2026-10-15

### Added

- Notes on a desk shows the project's status from Herdr Organizations (`project status`): Needs
  you, Working, Ready for review, Landing, Idle, To do and Done, one quiet row each, with a line
  that counts the project's problems and opens them. An older Organizations keeps the task list.

## [1.9.0] - 2026-10-15

### Added

- Each file row in Files and Artifacts shows the icon of its kind; a kind Nenu does not know keeps
  the plain document icon.

### Changed

- Home's pull requests are the PRs tab of the sessions' switcher (Recents, Workspaces, PRs), not a
  section, and the tab lists every PR the header counts.

### Fixed

- On a phone, a picture loading above the line being read, or the keyboard's strip opening and
  closing, no longer moves the thread.

## [1.8.0] - 2026-10-15

**The desk looks like Cursor's agents window.** Notes, Context and Routines read the coordinator's task list, the project's memory and its routines from Herdr Organizations' new JSON (its PR #25); with an older Organizations they say so and show what they can.

### Added
- On a desk, the session panel opens on Project: Notes from the coordinator's task list, Agents, PRs that open their diff in place, and Context with the project's memory and instructions; the panel slides when opened or folded and its toggle sits at the far right (ADR 0081). (c58aec09, fe7336b3, c72548a7)
- A row of chips above the composer (Needs you, Working, PRs, Routines), each with its panel, replaces the PR bar and the Background chip; the branch and the machine sit under the box. (17dfd095)
- A Routines page and `/api/org/routines`, read on demand. (483d4de8, 8b58b75b)

### Changed
- The desk's sidebar is Cursor's: New chat, Search, Home and Routines, a flat Projects list with glyph, state and age, chats by date; the tree lives in Search (ADR 0080). Needs you is a small dot, never a red fill. (eef80087)
- On a desk, a chat that finished or asks you is a +1 on its row instead of a toast; toasts that remain have a close button. (2ad950bb)
- The conversation reads like Cursor's: Worked with its duration, pull request links with their icon, a quiet bubble and Copy beside its time; running work flows in the chat and folds into Worked when it ends. (ca6bcbef, 6463a3f7)

### Fixed
- Unchanged prose skips its render on every poll. (791a18ad)

## [1.7.2] - 2026-10-15

### Changed
- On a desk, the coordinator's chat no longer lists thread cards, and the session panel's Terminal tab keeps the screen and the Type into terminal switch without the Keys tray: the physical keyboard is the keys (ADR 0079). (bbedd566)

### Fixed
- With Type into terminal armed, a physical keyboard sends Ctrl chords, Shift+Tab and F-keys to the terminal; before, Ctrl+C sent nothing and Shift+Tab arrived as Tab. (bbedd566, 3391990c)

## [1.7.1] - 2026-10-15

### Changed
- Every icon is Hugeicons Stroke Rounded from one facade, with Phosphor's sparkle for agents and chat circle for messages; lucide-react is gone. (eb6b26ac)
- Nothing animates on its own: Working shows a still dot, the top bar and loading skeletons are still, and running times count in minutes; CPU with Working on screen drops from 1.85 s to 0.17 s per minute (measured). (eb6b26ac)

## [1.7.0] - 2026-10-15

### Added
- Every project draws a glyph and a tone of its own, chosen from its slug and stable, in the sidebar, the drawer, Search, the collapsed rail and the project's header. (ca4c138e)

### Changed
- Cursor-style surfaces: three greys per theme and hairline borders, with text contrast measured on every surface; the dark theme's blue is lighter (dark text on blue fills) and the light theme's red a step darker, to keep 4.5:1. (ca4c138e)

## [1.6.1] - 2026-10-15

### Changed
- On a phone, pages push in from the right, the header's back slides them out, and Home fades, only on navigations the app starts; nothing animates on its own, and reduced motion or a desk only fades (ADR 0078). (948c0b92)
- A tapped notification opens its page in the open app instead of reloading it. (948c0b92, ba82c9f1)
- No note above the composer while only background work runs. (12270b0b)

## [1.6.0] - 2026-10-14

### Added
- On a desk, the session panel's Terminal tab shows the pane's screen with Keys and a Type into terminal switch; the + menu keeps Files and photos, Commands and Context (ADR 0077). (335b8af9)

### Changed
- Home leads with what needs you: the headline never names pull requests, PRs are one row each with ready to merge first, Workspaces lists each Herdr workspace once, and the coordinator box is gone. (fd91e999)
- The phone's tab bar is Home, New and Search: Browse is folded into Search and Needs you sits on top of Home, with its count on the Home icon; every count of what needs you is the same. (1b930e24, c891c425)

## [1.5.2] - 2026-10-14

### Fixed
- A long message sent since 1.5.1 reads in the chat as the text it held, without Claude's paste tags, and no longer leaves a second "Sent" copy under the reply. (03d7c893)
- A message from Nenu's queue is checked against Claude's log like a direct send: one Claude logs incomplete stays paused as incomplete instead of delivered, and a long "Send now" keeps its place in Claude's queue. (5f4aa03a)
- A Codex started without a Herdr client attached has its input box found, so sends no longer ask to "Type anyway". (ed1045c4)

## [1.5.1] - 2026-10-14

**Read this if you send long messages to Claude Code from Nenu.** Before this release, a message whose last part after 1,022 bytes was shorter than Claude's paste threshold could arrive without its beginning, and Nenu still said "Sent" (measured on Claude Code 2.1.296 to 2.1.300).

### Fixed
- A Claude message longer than 800 characters is sent as one bracketed paste, so it arrives whole, and a message Claude logs incomplete is reported as incomplete instead of Sent (ADR 0076). (4b92a164)
- The E2E bench refuses a Herdr that shares its config with the operator's, and `--herdr` starts an isolated one. (f6470435)

## [1.5.0] - 2026-10-14

### Added
- On a desk, each session has a panel with Changes (its branch or uncommitted work, with or without a pull request), Files and Artifacts, folded with ⌘⌥B; the project's Threads, PRs, Activity and Memory move behind ⋯ (ADR 0075). (4a788fdd, 22135014)
- Home asks in one row per pane, with Yes/No on a desk when the whole command shows; the headline counts idle agents and a desk filters by project. (f0db177f)

### Changed
- Icons draw at Lucide stroke 1.5, with new glyphs for New, Settings, the coordinator and Type into terminal, and 16/23 px navigation sizes. (ca0a353f)

### Fixed
- A dialog answered from Home shows only its receipt until the snapshot catches up. (ef71b0fe)

## [1.4.0] - 2026-10-14

### Added
- Attach any file up to 25 MB from "Files and photos", a paste or a drop anywhere on the chat; only images preview, and an upload is never served (ADR 0074). (e126b662, 175a06bd)
- Home lists every session, shells included, under a Recents / Workspaces switch, each row with its state, place and pull request; the choice is kept per device. (64058277)

### Changed
- Artifacts shows what the agent delivered and what it published on claude.ai, with a thumbnail only when Nenu can serve it; images named outside the pane's folder sit in one row that opens with confirmation. The Media tab is gone. (b8d5132d)

### Fixed
- A pane opened in a folder that holds Nenu's state no longer serves uploads or other state files through the file preview or Render. (e126b662)
- Resuming the Artifacts scan no longer reports that the conversation changed. (b8d5132d)

## [1.3.3] - 2026-10-14

### Fixed
- A busy Mac no longer reads as "Herdr isn't responding": time the bridge itself was stalled does not count against Herdr, a slow snapshot gets 15 s, and the event stream no longer carries `pane.updated` or resubscribes when a pane closes, so Herdr stops dropping it. (5511c5f6)

### Changed
- Example data in tests and the E2E bench uses neutral names. (a19a98ea)

## [1.3.2] - 2026-10-14

### Fixed
- A thread that finished and said it waits for you, with no dialog on screen, reads "Waiting for your reply" with a Reply button instead of "Asked you a question"; the sidebar says "needs reply". A real dialog still reads as before. (027c0b3c)

## [1.3.1] - 2026-10-14

### Fixed
- A Claude request with an auto-deny countdown is answered from Nenu instead of "The question changed in the terminal", and its card counts down to when Claude denies it. (98ca03fd)
- Codex's "Hooks need review" startup screen is answerable from the phone, and its pane shows as needing you instead of unknown. (388e35b6)

## [1.3.0] - 2026-10-14

### Added
- A pull request's size opens its diff: files, their +/− and folded hunks, read with git from the thread's folder, bounded and lazy-loaded (ADR 0073). (e8fc31bb)

### Fixed
- A shell pane starts Claude Code or Codex with New's agent and permission choice, and Claude's folder-trust prompt (2.1.296+) is answerable from the phone. (e6ea79f3)
- A message with images sent to Claude Code no longer stalls as "wasn't seen": the guard reads Claude's `[Image #N]` tokens, and the input box survives Claude's "ctrl+g to edit" hint. (53e03e9c)
- A phone's coordinator chat no longer lists its threads as cards under the conversation; the Threads and PRs tabs list them. (70f1d9e4)

## [1.2.0] - 2026-10-14

### Added
- Agents started by an agent: an agent launched with `herdr agent start <name>` stays quiet when it finishes a turn its launcher typed, unless you switch this on; a message you send it from Nenu still notifies. (e04eed80)

### Fixed
- The status line and subagent hooks keep working after `brew upgrade bun`: the installers write the bun on PATH, not the versioned keg. (e04eed80)

## [1.1.0] - 2026-10-14

**Read this if notifications were noisy or stopped arriving on an iPhone.** iOS revokes a web-push subscription after a few pushes that show nothing, and Nenu sent some; it sends none now. Your phone may need Settings → Push notifications turned on once more.

### Changed
- A finished turn notifies only when a person started it (a message from Nenu, or typed into a loose agent or a coordinator), never Herdr Organizations' own nudges or a coordinator's messages to its threads; once per agent until you look at it. Settings: Needs input, Replies to you, Subagent results, App updates; your Finished choice carries over (ADR 0072). (71b51967)

### Fixed
- Every push shows a notification: no retraction pushes, no pushes hidden while a tab was visible. Nothing is pushed while Nenu is open on a screen, and the open app closes handled notifications. (71b51967)

## [1.0.2] - 2026-10-14

### Fixed
- A session opened in Nenu stops showing as finished-and-unseen (green): Herdr's `done` only clears on a desk focus, so the snapshot now reports `done` only until you look in Nenu (ADR 0071). (097d12df)
- Each agent gets its own notification, saying who, what it answered and where, instead of a count like "2 agents finished"; each has its own push collapse topic, so a phone back online gets every agent's latest alert (ADR 0070). (4fe7de8c)

### Changed
- Issues and pull requests ask for versions, reproduction steps and visual evidence: before/after screenshots for a visible fix, a screen recording for a feature or interaction. (255b6652)

## [1.0.1] - 2026-10-13

### Fixed
- An unchanged herd reads unchanged: pane tokens come out in a fixed order, so the bridge stops publishing ~130 false change events a minute and the snapshot can answer 304. (2b515eaa)

### Changed
- The phone revalidates the snapshot with its ETag and keeps the herd it holds on a 304; Home moves 76% fewer bytes and renders 68% less, a chat 50% and 42%. (a453756f, 1977c8b5)
- The queue reads one pane from Herdr instead of the whole herd. (00c64040)
- Activity and subagent reads that found nothing new no longer re-render. (1977c8b5)

## [1.0.0] - 2026-10-13

**Upgrade from 0.x once with the old id:** `herdr plugin action invoke update-major --plugin herdr.collie`.
From then on every command takes `--plugin herdr.nenu`.

### Added
- Settings → Notify when has a switch per kind: Needs input, Agents finish, Threads finish, Coordinators answer, Subagent results (off) and App updates. (0b4191e9)
- Agent messages render LaTeX math (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) as MathML, loaded with the first formula. (799d9d8c)
- `skills/nenu-onboarding`: an agent skill that checks an install and finishes what is missing. (d60bcb77)

### Changed
- The plugin id is `herdr.nenu`, the LaunchAgent `herdr.nenu`, the systemd unit `nenu`, the Windows task `herdr.nenu` (were `herdr.collie` / `collie`). (6c72d4b5)
- The first start as `herdr.nenu` copies the `herdr.collie` config once and retires the old service; a linked checkout drops the stale registry key. Only the installed plugin migrates. (6c72d4b5, 9cb18022)
- A notification names who finished (thread title, project coordinator, pane label), the first line of its answer and where; a prefs file from before keeps Finished for threads and coordinators. (0b4191e9, 633e8849)
- A herd notification that shrinks sends nothing; a phone re-alerted on every replacement. (0b4191e9)
- `COLLIE_*` settings, `collie-ctl.sh` and the state directory keep their names (ADR 0068). (3cf68d47)

### Fixed
- Release notes for an `x.0.0` print `update-major`, which is what crosses a major. (3cf68d47)
- `push-test` reads the subscriptions the service saved; it reported no devices with a phone subscribed. (ffd02428)
- The PRs tab lists open PRs of open threads with their state in words; resolved threads' PRs fold into History, and a 0/0 diff is no longer drawn. (349abdcd)

## [0.65.2] - 2026-10-13

### Fixed
- Choose a folder shows home's folders at once on a phone: recent folders are one row of chips instead of a column that pushed the list below Use. (62be8db0)
- A bare `file:///…` path in an agent's reply is a link that opens the file in Nenu. (911f2f15)

## [0.65.1] - 2026-10-12

### Added
- Drag a tab to reorder it (hold 450 ms on a phone, drag with a mouse on a desk), plus Move left/right in its sheet; Herdr's `tab.move`, audited. (#100)
- Copy on every agent reply (its Markdown) and every table (Markdown text plus HTML cells). (#100)

### Fixed
- The tab and pane strips scroll sideways with a finger again. (#100)
- Display shows only what changes the view on screen: Text size scales the chat; Wrap lines, Tap to type and its text size belong to the terminal mirror. (#100)

## [0.65.0] - 2026-10-12

### Changed
- Native-feeling redesign across the app (#68, #70-#98): shared design tokens and primitives; phone screens with a native back button and bar title; tab and pane strips as single chips; one New flow from every entry; Home with a noun headline, compact Needs you rows and send-to-coordinator; the work turn reads as a timeline that says what it does now; chat prose at reading size with Wrap and Copy on code; dialog cards that say what is approved and why it is paused, menus and previews inside the card, 44 px controls; a one-box composer that leaves room for the keyboard and names why it is locked; composer docks with filled keys and chips, one row for the queue; history controls clear of the home indicator; Settings as a grouped list; full-screen file preview and a photo viewer with native gestures on the phone; notices, banners, 404, crash, boot and pause that never cover what they report.
- The logo opens a side drawer from the top: Needs you, the 5 most recent chats, then folded Projects and Workspaces ordered by activity; a subagent's view is clean and offers writing to it through Main. (#69)

## [0.64.4] - 2026-10-12

### Fixed
- With only background work (subagent, workflow, monitor, goal) and no main turn, a message goes straight to the agent: no now/queue choice, "↓ to manage" no longer reads as a dialog, and queued rows no longer wait for the background work. (#66)
- Scrolling up in a chat loads older messages on its own and keeps your place. (#67)

## [0.64.3] - 2026-10-12

### Fixed
- A question from the agent is the chat's last item, inside its scroll: the conversation scrolls over it, options are compact (Recommended as a small tag) and the secondary actions are a quiet row. (#63)
- System notices, other sessions' messages, hook feedback, interruptions and compaction summaries read as one grey expandable line, and a loaded skill as "Skill · name" under your message, never as your bubble or a big System block (Claude and Codex). (#64)

## [0.64.2] - 2026-10-11

### Fixed
- The chat keeps following the newest turn: a scroll event that arrived after rows or "Working…" landed no longer reads as you scrolling away, which froze the chat, hid Working… and showed the arrow at the bottom until tapped. Same for the terminal mirror. (8cbae61)
- "Working…" shows under your message as soon as the agent has it, and follows the CLI's own turn state like Stop, instead of waiting for the journal row and Herdr's status (measured 0.16-1.6 s behind). (fb2e278, c390b51, d82329d)

## [0.64.1] - 2026-10-11

### Fixed
- The composer's controls sit on the iPhone's home-indicator inset (34px, was 42) and 8px above the keyboard (was 42); 8px where there is no inset, 16px on a desk as before. (d131043)
- **Installed iPhone app: remove Nenu from the Home Screen and add it again.** The status bar is now opaque, because iOS 26+ lays a black-translucent home-screen app out one status bar short of the bottom, which left ~60pt under the composer; iOS reads the style only when the app is added. (266b1dc)

## [0.64.0] - 2026-10-11

### Changed
- Whether a turn runs comes from the CLI's own state, not the screen: Claude's `sessions/<pid>.json` plus its transcript, Codex's rollout, watched per pane and attached to the snapshot; Stop's button and press read the same entry, so Stop works under a custom statusline and while a workflow runs (ADR 0067). (#60)
- Background work lives in one chip under the composer ("● N running", "1 waiting on you", quiet "N done"): a compact list with expandable rows and a side panel or in-sheet details, never full screen; the ⋯ menu drops to the rows it alone owns. (#59)
- One primary button: Stop when the composer is empty and the agent works, Send otherwise; while typing, Stop sits in the "Working for…" row. (#59)

### Added
- A note above the composer when only background work runs ("Stop doesn't reach it"). (#60)
- An idempotent, reversible installer for Nenu's Claude observer hooks (optional; Nenu works without them). (#60)

## [0.63.0] - 2026-10-11

### Added
- Stop: while Claude or Codex works, and from sending until the turn starts, Stop takes Send's place (both show with a draft); Esc on an empty composer does it on a desk. One press sends one Esc ("Stopping…" until idle, so Claude's Rewind never opens), a stop that would make the CLI send its own queue asks first, and messages still in Nenu's queue are held until you send them. Agents without a measured interrupt key get no Stop. (#57)

### Fixed
- Codex's "Waiting for background terminal" counts as a running turn. (#57)

## [0.62.0] - 2026-10-11

### Changed
- A workspace has no page. The sidebar, search, the rail, the phone's Browse and an old `/space/:id` link all open the same pane: the agent asking for you, else the one you had open last, else the active tab's. Its tabs and panes are the strips above the chat, and a workspace pane's title no longer opens an overview. (35a0956, c4cb3c3)
- On a desk every page (Home, a project, a node, Settings) starts on the header's gutter in one column, 760px growing to 960px on a large screen; every header is the same 52px bar, and a chat's composer takes the conversation's width. Settings no longer boxes its header into a narrow strip. The phone is unchanged. (ba9eb62, c4cb3c3)

### Added
- A workspace with no pane shows an empty chat that starts an agent or a shell. (35a0956)
- `bun scripts/e2e/run.ts workspace` opens each workspace from every way in; `layout` captures every page at 1280, 1440 and 1920 (sidebar open and folded), 900 and 390. (096d3ba, c4cb3c3)

### Removed
- The workspace page, and `bun scripts/e2e/run.ts space`. (35a0956, 096d3ba)

## [0.61.0] - 2026-10-11

### Changed
- The workspace page shows the workspace's name and folder, its tabs as tabs (rename and close behind ⋯) and the shown tab's panes with their state and last activity, one tap from the chat; the row of every workspace and the "All" filter are gone, and it uses the project pages' frame. (e54a4d4, 2f82aa1, 6b16a65)
- A workspace holding a single pane opens straight onto it, from the sidebar, the rail or a link. (e54a4d4, 2f82aa1)
- A tab Herdr numbers by position reads "Tab 1" in the tab bar, the sidebar and the chat title. (e54a4d4, 2f82aa1)

### Added
- `bun scripts/e2e/run.ts space` captures the workspace page in each of its shapes, phone and desk. (25c2567)

## [0.60.0] - 2026-10-11

### Changed
- Every project view (project page, coordinator panel, phone Threads tab, sidebar, cards, Home) reads one organization model, as Herdr Organizations' popup does: only open work in the tree, coordinators first then needs you, review, working, idle; everything resolved lives in one grey History tree where each resolved coordinator holds the threads it ran. (#54)
- Tapping a node opens its chat, or its detail at `/project/:slug/node/:id` when it has no live pane; nothing redirects on its own. (#54)

### Added
- Replace coordinator on the project coordinator row: pick the agent, Organizations' `coordinator replace` stops the running one and starts the new one. (#54)

### Fixed
- Closing a coordinator that still has open work is refused with "Close its work first", in the client and the bridge. (#54)

## [0.59.0] - 2026-10-11

### Fixed
- Claude's own bookkeeping rows (image sizes after a Read, loaded skill bodies) no longer show as your messages or split a turn's work log; other meta rows are System notes, and `/command` and `!` input read cleanly. (#49)
- "Read it now" on a queued Claude message sends one Ctrl+Enter, then says it asked; a repeat or late tap no longer ends in a 409, and API errors read as a sentence, never a route with JSON. (#50)
- Closing a tab keeps you in its workspace on the neighbouring tab (left, else right), from Nenu or from Herdr; only an emptied workspace goes Home. (#51)
- File cards resolve names against the folders the chat itself names and `~/`, say "Not found" instead of opening a 404, and compaction summaries no longer produce cards. (#52)

## [0.58.0] - 2026-10-10

### Added
- Recent on Home: the latest chats with state, place, "New" when one finished unseen, and how many agents are working. (d22d027e)
- Enter in the sidebar search opens the best match, as Home's Jump box did. (fea1260b)

### Changed
- Home is one column on a phone and a desk: composer, Needs you, Recent, Ready to review (five, then Show all), running workflows. Projects and workspaces stay in the sidebar. (d22d027e)
- Needs you says "Nothing needs you right now" once dialogs were read. (fea1260b)

## [0.57.0] - 2026-10-10

### Added
- The project page shows its organization when the coordinator is not running: a Start coordinator button (Organizations' `open`), open threads nested under the coordinators that run them (most urgent first), and resolved ones folded. (4c7f314d)
- New coordinator beside New thread, with a parent (project root or an open coordinator) and a profile; upstream herdr-projects gets top-level threads only. (540f879f)

### Fixed
- New thread works without templates; it used to end in "No templates yet" on every Organizations release. (540f879f)

## [0.56.0] - 2026-10-10

### Added
- Ready to review lists every open PR you authored in the repos your agents work in, read from GitHub with `gh`, with checks, diff and review state. (ebb01f67)

### Fixed
- Ready to review no longer lists failed background commands. (ebb01f67)
- Closing a thread works with upstream herdr-projects (`thread resolve --keep-worktree`) when Herdr Organizations is not installed. (292513d5)

## [0.55.0] - 2026-10-10

### Added
- Open a file the preview refuses (outside the agent's folder, too large, unknown type) in a new tab after a confirmation, through a single-use two-minute link; HTML and SVG stay sandboxed with no network (ADR 0063). (caca6838)

### Changed
- Compact composer: one line with the send/stop button inside, and a quiet row below with attachments, a menu, model, effort and the context ring. (dcc92597)

### Fixed
- Open refuses macOS keychains, cookie stores and browser profiles. (3d0e871f)

## [0.54.4] - 2026-10-10

### Fixed
- `file://` links an agent writes open their real path instead of a bare name that 404s. (7aa287fa)
- A file outside the agent's folder says so, with the full path, Copy path and "Open from <agent>" when another pane owns it. (7aa287fa)

## [0.54.3] - 2026-10-10

### Fixed
- **Queued messages could be lost on restart.** When launchd refused a restart, the fallback bridge used the action's state dir, so the next supervised start no longer saw its queue. Both now use the same dir, and `start` waits for launchd to finish tearing down. (398769d2)
- A queued message that leaves the queue with no delivery record now says so instead of showing "Sent". Delivered records stay listed for two hours so a sleeping phone can still tell. (a8241441)

## [0.54.2] - 2026-10-10

### Fixed
- HTML previews no longer come up blank in Safari: the frame allows Nenu's own host, not only the sandbox's opaque 'self'. (02d45118)
- The HTML viewer opens a page full screen on its own tab, so a pinch zooms the page instead of Nenu. (02d45118)

## [0.54.1] - 2026-10-10

### Fixed
- Home's Ready to review shows one failed command per thread and skips commands stopped by a signal, so cut gate waits no longer flood it. (96d5bb5b)

## [0.54.0] - 2026-10-10

### Added
- Redesigned shell: desktop sidebar with the Organizations project tree, loose workspaces and a collapsible rail; phone tab bar with New in the middle. (93ac4856)
- Home answers what needs you in place, lists PRs ready to review, projects and workspaces. (e16497dd)
- Project view: coordinator chat with thread cards, threads/PRs/Activity panel, split view with tabs and a PR/CI bar with Merge, auto-fix and auto-merge. (43161711)
- One New dialog for thread, tab, workspace, project and quick chat. (b28c916f)
- Sending while an agent works offers Send now or Queue for later, and rows follow each CLI's own queue. (3b9d0af8, 62bd2189)
- One QuestionCard answers every dialog, with notes and typed answers. (d5d8a584, 8cac5dd6)
- Images, artifact cards and a sandboxed HTML viewer in chat. (781853a0)
- Claude workflows, background commands and artifacts in the chat and Activity panel. (40c52c02, 64b05af8)
- Opt-in observer hooks for Claude Code. (16df8cb9)

### Changed
- A send is one request; the bridge types, verifies and submits. (84fa17c1)
- The bridge watches only the panes and journals a page shows; the browser polls less. (f4fcf096)
- Journals are read incrementally; Codex history is paged. (1df29d0b, 74d58d06)
- Projects are read from Organizations' `--json` contract, files stay as fallback. (8af33440)

### Fixed
- A retried send is never typed or submitted twice. (3094d8ee, 259294d4)
- Typed text no longer reaches the audit log at a password prompt. (034e917c)

## [0.53.0] - 2026-10-09

### Added
- Navigation and Home browse chats by Herdr workspace, then tab, then a split tab's panes, each with its session title and state. Projects and Recent stay in the same switch. (0dd3d9ad)

### Changed
- Home's folded workspace list at the bottom is replaced by that browser near the top. (0dd3d9ad)

### Fixed
- Claude's usage-limit pause shows as one quiet line instead of a "terminal is waiting" panel; a real unrecognised wait is a compact row you can expand or dismiss. (38b56c3e)

## [0.52.1] - 2026-10-09

### Fixed
- A slow read on iPhone no longer replaces the open chat with "Something went wrong". (e2b93097)
- One missed Herdr reply no longer reports the herd disconnected. (a28b2b7d)

## [0.52.0] - 2026-10-07

### Added
- New chat offers Claude Code's Auto permission mode. (e51fb084)

## [0.51.0] - 2026-10-07

### Added
- Sidebar switch between a per-project tree (coordinator, tasks, history) and the recent list. (23a26b6e)

### Fixed
- The composer gives the draft the full width above a slim toolbar; long drafts no longer clip. (b3968d7a)
- Home's activity test no longer depends on the hour it runs. (5874892b)

## [0.50.0] - 2026-10-07

### Added
- Home is a live command center: what needs you, agents by state, recent activity, project progress, a Start a chat prompt and a ⌘K jump list. (a14a6c84)

### Changed
- The project Chat | Tasks switch moves into the header as one Tasks button; tab strips hide while the phone keyboard is open. (04a8cc58)

## [0.49.0] - 2026-10-07

### Added
- Live updates reach the browser over a same-origin event stream; polling becomes a fallback. (1a0c56dc, 380fdf43)
- Images attach as "Image N" chips with thumbnails, multi-select, paste, retry and remove. (513c2d34, ec2b7fda)
- Sent messages show at once as pending bubbles that reconcile with the transcript. (513c2d34)
- One New chat sheet creates a tab or workspace, starts Claude Code, Codex or a shell and queues a first message. (ac88ada9, 4bb8ca75)
- Project hub: sidebar with projects and chats by recency, coordinator chat with a task panel, Chat | Tasks on mobile. (575840bc)
- In-app confirm dialog replaces browser confirm and alert on projects. (575840bc)
- New chat picks a folder by browsing home and starts Claude Code or Codex with a chosen permission mode. (1e5f316a, e2da197d, fa0fbe58)
- Model and effort chip inside the composer row. (5314982d)

### Changed
- Send verification re-reads the input box within tens of milliseconds instead of a fixed 350 ms. (f735539c)
- One theme token set; quieter Home workspaces list; plain queue and delivery copy. (0064b6b5, 61f96119, 1a46e7e2)
- Keys, Type, Quick, Commands and Display move from the composer into a grouped ⋯ menu. (5314982d)
- Chat-style transcript: right-aligned user bubbles, plain agent text, quiet times. (00b239ef)
- Slimmer mobile header, tabs and segmented controls. (5314982d, e2da197d)
- The folder picker loads on demand, outside the main bundle. (93d3f579)

### Fixed
- Starting an agent on a brand-new pane no longer fails on a stale snapshot. (612a4074)
- Destructive buttons are readable in dark mode. (d029b599)
- Bypass and Full access are never preselected in New chat. (c1830c8f)

## [0.48.5] - 2026-10-05

### Fixed
- Resume live conversation following after saving a message and refresh active work sooner. (8411159d)

## [0.48.4] - 2026-10-05

### Fixed
- Restore the habitual conversation layout. (9c3e55d8)
- Attempt explicit Codex sends immediately through guarded native input; retain dialog and draft protection. (9c9fb2d1)
- Unblock ready-terminal queues, expose current Codex Stop, and render compact image previews. (39616d3c)
- Show asynchronous questions outside work logs and share concurrent identity reads without retaining stale inventories. (39616d3c)


## [0.48.2] - 2026-10-05

### Fixed
- Publish fresh pane/tab state before acknowledging rename or close; read Claude session names in the background. (e837f9bd)
- Retain post-send chat refreshes when another history read is pending. (e837f9bd)

## [0.48.1] - 2026-10-04

### Fixed
- Align chat attachment and Send controls with the text field in one compact row. (c6c7a48e)

## [0.48.0] - 2026-10-04

### Added
- Save chat messages before delivery, wait through terminal dialogs, and verify input consumption. (cc1196d4)
- Show Claude overlay menus and Codex update notices in the conversation. (cc1196d4)

### Changed
- Keep the chat composer for attachments, text and Send; move tools to the header menu. (cc1196d4)

## [0.47.2] - 2026-10-04

### Fixed
- Keep the header chat/terminal toggle icon-only with its accessible label and 44 px touch target. (698e9ccf)

## [0.47.1] - 2026-10-03

### Fixed
- Recover existing Codex conversations automatically from unique live terminal titles and loaded session metadata (0c3e03ea).

## [0.47.0] - 2026-09-30

### Added
- Show project templates and let operators start or close organization nodes. (12ff937)

## [0.46.5] - 2026-10-04

### Fixed
- Recover existing Codex conversations automatically from unique live terminal titles and loaded session metadata (3719999c).

## [0.46.4] - 2026-09-30

### Fixed
- Record every send that was typed but not submitted (or refused, or failed) as a `reply.unsent` audit entry with the phase, each verification read, the last draft and a short screen tail. (126da2b)
- Say whether a stalled send could not read the terminal (connection) or did not see the message in the input box. (8ecab5c)
- macOS: find the Tailscale CLI under launchd's minimal PATH, and stop reporting a lockout when `COLLIE_PUBLIC_HOSTS` already lists the host. (0042e3f)

## [0.46.3] - 2026-09-30

### Fixed
- Preview files Claude sent with SendUserFile from outside the pane's folder instead of "File unavailable in this workspace." (2e458ca)

## [0.46.2] - 2026-09-26

### Fixed
- Discover native Claude sessions when the background service has a minimal PATH. (a38fe7f)

## [0.46.1] - 2026-09-26

### Fixed
- Keep Claude background agents visible during long tools while their original runtime is alive. (991060f)
- Show native Claude context and five-hour/weekly usage before history loads, directly above the composer. (991060f)
- Use Claude and OpenAI logos in the model selector. (991060f)

## [0.46.0] - 2026-09-26

### Added
- Open subagent conversations in the main chat and return to Main with the draft preserved. (b95a893)
- Browse the working directory as an expandable tree; search and filter recent artifacts by type and extension. (b95a893)

### Fixed
- Collapse inactive agents and distinguish designboard canvases from HTML source files. (b95a893)
- Preview designboards in view mode so their editor does not cover the canvas on phones. (b95a893)

## [0.45.7] - 2026-09-26

### Fixed
- Keep the server reply guard independent of React and browser transport dependencies. (4a406a2)

## [0.45.6] - 2026-09-26

### Fixed
- Pause hidden conversation, queue, subagent and update reads; catch up when their view resumes. (6bb1a5b)
- Share concurrent journal reads and reuse bounded history encoding across clients. (6bb1a5b)


## [0.45.5] - 2026-09-26

### Fixed
- Retry brief signal losses quietly, preserving drafts and cached conversations. (d76b531)
- Keep interface updates in Settings and wait for downloads before reloading. (d76b531)

## [0.45.4] - 2026-09-26

### Fixed
- Keep Send enabled and connection status stable during slow successful refreshes. (9a6ff29)

## [0.45.3] - 2026-09-26

### Fixed
- Avoid freezing the chat while scanning tool output for artifacts. (24a09cc)
- Keep document modules available across updates and checkout changes. (24a09cc)
- Defer automatic page reloads while a chat or terminal is open. (24a09cc)
- Stage root frontend builds before replacing the served app. (24a09cc)

## [0.45.2] - 2026-09-26

### Fixed
- Recover Claude subagent task names, nested relationships and native completion states. (6b747f9)
- Separate current subagent activity from history and show readable Claude model names. (6b747f9)

## [0.45.1] - 2026-09-26

### Fixed
- Preserve drafts and enqueue identities across connection loss and reloads. (d20721e)

## [0.45.0] - 2026-09-26

### Added
- Inline image/video previews, project browsing and session artifacts. (5180a75)
- Persistent message queue with editing, explicit delivery and background dispatch. (5180a75)

### Fixed
- Resume live polling immediately after the phone returns from background. (5180a75)

## [0.44.1] - 2026-09-26

### Fixed
- Claude hook installation uses the same configured state directory as the supervised bridge. (255ec79)

## [0.44.0] - 2026-09-26

### Added
- Per-session subagent inspector with live status and separate read-only conversations for Codex and Claude. (3f487bf)
- Claude lifecycle hooks, incremental transcript reads and session-bound child access. (3f487bf)

## [0.43.0] - 2026-09-26

### Added
- Command and Option modifiers, backward delete and Shift+Tab in Terminal keys. (61f2539)

### Fixed
- Wait for a queued terminal chord to finish before accepting another key. (61f2539)

### Changed
- Quieter chat tabs, header, composer and terminal keypad with mobile touch targets preserved. (61f2539)

## [0.42.1] - 2026-09-26

### Fixed

- Keep chat and terminal navigation visible while drafting; group secondary editor actions (`b9051ca`).
- Recognize Codex's typed-message footer before verifying and submitting replies (`b9051ca`).
- Paste Codex multiline replies atomically and wait for cleared terminal drafts before replacement (`b9051ca`).

## [0.42.0] - 2026-09-26

### Added

- Start Codex and Claude Code from an empty mobile terminal (`84d989f`).
- Recover a missing Codex history connection using the local app server (`84d989f`).

### Fixed

- Load conversations even when the session hook is missing; recover Claude identities from native processes (`84d989f`).
- Keep new Codex session hooks scoped to their terminal and reset history when the connected session changes (`84d989f`).
- Recognize Codex 0.157 shortcuts footers so the first mobile message can be sent safely (`84d989f`).

## [0.41.2] - 2026-09-21

### Fixed

- Verify typed Codex messages while Astra sparkle remains active, restoring decorative cells to spaces (`70c92b0`).
- Bind terminal draft replacement to the same text across animation frames, retaining dialog and tail guards (`70c92b0`).

## [0.41.1] - 2026-09-21

### Fixed

- Send from an empty Codex composer without mistaking its animated background for a terminal draft (`cf283b5`).
- Clear only a freshly read terminal draft and preserve safe retries after a send was refused before typing (`cf283b5`).
- Keep keyboard composition from triggering an early message submission (`cf283b5`).

## [0.41.0] - 2026-09-21

### Added

- Discover Herdr Projects in Home and navigation, with coordinator and thread views (`52eafcf`).
- Browse files and local photos across available chat history, including journal-verified Nenu uploads (`52eafcf`).
- Interrupt an active Codex turn with a guarded Stop control (`52eafcf`).

### Fixed

- Open the chat view when a new mobile shell becomes Codex, without leaving and reopening the pane (`52eafcf`).

### Known limits

- Uploaded photos retain the existing 48-hour lifetime; deleted files and images without saved local paths are unavailable.

## [0.40.5] - 2026-09-12

### Changed

- Keep pane status indicators static and communicate activity through colour alone (`fa8ebbf`).

## [0.40.4] - 2026-09-12

### Fixed

- Use the same compact one-row mobile header on Home, projects, chats, history, and Settings (`3cf4ef7`).

## [0.40.3] - 2026-09-12

### Fixed

- Verify model and reasoning changes in the terminal; handle wrapped descriptions and Claude models without reasoning controls. (b150125)

## [0.40.2] - 2026-09-12

### Fixed

- Mobile chats use one compact header with workspace navigation, search, history, terminal toggle, and a color-only status indicator. (9f80c09)

## [0.40.1] - 2026-09-12

### Fixed

- Home now presents distinct project cards instead of duplicating the sidebar's flat thread list, and single-child workspaces or tabs navigate directly without false disclosure controls. (dd96b0d)

## [0.40.0] - 2026-09-11

### Added

- Home and the workspace drawer now expose a collapsible Workspace → Tab → Pane tree with direct navigation and accessible disclosure controls. (5a01453, 2d5edb7)

### Fixed

- Mobile drafts enter a reversible focus mode that hides navigation chrome while keeping a compact, internally scrolling composer and all message actions visible above the keyboard. (d63656b)

## [0.39.1] - 2026-09-11

### Fixed

- Mobile navigation chrome is denser across the global header, pane identity, tabs, and pane switcher, removing the duplicate in-pane Nenu mark and returning more height to the conversation. (6b60792)

## [0.39.0] - 2026-09-11

### Fixed

- Mobile sends now expose queue/Herdr acknowledgement state and retry with phase-scoped idempotency, so double taps and recoverable verification failures never append the same draft twice. (3c107d5)
- Codex's working-state `tab to queue message` composer is detected from its renderer-owned footer, including its narrow mobile wrap, while plain-text lookalikes stay fail-closed. (8c2bb6e)
- The mobile composer, telemetry row, and multiline input use less vertical space while preserving 44px touch targets, safe areas, and bounded internal scrolling. (3c107d5)

## [0.38.0] - 2026-09-11

### Added

- Render local HTML previews in an opaque, no-network sandbox with Render/Código modes. (6c4a7a2)

## [0.37.3] - 2026-09-09

### Fixed

- Fresh Codex sessions now open directly in the conversation workbench before their journal exists,
  without flashing back to the terminal while the first message starts running (4b77f15).
- Mobile sends containing blank paragraphs or several URLs are verified and submitted once instead
  of being stranded in Codex's input box and duplicated on retry (4b77f15).
- Raw terminal is now an explicit compact header escape hatch scoped to one pane; an old global
  terminal preference can no longer make every new phone session open in the raw view (4b77f15).

## [0.37.2] - 2026-09-08

### Fixed

- Codex conversations hide injected `AGENTS.md` instructions and internal memory citations to match
  the native Codex transcript (cae461f).

## [0.37.1] - 2026-09-08

### Changed

- Replaced the detailed Nenu artwork with the selected lightweight monoline terrier across the app,
  favicon, Apple touch icon, and PWA install icons.
- Added a minimal README banner that identifies Nenu as a Herdr agent workbench for mobile and web.

## [0.37.0] - 2026-09-08

### Added

- **Conversation-first workbench** with native messages, separate final answers, and compact,
  expandable thinking and tool activity instead of a wall of terminal cards (15737ab, 246c644).
- **Provider-aware model, reasoning, skill, and command controls** for Codex CLI and Claude Code,
  backed by local preloaded catalogs for instant opening (b0375ad, e9b9301, 4ab281e).
- **Contained Markdown, image, and PDF previews**, including lazy PDF.js loading and project-root
  path enforcement (5066305).
- **Nenu identity** across the interface, manifest, PWA icons, and notifications, with an ImageGen
  mark based on the maintainer's black terrier (d29d422, 4020f97).

### Changed

- Model menus, notifications, navigation, and the empty workspace now follow the quieter T3-style
  interaction and visual hierarchy while retaining Herdr as the runtime (1f38fff, 547c5ac).
- Update notices preserve active drafts, can be dismissed, and use a fork-selected release source
  instead of inheriting Collie releases (b8a3536, 6ffb4ad).
- Public installation, support, security, contribution, and release documentation now target the
  canonical Nenu repository; legacy `herdr.collie` and `COLLIE_*` identifiers remain compatible.

### Fixed

- Mobile headers respect iPhone safe areas, drawers no longer shift the global page, and the hidden
  sidebar always has a recovery control (7d24946, 5066305).
- Canonical model matching exposes Astra correctly and avoids leaving terminal pickers open behind
  the native composer (64193b7, 4aa750c).

## [0.36.0] - 2026-08-28

### Added

- **AGY (Antigravity CLI) first-class harness adapter** — `ask_question` menus, permission, plan and trust dialogs lifted into native buttons, the boxed composer stripped with its status row re-surfaced, a slash-command palette and the brand icon — thanks @Kryvonis (#99) (4285457)
- **Codex: a large send is verified through `[Pasted Content N chars]`** — the exact character count is the evidence Enter waits for, per ADR 0010 — thanks @memset0 (#132) (1ca57f1)

### Fixed

- **Sign-in banner instead of "Can't reach Collie" behind a forward-auth proxy** — an expired session answered with a 3xx is read as a 401, and Authentik's `/outpost.goauthentik.io/` start/callback paths bypass the PWA cache — thanks @lekoOwO (#130) (4ca1462)
- **Codex CLI 0.150.1 is recognised again, on both of its status rows** — the `Context`-bearing shape with `Context` directly after the model (thanks @fbserg, #134, 75a865a), and the two-field default that carries no `Context` field at all, now keyed on the row's renderer paint (dim ` · ` separators between coloured fields) and never on field names (0ed3fd5); pinned by five byte-faithful 0.150.1 captures (ffbc995)
- **Codex: destructive writes bind to the whole wrapped draft**, not only the first `›` row — a message that wraps past the bridge's tail window no longer 409s every pre-clear sweep — thanks @memset0 (#132) (47410a1)
- **Codex: the dim `Ask Codex to do anything` placeholder is empty; the same words typed are a draft** — thanks @memset0 (#132) (c58ba36)
- **AGY: a bare `>` transcript row is never taken for the composer** — only the boxed composer counts, so an echoed message cannot authorise a reply into a running turn (8c02522)

### Known limits

- Codex keeps only the first 1,024 characters of one send: a longer message shows as `[Pasted Content 1024 chars]` and the guard refuses to press Enter rather than submit a cut message. Herdr delivers every byte (probe in `HERDR_API.md`, b227ba5), so the limit is Codex's own, and a send is never chunked (ADR 0010)
- While a Codex turn runs, the composer paints a `»` marker the adapter does not yet recognise, so a mid-turn reply is refused, never mis-sent; a byte-faithful capture of that state is wanted (see the #132 thread)

## [0.35.0] - 2026-08-26

**BREAKING — read before updating.**

- `COLLIE_PUBLIC_HOSTS` is now **required** on every reverse-proxy or tunnel install (Variant C/E) — Host validation fails closed.
- With `COLLIE_TRUSTED_USER` set, a request carrying no `Tailscale-User-Login` is now rejected; tagged nodes used to pass.
- A non-loopback `COLLIE_HOST` refuses to start.
- Opt-outs, one per gate: `COLLIE_ALLOW_ANY_HOST=1`, `COLLIE_TRUSTED_USER_OPTIONAL=1`, `COLLIE_ALLOW_NON_LOOPBACK_BIND=1`.

### Added

- **`quick-replies.toml`: your own Quick-dock groups** (title + items + optional `scope`), live-reloaded, replacing the shipped phrases on the panes they address per ADR 0018, shell panes reachable via `scope = "shell"` (eb1e92f) — thanks @fucx (#131)

### Changed

- Host-header validation is on by default and fails closed; `collie-ctl.sh` injects the tailnet name and IPs, `COLLIE_ALLOW_ANY_HOST=1` opts out (5f01bf7) — thanks @bartholomewtj (#129)
- `COLLIE_TRUSTED_USER` rejects a missing `Tailscale-User-Login` as well as a mismatch; `COLLIE_TRUSTED_USER_OPTIONAL=1` restores the old pass (5f01bf7)
- A non-loopback `COLLIE_HOST` refuses to start unless `COLLIE_ALLOW_NON_LOOPBACK_BIND=1`; non-loopback TCP peers are rejected (5f01bf7)

### Fixed

- Uploads are typed by magic bytes, not the client-supplied Content-Type — `__proto__` and `constructor` used to pass the MIME lookup (5f01bf7)
- `collie-ctl.sh` parses `.env` as key=value instead of sourcing it — a `.env` with `$(…)` or backticks ran as the operator on every verb; an unquoted trailing `# comment` is now stripped (5f01bf7, 9195e00)
- An unversioned managed checkout pins `update` to the newest release tag, never origin HEAD (5f01bf7, 4440c05)
- A failed `tailscale status` no longer writes an empty host allowlist into the unit — the unit keeps the hosts it had, and says so (9195e00)

## [0.34.0] - 2026-08-24

### Added

- `COLLIE_SERVE_PORT`: publish the https front door on a chosen tailnet port — several Collies per host (#98) (c02e3ea)

## [0.33.0] - 2026-08-24

### Added

- **Codex CLI first-class harness adapter** — boxless composer chrome stripped with the status row re-surfaced, folder-trust prompt, exec approvals and `request_user_input` question cards lifted into native buttons (by @kennymcavoy) (e5fab3a)
- **Grok Build first-class harness adapter** — composer chrome stripped with the status strip re-surfaced, permission cards, `ask_user_question` radios/wizards and plan approval lifted into native buttons, plus a Grok session-journal adapter (by @kennymcavoy) (bd01e51)

### Fixed

- **omp replies no longer stall on an inline completion suggestion** — the ghost omp paints after the typed text is dropped from the draft the send guard verifies (by @enieuwy) (bdfac02)
- **Codex adapter review fixes** — drafts wrapping past 8 rows keep the composer, and the persistent "don't ask again" approval row stays visible in the mirror (d469507)
- **`journal-probe` checks each root on its own** — a populated healthy root can no longer hide a broken sibling (by @kennymcavoy) (6f68677)

## [0.32.1] - 2026-08-23

### Fixed

- **`url` (and `status`/`qr`) honour `COLLIE_PUBLIC_URL`** instead of always inferring the bare tailnet name with no port (#122) (859610d)

## [0.32.0] - 2026-08-19

### Added

- **F1–F12 in the Keys tray, behind an "F keys" disclosure** — chords with armed modifiers included (#119 by @martin-tahli) (09b0571)
- **`keys.toml`: your own Keys-tray preset rows** (label + chords + optional `danger`), live-reloaded, replacing the shipped presets on the panes they address per ADR 0018 (c02ab19)
- **The update gate (ADR 0020)**: a routine `update` follows release tags within the installed major; crossing a major takes explicit consent — `update --major`, wired as the `update-major` plugin action (633b2a1)
- **The update banner says which kind of behind you are** — an in-major release, or a pending new major with the consent command (a38df8c)

### Fixed

- **A cold boot with no network renders the cached last screen**, dated "last seen HH:MM" — never a false "No agents" (0f4c651, c473aa0)
- **A stale pane mirror is dated by its own stamp, not the herd's** (1042fe0)
- **The linked-clone major gate judges the branch's own upstream (`@{u}`), not the remote default branch** (99910cf)

## [0.31.1] - 2026-08-18

### Fixed

- **A long request survives socket backpressure** — Bun's socket accepts fewer bytes than it is handed under pressure and queues nothing; the dialer now parks the tail and resumes from `drain`, so a big request can no longer silently truncate and die on the timeout (cc810c9). Probed while fixing: herdr drops any request line of 1 MiB or more — now in `HERDR_API.md`

### Changed

- In-code pointers name `DEPLOYMENT.md` now that variants B–E live there (cd2f1f8); `COLLIE_MULTI_SESSION` spelled `on`/`off` everywhere; `push-keys`/`push-test` listed in the Commands table (ee64069)

## [0.31.0] - 2026-08-18

### Added

- **`push-keys` generates the VAPID keypair and writes it into the right `.env`** — Web Push setup is now three plugin actions (`push-keys` → `restart` → subscribe), no manual key wrangling (85f0454)
- **"Tap to type" can be turned off** — a display setting stops the mirror volunteering the keyboard on a tap; on by default (357b86f)
- **`COLLIE_AUDIT_CONTENT=none` keeps the audit trail and drops the bodies** — a fail-closed allowlist keeps action parameters legible while anything operator- or screen-originated redacts (#107, 5dda876, cdad445) — thanks @shuangwangnyc
- **Your own slash commands in the palette, declared in `commands.toml`** — on a pane your rows address they replace the shipped catalog (ADR 0018); `confirm = true` adds a two-tap; edits are live, no restart (#109, 35da673, 28bdf5a) — thanks @enieuwy

### Fixed

- **⚠ A paste too big to persist no longer restores an older, shorter draft after a remount** — oversize drafts now ride an in-memory tier whole, never truncated and never swapped for stale text; they survive pane switches but not closing the app, and the composer says so (7965674)
- **A half-arrived long send is no longer accepted as send evidence** — when the input box ends in literal text it must be the end of what was sent, or the guard refuses to press Enter (#110, 27f4cdf)
- **Direct typing no longer owes a "mode stopped" notice to the next pane**, and the blur it schedules is settled by cancellation instead of racing a re-arm (#108, 452da20, 1a2ca49) — thanks @enieuwy

### Changed

- **README cut to ~60% of its length, how-first** — deployment variants B–E now live in `DEPLOYMENT.md`, and troubleshooting entries are findable by the words you'd actually search (9464c14, c52d4af)

## [0.30.0] - 2026-08-16

### Added

- **A password prompt says what it is and offers the control that works.** `sudo`, an SSH passphrase and `gpg` echo nothing, so Send's verification can never arrive — the refusal now names that and hands off to **Type** in one tap, instead of "a menu or dialog is probably up" (#103, 1334540)

### Fixed

- **A password typed into the composer is no longer kept for 48 hours** — recognising the prompt drops the stored draft and stops persisting keystrokes; the write-through had stored it before any send was attempted (#103, 1334540)

## [0.29.0] - 2026-08-16

### Added

- **The plan dialog's feedback row has a route from the phone.** Row 3/4 is a text input, not an option: Collie now models it, locks the other buttons while the terminal owns it, and sends feedback through the guarded choreography — digit, verified paste, bound Enter (#95, c0ce09e, 967e94d, 64de1d4) — thanks @navidkashani
- **A pane is named by what its process says it is doing** — its OSC title, glyph-stripped and dropped when it only repeats the agent or project — so a project's herd stops reading as N identical rows (#100, 9dbc0fe) — thanks @praneetrohida

### Fixed

- **A long plan-feedback value re-flows across lines instead of windowing** — the value is rebuilt from continuation lines and the footer gap widened, so a 355-char value no longer makes the whole dialog vanish (#95, 64de1d4)
- **A shell's `user@host:cwd` title is a locator, not a name** — it no longer replaces the row's cwd with a longer restatement of it (#100, 982b8e1)
- **A push re-subscribe replaces the row it supersedes**, and each row records when and from which browser it was made — Apple keeps answering 201 for an orphaned endpoint, so this is what stops `push-subscriptions.json` growing forever (#104, 0021300)

## [0.28.0] - 2026-08-12

### Added

- **omp gets a harness adapter (Tier 1)** — read-only blocks by construction, its own composer chrome stripped, a slash palette sourced from its captures — a reply stops confirming its pickers (#93, b98b90d) — thanks @qaz74107410
- **Every `COLLIE_*_ROOT` (including `COLLIE_TRANSCRIPT_ROOT`) takes a comma-separated list**, so pane history works across multiple `CLAUDE_CONFIG_DIR` profiles (#92, b549101)
- **`contrib/windows/`** — a community-maintained Task Scheduler lifecycle for Windows (#71, 8572e49) — thanks @Pimpmuckl

### Fixed

- **Update-available pushes to Apple devices never arrived — broken since 0.11.0.** The Web Push topic was an impossible base64 length and APNs refused it; herd alerts were unaffected (#90, 19572d7) — thanks @ojulean
- **The destructive pre-clear sweep now fires only after a live read positively sees the composer**, bound to the prompt it saw — a dialog opening in the gap can no longer eat the burst (#93, 6c8332f)

## [0.27.0] - 2026-08-10

### Added

- **`collie-ctl.sh qr` prints the tailnet URL as a scannable code**, so a phone doesn't have to type a MagicDNS name — opt-in as its own subcommand, since a PWA only needs the URL once. Corrects two defects in the renderer it uses: its filled glyph is a *light* module, so the compact output inverts on a light terminal, and its quiet zone is 1–2 modules where the spec asks 4 (#88, ff84538) — thanks @adrgarcha
- **`start` and `status` say when this node's packet filter admits no peer**, instead of printing the tailnet URL under a green ✓ that no other device can open — the local probe only ever sees loopback, which never touches the filter. Best-effort and deliberately unsure: it speaks up only on a total deny, and stays silent whenever it can't tell (#87, 82bbe0e) — thanks @adrgarcha

### Fixed

- **Idle Claude panes no longer scroll up and snap back on every poll** — the session-name sniffer read `recent`, which on a pane shorter than the read makes Herdr scroll a full-screen agent to reach the rows above it; it reads the visible grid now (#85, dab122e) — thanks @OowhitecatoO
- **A lapsed session behind a redirecting identity proxy shows the Sign-in banner** rather than "can't reach Collie" — API requests now carry `X-Requested-With`, so a proxy answers 401 instead of a 302 that `fetch` follows into an opaque CORS failure with no status to classify (#86, 0dc852e) — thanks @ojulean

## [0.26.0] - 2026-08-10

### Added

- **Type into terminal** — a toggle beside Keys in the Controls row sends what you type straight to the pane as keystrokes, no trailing Enter, so a TUI that wants bare letters (`b`, `q`) can be driven from a phone. Ordered and batched, so a slow tailnet grows the next batch instead of scrambling characters; it never survives a pane switch, a lock, a hidden page or a failed batch (#74, 7dea503) — thanks @aspiers
- **GFM tables render as tables** in Conversation history instead of collapsing into one run-on paragraph — recognised by their delimiter row, alignment and ragged rows included. A table nested in a list or blockquote still collapses: the block parser is flat, and agents put tables at the top level (#72, d82ef1b)
- **Nerd Font symbol glyphs stop rendering as tofu** — two subset woff2 faces ship with the app, fetched only when a pane actually paints a private-use glyph (`unicode-range`) and deliberately kept out of the precache (#70, d31d97d)
- **A quick Ctrl+C in the nav tray's Esc/Up gap** — one tap, without opening Presets (#75, d139b1b) — thanks @Jarva

### Changed

- **A long terminal rule clips at the mirror edge** instead of wrapping into several rows; its full text stays in the DOM, and ordinary output keeps wrapping normally (#79, 4480019) — thanks @en-ver
- **The composer row reads its own state** — an open dock or an armed mode carries a light-sky tint instead of a grey surface, the attach button moves inside the text field, and the "Controls" tag floats above the row so four labelled toggles fit a 390px phone unclipped (57080f5)

### Fixed

- **Sends stalled on a narrow pane with "Message didn't reach the input box"** — the guard located Claude's input box by a run of 20 rule glyphs, which is a hidden assumption that the pane is at least 20 columns wide; it now measures display cells, and the wrapped-draft scan reaches past a long CJK draft (#76, de88b38) — thanks @tyamanak
- **The ctl test suite re-initialised the repository it was run from** — git exports `GIT_DIR` into hooks, which overrides discovery for every git command including `-C`, so the sandbox's `git init` landed on the developer's own checkout (51fce21)
- **The ctl suite failed on a Homebrew Mac** — `resolve_bun`'s absolute-path fallback escaped the sandbox PATH and brought the real `tailscale` back with it, defeating the missing-CLI case (5c48721) — thanks @tyamanak

## [0.25.0] - 2026-08-07

### Added

- **A subscription that keeps failing is retired** after 5 consecutive failures, so stale duplicates (PWA reinstalls) stop accumulating and re-logging every cycle — counted only when a sibling on the same push service succeeded that round, so a service-wide rejection never costs a live device (#68, 2ea3e61) — thanks @alshedivat

### Fixed

- **Push failures log the status and the service's reason** instead of web-push's constant "Received unexpected response code", which named neither (2ea3e61)

## [0.24.2] - 2026-08-06

### Fixed

- **A wrapped CJK reply stalled unsubmitted** — the input box folds its wrapped lines with a space, fabricating one the send never had (CJK has no spaces to wrap at), so the guard's slice check could never match; each seam is now judged on its own, and only a gap the fold itself could have made is loosened (#66, 6def208) — thanks @tyamanak
- **The guard feature-detects `Intl.Segmenter`** and falls back to code points, so an engine without it (Firefox < 125, Safari < 14.1) loses grapheme precision instead of white-screening the app at boot (46a85d1)

## [0.24.1] - 2026-08-06

### Fixed

- **Long/multi-line replies to Claude panes stalled unrecoverably** — the send guard now reads Claude's `[Pasted text #N +M lines]` placeholder as send evidence when consistent with the sent message (ADR 0010) (e9f1a33)
- **Stranded-draft preview withdraws "Take over" when the line holds only Claude's paste placeholder** (e9f1a33)

## [0.24.0] - 2026-08-05

### Added

- **Buttons for Claude's `/model` picker, and any modal like it** — a last-resort grammar reads the footer's `<key> to <verb>` hints and renders them, with the arrows the screen advertised, over the mirrored region (5392ac7)
- **The ←/→ pair says what it adjusts** — the picker's live value ("◐ Medium effort") sits between the arrows and in their accessible names (d872490)
- **A send is refused before it types when the agent's input box isn't on screen** — the draft is kept, and a second Send is a deliberate "Type anyway?" that still never fires the submit key blind (c4ffe45)

### Fixed

- **A half-written reply survives leaving the pane** — drafts are kept per pane (48h, localStorage, so an OS-killed PWA doesn't lose one) instead of dying with the composer when you step over to another tab (9d41411)
- **A reply is no longer typed into a full-screen picker** — the original `/model` bug: no grammar claimed the screen, so the message fed the picker and came back "stalled" (c4ffe45, 5392ac7)
- **The stalled message says a key answer probably landed** — the part that made the original report confusing (c4ffe45)

### Changed

- **Modal menus are a documented harness contract** — the model and its footer/key grammar are harness-neutral, so a future codex/pi/opencode adapter implements them from types plus a conformance leg, not from Claude's internals (0c9dace)
- **A generically-detected menu never synthesises a digit** — in the `/model` picker a digit confirms *and* saves your default for new sessions; [ADR 0009](.adr/0009-a-generic-menu-is-driven-by-the-keys-it-names.md) records why (5392ac7)
- **Every dialog model is a harness contract, not a Claude internal** — the prompt-select, wizard, preview and multi-select payloads join menus in harness-neutral modules, so the AST and the renderers no longer point at one agent's grammar (3b5cf7c)
- **One race guard for every dialog, run through the pane's own adapter** — no more re-deriving through Claude's detectors; an adapter that emits a block kind gets the guard for free, and no adapter fails closed (79ebc0c)
- **The conformance suite pins the signature + identity contract for every block kind** — not just menus: a constant signature, or a comparator that passes a screen that changed, now fails CI (b78aa0f)

## [0.23.3] - 2026-08-04

### Fixed

- **The idle lock no longer ambushes you on the way back in** — a hidden page never locks and returning to the foreground auto-resumes, so it can only appear when Collie is left open, visible and untouched (746ce87)
- **A pause no longer eats an in-progress reply** — the cover sits over a still-mounted router instead of replacing it, so draft, scroll position and open sheets survive it (746ce87)
- **Resuming shows the catch-up instead of handing back a frozen screen** — the cover holds through the refetch, badge swapped for the gallop, and releases when it settles (4ffce3c)

### Changed

- **The lock screen is glass, marked, and honestly worded** — the herd stays legible underneath, the Collie mark says whose screen it is, and there's no lock glyph or "for safety": it gates nothing, and [ADR 0007](.adr/0007-the-idle-lock-is-a-pause-not-a-gate.md) records why (746ce87, 4ffce3c)
- **`ARCHITECTURE.md` no longer lists the idle timeout as a security measure** — it never implemented one (746ce87)

## [0.23.2] - 2026-08-04

### Fixed

- **Agent alerts now send at high urgency** — at web-push's default (`normal`) Android was free to defer them by Doze / App Standby bucket, so pushes were accepted by FCM and never delivered (79f30e6)

## [0.23.1] - 2026-08-03

### Fixed

- `update` now works in a `herdr plugin install` checkout — it is detached and shallow, so `git pull --ff-only` could never run there (#63) (aeeddcd)
- `update` no longer re-links a Herdr-managed checkout, which would re-register it as local and block `herdr plugin install` (aeeddcd)

### Upgrading — `herdr plugin install` users must reinstall once

The fix ships *inside* the checkout it repairs, so `invoke update` still can't run on an install made
before 0.23.1. Take the fix with one reinstall (config and serve state live outside the checkout and
survive), after which `invoke update` works normally:

```bash
herdr plugin install AltanS/collie --yes
herdr plugin action invoke restart --plugin herdr.collie
```

Installs from a `git clone` + `herdr plugin link` were never affected — use `invoke update` as usual.

## [0.23.0] - 2026-08-03

### Added

- **Every key press and quick reply now answers you.** A nav-tray press was silent on success and deferred to a mirror that can be ~2s behind, so tapping Enter felt like nothing happened; the pressed button now fills on the tap (synchronous, no network wait) and shows a ✓ once the bridge accepts it. Quick replies echo on the tapped button and the dock outlives the send, closing after the ✓ instead of on the tap (3be4934)
- **Hold an arrow key to repeat it** — driving a long TUI menu no longer means tapping ↓ fifteen times. Repeats accumulate locally and flush as one batched `send_keys` array with exactly one call in flight, because ordering across two concurrent one-shot RPCs is unguaranteed. Arrows only, by whitelist; a hold while composing stages one chip, not fifteen (e7ada40)
- **Haptics** — a short buzz on press, toggleable in Settings, silently absent where the platform has no `vibrate` (e7ada40)
- **Quick replies follow the pane kind:** a shell gets `y`/`n` instead of "commit and push" and "skip", which mean nothing at a bash prompt (e7ada40)

### Changed

- **The pane's two control rows are now one.** Wrap, raw terminal and text size moved behind a ⚙ into a labelled panel — the raw-terminal escape hatch had been a bare `>_` glyph whose only explanation was a `title` attribute no phone ever shows, and it now says what it does. Find moved to the header, where its find bar already takes over the row. The mirror gets ~85px back (3be4934) — general direction from @simonallfrey in #49, whose "consolidate the terminal toolbar" proposal is what started this; thank you
- Closing the Keys dock on a composed key queue takes a second tap. The queue is still discarded rather than persisted — one surviving into a later open would let Send fire yesterday's chord into today's TUI state — and the guard sits on the drawer transition, since the Keys toggle and the Quick/Agent/Display buttons unmount the tray just as effectively as the ✕ (e7ada40)
- A single key press revalidates on the leading edge instead of sitting out the full 300ms burst window before its refetch even started; bursts still coalesce into one trailing refetch (3be4934)

## [0.22.0] - 2026-08-03

### Added

- **OpenCode panes get Conversation history.** OpenCode ≥1.x keeps every session in one SQLite database (no per-session log), so its journal adapter reads `opencode.db` readonly with bound parameters, touches only the three transcript tables (the same file holds auth tokens), and serves all sessions through a per-session cache key. Needs `herdr integration install opencode` once, then restart OpenCode in the pane (#61, 539cdf4) — reported by @xabilarra
- **A multiselect question inside a wizard is now a tappable dialog**, not raw terminal text. It was owned by no grammar — wizards refuse checkboxes (a wizard digit selects *and* advances; a checkbox digit only toggles) and multi-select only knew the single-question form. It now carries the wizard's step chips, navigates with the wizard's own Left/Right keys, and reads the advance row's label ("Next" / "Submit") from the pane by position, never by assumption (#51, bdf4c26) — thanks @konpyl

### Fixed

- **A preview dialog whose option label wraps no longer falls to the raw mirror.** The grammar required numbered rows on consecutive lines, but the ~30-column gutter wraps longer labels onto continuation rows; a contiguity walk anchored on the label column replaces adjacency (#51, bdf4c26) — thanks @konpyl
- `ReadSource`'s unwrapped variant matches the wire: `recent_unwrapped`, snake_case — the kebab spelling was rejected by Herdr and nothing had ever called it. HERDR_API.md records the probed contract, including that the source is a byte-identical no-op for Claude panes (alt screen + renderer-hard-wrapped prose), which is what closed #53 part 2 by measurement (bddded3)
- `multi-select-action.ts` no longer carries a literal NUL byte (git classified it binary and hid its diffs from review); `.gitattributes` keeps any future stray byte from costing reviewability (#51, bdf4c26)

## [0.21.0] - 2026-07-31

### Added

- **macOS supervises the bridge with launchd.** `start` installs a LaunchAgent (`~/Library/LaunchAgents/herdr.collie.plist`), so the bridge comes back at login and restarts on failure — the parity with the `systemd --user` unit that macOS never actually had (#55, #57, a0be73d) — thanks @darieldatoon
- **The statusline strip shows every row of the run, in the agent's own colour.** Model, cwd, git branch and permission mode live on rows 2+ and were surfaced nowhere; the strip renders them stacked, in the mirror's colour space (#60, 61db7a5, ac3c62d)

### Fixed

- **Sending no longer stalls under a tall statusline** (the run may be 8 rows, was 3). A taller run made `locateInputBox` miss the input box, so a send typed the text and then withheld Enter — with no stranded-draft preview and no pre-clear sweep, so retries stacked duplicates in the pane. Reproduced on a 3-row statusline sitting one wrapped line from the cliff (#54, #56, fe8e548) — thanks @stekman08
- `launchctl bootstrap` is retried across launchd's teardown window, so `restart` — and therefore `update` — can't end with the bridge down (b1ebb83)
- A Mac that can't bootstrap (no console login, so no `gui/<uid>`) keeps an unsupervised bridge instead of exiting with nothing running; `status` reports that degraded tier (5b5106c)
- The pi journal fixture is portable to macOS, where `containedRealpath` resolves `/var` → `/private/var` by design and the backend suite couldn't run at all (a7d8f9a)

### Changed

- **The mirror wraps by default.** Herdr spawns panes at the desktop terminal's width against a phone's ~45–50 columns, so panning was the common case, not the exception; column-faithful no-wrap stays one tap away in View. Display prefs reset to defaults on first load (storage key v4), so a pinned font size needs setting again (#53, 273d886, 73cc7da) — reported by @waynehoover
- ADR 0004 records that the statusline-run bound guards less than it looks: a dialog below the input box is refused by the border checks and by the blank line above its footer hint, never by the row count (36c78c7)

### Upgrading

- **macOS installs migrate on the next `update` or `start`**: the old unsupervised bridge is stopped and replaced by the LaunchAgent. It's a *LaunchAgent*, so it starts at **login**, not at boot — and a Mac administered purely over SSH has no `gui/<uid>` to bootstrap into, so it stays on the unsupervised bridge with a warning until someone logs in at the console once.

## [0.20.2] - 2026-07-30

### Fixed

- `herdr plugin action invoke update` no longer dies with `bun not found on PATH` — Herdr spawns actions with no login shell, so Bun is now found in its install locations too, not just on `PATH`. A failed run had already fast-forwarded the checkout, leaving the old `web/dist` being served (#52, 08f44f6) — thanks @konpyl
- Only an absolute Bun path is prepended to `PATH`, so a `bun` shell function in the plugin `.env` can't put the CWD in front of `git` / `systemctl` / `tailscale`; the control script's Bun resolution now has test coverage (4841e37)

## [0.20.1] - 2026-07-29

### Fixed

- Journal rotation-following re-checks containment, so a sibling symlinked out of the Claude projects root can no longer be served as a pane's history (e8b1357)

### Changed

- Dependency versions must be 7 days old before they install, via `bunfig.toml` (`.npmrc` for npm users) (bf38d45)

## [0.20.0] - 2026-07-29

Three contributions from @konpyl carry this release — light and system themes (#41), the triaged
dashboard (#42) and tappable URLs in the mirror (#45), landed via #46/#47/#48 with review fixes on
top. Thank you: measured rather than estimated, with the reasoning written down where it will be
argued about again.

### Added
- **Light and system themes.** Collie follows your phone's appearance by default; pin Light or Dark from **Settings → Appearance**. Per device, and documented under [Dark mode / light mode](./README.md#dark-mode--light-mode) (#41, 59bcfe1, df47112)
- ANSI slots 0–15 are now CSS variables (`--ansi-*`), so indexed terminal colour is defined in one place and reaches the mirror through both `31m` and `38;5;1` spellings (59bcfe1)
- **The dashboard is triaged, not listed.** Needs you → Ready · unseen → Working → Recent; the first three are pinned, Recent sorts by when you last used each pane (#42, da4f44c)
- **Ready · unseen** — agents that finished while you weren't looking. Opening one clears it, on every device (2f4d691)
- Recent and Spaces fold and remember it; fold both and the page is the triaged herd and nothing else (da4f44c)
- The swipe-up **Switch pane** sheet folds its long tails too — Recent, and the bare **Shells** group that buried the agents underneath it (4cca8db)
- Spaces are ordered by last used and filterable — 45 of them are now three keystrokes, not a scroll (da4f44c)
- The bridge keeps two timestamps per pane (`activeAt`, `seenAt`) in `activity.json`, because Herdr reports none (2f4d691)
- **Tab and space chips carry a status dot** — blocked / ready / working / idle, in the herd list's own palette. They only ever showed a dot for blocked before, so every other state read the same as every other (22d4a5f)
- **URLs in the pane mirror are tappable** — `http(s)://` text becomes a link that opens in a new tab, keeping the colour the agent printed and marked by an underline (#45, cc38351)
- Trailing prose punctuation is trimmed with paren balance respected, so `Fetch(https://x.dev/a)` links the URL and not the paren; a find hit inside a URL still highlights, and a URL that changes colour mid-way stays one link (cc38351)

### Changed
- The pane mirror renders in dark space under every theme and light mode inverts it, because agents emit truecolor almost exclusively and no palette can re-theme an absolute colour — [ADR 0002](.adr/0002-invert-the-light-terminal-mirror.md) (78425bd)
- In light, the page is a step off white with cards staying white, so the dashboard's hierarchy no longer rests on a single hairline — and the mirror's edge stops showing a seam (59bcfe1)
- **Agent rows are titled `project · tab`, not "claude".** The pane's own name moves to the second line; the agent stays in the avatar (da4f44c)
- Spaces moved BELOW every agent section — it's a navigator, not a work queue (da4f44c)
- Only Collie's own reads count as seeing a pane; a Herdr focus at the desk does not — [ADR 0003](.adr/0003-one-shared-seen.md) (6786ca1)
- MINOR, not MAJOR: pre-1.0, purely additive, no config or API break. Defaulting to your phone's appearance is the feature working as designed and Settings pins it either way; an older bridge reports no activity timestamps and simply renders the previous dashboard, minus the one section that would be empty

### Fixed
- **The space and tab chip rows overlapped each other on the space screen** — both strips were missing `shrink-0` inside the route's flex scroller, so they collapsed to 16px around 32px chips and the tab row painted over the space row. Pre-dates this release (636b7af)
- Three `role="alert"` warnings (incomplete multi-select, wizard, preview) used a hardcoded yellow that measured ~2:1 on white; they use the status palette now (59bcfe1)
- An off notification switch was unreadable in light — a white thumb on a 1.09:1 track, legible only by its shadow. It carries an outline now (59bcfe1)
- Focus rings were drawn at half strength, 1.77:1 in light and 1.87:1 in dark; both are full strength now (59bcfe1)
- Small muted text (section labels, the build stamp, the terminal status line, the `(n)` counts) fell under 3:1 in light — light `--muted-foreground` had no headroom left for the `/70` and `opacity-60` modifiers stacked on it, so it was darkened and the modifiers dropped (59bcfe1)
- Header controls had 20px touch targets; the Settings gear and the Settings back button are both 44px now, with no change to how they look (59bcfe1)
- The boot splash stepped from white to the page colour when React took over, and its caption measured 3.45:1 — it used `#ffffff`/`#8a8a8a` under a comment claiming they matched `--background`/`--muted-foreground`, which rasterize to `#f5f5f5`/`#5d5d5d`. Same fix for the light `theme-color` meta, so Android's URL bar matches the page (7f0189d)
- Inverse-video segments in the mirror emitted theme tokens while the muted glyphs beside them used literals; the mirror keeps one spelling now (identical pixels — the literals are those tokens' dark halves) (7f0189d)
- Marking a pane seen had made a read-level GET mutate state, so a cross-site `<img>` at a guessed pane id could silently clear your unseen agents. Only a request carrying the app's own header counts now — caught in this release's security review, never shipped (f9000cb)
- Only a request that will actually be served marks a pane seen — one falling through to 405 no longer clears an alert (f7e616b)
- **Light `--accent` was byte-identical to `--background`**, so "this is the current one" showed nothing in light mode — the open pane in the switcher, the current session, every `hover:bg-accent`. Predates this release; found by the UX sweep (dab7e05)
- Titles truncated away the tab — the only part that identifies a row — leaving several panes rendering the same `moonward_os · t…` (8a8a4c9)
- Section headings rendered at two different sizes and cases, because a `<button>` doesn't inherit `text-transform` from its `<h2>` (8a8a4c9)
- A hollow status ring on the avatar's corner read as a notch cut out of the logo (5c04453)
- A space row and its chip could disagree about what a colour meant — the row still ranked by `STATUS_RANK` while the chip used the triage classifier, so a space holding one working agent and one unseen-done agent showed "working" on the dashboard and "ready" in the strip. Both route through `bucketOf` now, in one pass rather than spaces x agents per render (e024f48)
- `aria-controls` on a collapsed section pointed at an element that isn't rendered — exactly when a screen-reader user is deciding whether to expand it (e024f48)
- A status dot passed a smaller size only resized its wrapper, so chip dots rendered at the wrong size (e024f48)
- The Settings page rearranged itself a frame after opening — Notify-when and Snooze mounted only once push state resolved, inserting ~400px into the middle of the page, and Notify-when then grew another ~180px waiting on its own prefs. Both render from the first frame now, switches disabled until their values land (3d5b191)
- The pane row ran straight into terminal output with no edge between them, so the chrome and the mirror read as one surface (e208408)
- Herd and space rows had a border radius with no border to own it, so a rounded hover fill sat under a straight `divide-y` hairline. Rows without a border are square; the ones with a real border keep their radius (3d5b191)

## [0.19.0] - 2026-07-29

### Added
- **Journal (pane history) is now per-harness, with Codex and pi support.** Reading an agent's own session log is an adapter keyed on the pane's agent (`bridge/journal/`), so a new harness is an adapter rather than a fork of the reader — Codex reads its date-partitioned `rollout-*.jsonl`, pi its per-cwd session log. Raised in #40 by @simonallfrey, who asked where to implement journaling for Codex (7e3b2bd)
- **`scripts/journal-probe.ts`** probes every adapter against the real logs on the host — the format-drift check unit tests can't make. It caught Codex 0.145 adding a `developer` message role the parser would have rendered as operator speech (7e3b2bd)

### Fixed
- **pi could never have had history.** pi reports its session as a kind-`path` ref (an absolute path) and the bridge kept only kind-`id` refs, so a pi pane arrived with no session at all. Both kinds are kept now; a path ref is confined to that harness's root after symlink resolution (7e3b2bd)
- **A pane relaunched as a different agent served the previous agent's session ref.** Herdr keeps reporting the last session announced for a pane — a pane running pi still advertised a `herdr:claude` id. The ref is dropped unless its own `agent` matches the pane's (7e3b2bd)

### Changed
- **A pane's session reference no longer goes to the browser.** `/api/snapshot` sends `hasSession` instead — for pi the reference is a filesystem path, and the History affordance only ever needed "may this pane have history?". It is now also gated on the harness actually having an adapter (7e3b2bd)

## [0.18.0] - 2026-07-28

### Added
- **Approvals are bound server-side to the prompt they were decided against.** `/keys` and `/reply` accept an optional `expected_prompt`; the bridge re-reads the pane immediately before writing and refuses with `409 prompt_changed` if the dialog moved. Shrinks the guard window from human latency to two local RPCs — a mitigation, not a guarantee, until herdr gains a conditional-input primitive (#29) — thanks @Optic00 (6afaf5b)
- **`/auth/` is reserved for a fronting proxy's sign-in page**, and the service worker always passes it to the network. An installed PWA could not reach a proxy page at all before — the precache answered every navigation, reload included — so operators had to squat a page inside `/api/`. The refusal banner now links there (#31) — thanks @Optic00 (1a5972b)

## [0.17.0] - 2026-07-27

### Fixed
- **A reply sent while an agent dialog was focused answered the dialog instead.** The submit key approved whatever option was highlighted (Claude defaults to "Yes") and the message was destroyed, while the bridge reported success. Sending now refuses outright while a dialog is up, and otherwise types first and only submits once the text is verified in the input box (#34) — thanks @maikschuheida-spec

### Changed
- Free-text replies on harnesses with a block grammar (Claude) are two steps — type, verify, submit — so "Sent ✓" now means the text was seen in the input box. Harnesses without an adapter keep the previous one-shot send

## [0.16.1] - 2026-07-27

### Fixed
- `/api/config` is now gated like every other endpoint — it was the one route that skipped the same-origin check and `COLLIE_PUBLIC_HOSTS`, noted by @Optic00 in #32 (a54afd9)

## [0.16.0] - 2026-07-27

### Added
- Bring-your-own-tunnel deployment path documented as **Variant E** — NetBird, ZeroTier, Cloudflare Tunnel (6550041)
- `scripts/collie-ctl.test.sh` — first lifecycle coverage for the control script, wired into the pre-push hook (a004449, 65889da)

### Fixed
- `unserve`/`uninstall` no longer remove a `tailscale serve` mapping Collie didn't create, and `start` no longer replaces one (a004449, thanks @iamtimmy)
- A front door that fails to publish no longer aborts `start` before the status banner (65889da)

## [0.15.0] - 2026-07-26

### Added
- Pane conversation history read from the agent's own transcript — scroll back past the live mirror (77dff7c)
- Windows support for the bridge: dials herdr's named pipe through `node:net`, one code path for both platforms (#25, #27) — thanks @mikebenner and @bwright2810 (dd6610d)
- `COLLIE_HERDR_DIAL=auto|net|bun` forces the dialer; `net` exercises the Windows path on Linux/macOS (f662834)

### Changed
- **Breaking, only if `COLLIE_DEVICE_HEADER` is set:** a request arriving *without* the device header is now read-only. It previously got full write access, which let any tailnet client reach the bridge's own URL and skip the proxy that injects the header. Front doors that inject it on every request are unaffected; direct loopback/MagicDNS access now needs the header sent by hand (#28) — thanks @Optic00 (8ed715d)

### Fixed
- A 401/403 no longer renders as an endless "reconnecting" banner — an access refusal now says so and offers Reload (#30) — thanks @Optic00 (7bdcbfb)

## [0.14.2] - 2026-07-23

### Added
- Paste an image straight from the clipboard into the composer, same upload path as the picker (#24) (ad6957b)

## [0.14.1] - 2026-07-22

### Fixed
- `collie-ctl.sh self_dnsname` shelled out to `node`, which Collie never requires — now uses `bun` (#22) — thanks @jz-wilson (a61f3d1)

## [0.14.0] - 2026-07-21

### Added
- Alt modifier in the nav tray — `alt+<key>` chords now reachable from the phone (#19) — thanks @bnivanov (d1dc947)
- Modifiers combine (checkbox, not radio): `ctrl+shift+p`, `alt+shift+p`, even triple chords (#20) (d1dc947)
- Modifier lock — tap an armed modifier again to keep it armed across presses and Sends; Clear or a third tap releases (#20) (d1dc947)

### Changed
- HERDR_API.md: multi-modifier chords live-verified in any order against Herdr 0.7.3, cross-confirmed on 0.7.4 by @bnivanov (b505c4e)

## [0.13.2] - 2026-07-20

### Fixed
- Tabs render in Herdr's reported order instead of stable-number order, so a reorder in Herdr survives to the screen — thanks @iFwu (a16478f)
- Tapping raw terminal output focuses the composer synchronously, keeping iOS's user-activation window so the software keyboard opens — thanks @iFwu (a78ccfd)

## [0.13.1] - 2026-07-20

### Fixed
- Taking over or sending a draft no longer permanently mutes the preview for that same text — the handled key resets once the host line clears (7153639)
- Send's pre-clear sweep overshoot widened 8 → 32 so host typing inside the poll gap can't leave a remnant (7153639)
- A scrollback line starting with `❯` can no longer pin a bogus session name — only the live (bottommost) prompt decides (808cce7)

## [0.13.0] - 2026-07-19

### Added
- Long-press a pane pill for a pane actions sheet — rename + two-tap close (5b50941, c713551, 90210ce, ea20df0)
- Pane rename end-to-end: `pane.rename` RPC, bridge route, label threading (99c8808)
- Tab rename + tab close (blast-radius confirm) via the same long-press sheet on tab chips (a9664b5, 37a470e)
- Claude's own `/rename` session name surfaced on cards, headers, and the switcher (d22fdd7)
- Read-only "Draft in terminal" preview with explicit Take over — the composer input is exclusively phone-owned (4b6f0ac, 10fa28d)
- Self-update without the service worker: `X-Collie-Build` on polled responses, auto-reload or tap-to-update banner (8d13622)
- Instant offline navigation — during a known outage, routes serve the last good snapshot instead of hanging on a dead fetch (b756edd)
- Busy strip on genuinely hung loads: navigations >500ms, background polls >6s (e886541, 3bfaa1c, 06516c4)
- `-dev` marker in the build stamp for non-release builds (3e785f4)

### Changed
- One shared `AppHeader` for dashboard, space, and pane — same components underneath, stale status badges dim during outages (29432c2)
- Connection status is a single animated top bar — amber "reconnecting…" after 4s of trouble, red with Retry at 15s, green flash on recovery; no header pill (394e6fe, b2dd50e)
- Switcher sections carry status-colored bullets; per-row close removed (switching is the only action there) (3918c69)
- `assets/*` served immutable, everything else `no-cache` — proxy caches can no longer starve `/sw.js` updates (8d13622)

### Fixed
- Own in-flight reply no longer flagged as a stranded terminal draft (e8462f9)
- Wrapped multi-line drafts and the new background-agents footer no longer break input-box detection (829fc7e, d9521e3)
- `navigator.onLine` never gates polling or liveness — lying flags can't wedge the app or fake outages (d31ffb8, 394e6fe)
- One shared connection-lost clock; escalation survives route changes and app switches until a poll succeeds (1486e07, 5949885)
- Sustained outages escalate everywhere — boot splash, header, banner — with Retry/Reload (0cbbac1, 4d89588, 4494cf5)
- Gallop sprite re-centered; the dog never freezes mid-stride (rest state is the static icon) (3c7174a, 394e6fe)
- Offline banner no longer overlaps the sticky header (bf98a88)

## [0.12.0] - 2026-07-17

### Added
- `COLLIE_SKIP_SERVE=1` env var to disable tailscale serve entirely — bridge stays on loopback only, ideal for deployments behind a reverse proxy (Caddy, Nginx, etc.) — thanks @diogenesc (ad5833a)
- `COLLIE_PUBLIC_URL` — `collie-ctl.sh status` banner shows your real reverse-proxy URL instead of a placeholder (4b043be)
- Bridge startup warning when `COLLIE_TRUSTED_USER` is set under `COLLIE_SKIP_SERVE=1` — the identity gate is inert without tailscale serve injecting `Tailscale-User-Login`; use `COLLIE_DEVICE_HEADER` (4b043be)
- README Variant C — reverse proxy as the only front door (no Tailscale), with Caddy example and required env (76019f7)

### Changed
- `collie-ctl.sh unserve`/`uninstall` always attempt serve teardown, even under `COLLIE_SKIP_SERVE=1` — a stale mapping from before the flag flip would keep publishing the app (4b043be)
- Security posture docs: "tailscale serve is the sole ingress" → "exactly one hardened front door" (tailscale serve or a conforming reverse proxy) across README, ARCHITECTURE, CLAUDE.md (76019f7)

## [0.11.1] - 2026-07-16

### Fixed
- Opening a tab/pane lands on the live tail — terminal `<pre>` no longer steals vertical scroll from the message list; stickiness also re-pins when content grows (04bf6fc)

## [0.11.0] - 2026-07-15

### Added
- Pluggable harness-adapter architecture: a `HarnessAdapter` registry replaces the single Claude-only gate, Claude's detectors move to `lib/harness/claude/`, and a core race-guard engine (`lib/harness/guard.ts`) is the only module that may touch the network — an import fence (enforced by `fence.test.ts` under `bun run test`) + a conformance suite let contributors add codex/pi/opencode (see `HARNESS_CONTRIBUTING.md`)
- multiSelect AskUserQuestion support: checkbox options up-level to tappable checkbox rows (terminal is source of truth), with a closed-loop Submit that navigates the pointer to Submit and verifies before Enter (never blind-sends), plus the review/confirm screen
- Prompt overlay: interactive prompts render in a bordered `bg-card` panel that lifts the whole dialog off the terminal mirror, with elevated option rows, leading key-digit badges, and a family-aware caption
- Update notifications: a footer banner (linking to the GitHub release) and an opt-out web-push when a newer release is published upstream or the running bridge is behind the on-disk code — checks the repo's tags over anonymous HTTPS, stamps its own sources for the restart signal, a Settings "check for updates" button forces an immediate check, an `updates` notify pref is the off-switch, and update/restart are surfaced as location-independent Herdr plugin actions

### Changed
- Keys and Quick menus dock in-flow above the controls row instead of a fixed overlay, so the terminal mirror shrinks and re-pins to the bottom (ResizeObserver) — the prompt/cursor stays visible; both buttons are toggles
- Prompt option rows compacted (tighter padding, snug line-height) so a multi-option dialog fits the phone viewport
- "Sent" status toast moved from a bottom overlay (which covered the terminal tail) to a slim in-flow row below the header
- Build stamp marks a dirty working tree (`<sha>-dirty`), so the footer no longer claims HEAD when the build carries uncommitted work
- multiSelect Submit is ~2s instead of ~15s: the pointer walk re-reads the actual position each step and stops on "Submit", instead of polling for the bottom row after every key (which timed out ~2.8s per step)

### Fixed
- Prompt-select + wizard grammars: a numbered list in a dialog body (e.g. a plan's steps) no longer breaks menu detection — the menu is taken as the trailing `1..m` run, so plan-approval prompts up-level correctly

## [0.10.3] - 2026-07-12

### Fixed
- `collie-ctl.sh build` installs the root dependency tree (not just `web/`) before typechecking, so a fresh Herdr install no longer fails with TS2688 "Cannot find type definition file for 'bun'" (03f409f, #9)

## [0.10.2] - 2026-07-12

### Fixed
- Composer Send clears a stranded draft off the terminal `❯` line (ctrl+k + Backspace) before typing so replies no longer accumulate on the prompt; a clean prompt skips the clear (cd1cc25)
- Bridge settles ~350ms between typing and Enter so the TUI reliably accepts the submit key (cd1cc25)

## [0.10.1] - 2026-07-11

### Fixed
- Terminal mirror defaults to no-wrap for table alignment like desktop Herdr; clearer borders/typography (font 12, muted-foreground box-drawing); pane stays viewport-width — toggle Wrap on in View for prose (85f777b)

## [0.10.0] - 2026-07-10

### Added
- Herdr session switcher: one bridge fronts every named herdr session — `?session=` on the API, `?s=` in the app, a sessions summary in the snapshot, per-session notification slots, and a `COLLIE_MULTI_SESSION` kill-switch (8fa1f20)
- Space detail is a deep-linkable route (`/space/:spaceId`) with a working browser Back button, replacing the in-home drill-in state (0e5f9c8)
- Terminal-draft recovery: a queued-then-recalled message stranded on the "❯" input line surfaces as a composer chip, with "Edit here" to clear the line and adopt the text cleanly (46dcf35)

### Changed
- Dashboard leads with "Needs you" — agents awaiting your input sit at the top, above the spaces overview (1d92592)
- Dashboard, space, and settings scroll inside a viewport-clipped region instead of the whole document (2aa9272)
- Session switcher and the session chip are dashboard-only, keeping the in-space and pane headers clean (bb0048d, ba56ba9)
- Header polish: consistent compact height across the dashboard and inside a space, zinc-800 nav chrome, a ringed Collie mark, a smaller pane-header agent logo, and the keyboard-only quick-keys strip removed (6250e0c, 9da7195, 35db0e5, ba56ba9)
- Security posture documents that `COLLIE_MULTI_SESSION` (default on) fronts every named session under the config root (fcb0b7d)

### Fixed
- Deep-linking a space that never existed shows "Space not found" rather than "Space closed" (fcb0b7d)

## [0.9.1] - 2026-07-09

### Security
- Removed one-tap yes/no reply buttons from push notifications — they POSTed to the terminal without opening the app, i.e. approving blind. Notifications now only deep-link to the pane (cb26ee0)

## [0.9.0] - 2026-07-07

### Changed
- Quick keys mimic a physical keyboard on both surfaces: Esc top-left, Tab below it, inverted-T arrows, Enter top-right; Keys sheet gains a full-width spacebar (2f70662)
- Attach image lives in the reply row (usable without the phone keyboard open); digits leave the inline strip — the 123 tab remains (2f70662)
- Header collie logo is transparent like the gallop sprite — removed favicon.svg's baked-in gray backing rect (3f05da8)

## [0.8.0] - 2026-07-07

### Added
- Poll herdr 0.7.2's `session.snapshot` — one RPC per tick instead of three list calls; permanent fallback to the list trio on older servers (5687bbf)
- Event-poked polling: `events.subscribe` stream triggers immediate debounced re-polls; interval relaxes to `COLLIE_POLL_IDLE_MS` (default 12s) while the stream is healthy (5687bbf)

### Changed
- HERDR_API.md re-verified against herdr 0.7.2 / protocol 16; terminal observe/control filed under ARCHITECTURE.md Future ideas (aad94b3)

## [0.7.0] - 2026-07-06

### Added
- Notification type prefs: Settings "Notify when" toggles per agent status, bridge-wide; default pushes only "Needs input" (blocked) — "Finished" (done) is off (98cf5d2)

### Changed
- Push sends carry a `collie-herd` topic + 6h TTL: an offline device now gets one current summary on reconnect instead of replaying every queued update (98cf5d2)
- Disabling a notification kind retracts its pending/outstanding alerts immediately (98cf5d2)

## [0.6.0] - 2026-07-06

### Added
- First-paint PWA splash: the galloping collie shows before React mounts (299f632)
- Keys sheet: `Ctrl` modifier + visible key queue — compose chords/sequences, review, Send as one call; dialer-size digits on a `123` tab (515f795)

### Changed
- Header Collie mark matches the agent logo (2rem, aligned across screens); Find lives in the composer View row; placeholder is just "Type a reply…" (11385ee)

### Fixed
- Option taps no longer pop the phone keyboard or steal the note editor's focus (11385ee)
- Stalled connections no longer zombify the app: fetch timeouts (10s/20s/60s), polls supersede a wedged revalidation at 12s, and the collie gallops within 2.5s of a stalled load or pane-tap navigation (e6ad939)

## [0.5.0] - 2026-07-05

### Added
- **Preview-variant question notes.** Claude Code's *preview* AskUserQuestion — a single-select
  question whose options carry a `preview` field (the mockup/snippet pane, footer hint
  `n to add notes`) — is lifted into a native block that surfaces the per-question note affordance.
  A note (attach / edit / remove) is driven from the native option UI and applies **per question**,
  not per option row. Delivery uses the verified staged keystroke choreography
  (`n` → confirm the input focused → clear → paste the text via the reply path → `Escape` to blur,
  each stage verified rendered before the next fires; `Enter` is never sent, since it would submit
  the dialog — see `web/src/lib/grammar/NOTES_NOTES.md`), and option selection is the two-step
  digit → verify-pointer → `Enter` recipe. Race-guarded like the other dialog blocks (a stale tap on
  a drifted dialog aborts before anything irreversible is sent). Claude-scoped (`hasBlockGrammar`)
  and web-only; the standard non-preview select and wizard steps are unaffected (pressing `n` there
  is a no-op, so no notes UI is shown).

### Security
- **Preview-note tap guard hardened to region-signature parity.** The preview dialog's race guard now
  carries a pointer- and note-independent **core signature** (the subject/question/stepper above the
  options joined with the option rows' left column, `❯` normalised) — matching the 0.4.0 `signature`
  parity the prompt/wizard guards already had. It is enforced at entry AND on **every** mid-flight
  acceptance/drift check, so a same-shaped successor dialog (identical question + labels, different
  subject) can no longer be answered by a stale tap: no digit-then-`Enter` or `Enter` is sent unless
  the fresh read's core signature byte-matches what the user saw. The blur poll is now three-valued
  (ok / drifted / timeout) so the Escape-retry fires only on a genuine swallowed key — never after the
  dialog drifted or vanished (which a blind second Escape could cancel / interrupt). Pasted note text
  is stripped of C0/C1 control bytes (ESC, BEL, …) before it can reach the focused input.

## [0.4.0] - 2026-07-05

### Added
- **Block-based terminal renderer.** Pane rendering now flows through a semantic Block AST (styled
  lines → typed blocks → React components) instead of a flat span mirror. The raw-block foundation is
  byte-for-byte identical to the old mirror, but it's the seam every feature below builds on —
  detected regions are lifted into native blocks in place, and anything unrecognized falls back to
  the raw mirror. Scoped to Claude Code (`hasBlockGrammar`); every other agent renders the plain
  mirror, since their TUIs are unverified.
- **Native prompt buttons.** A Claude single-choice dialog at the buffer tail (select, permission,
  trust, plan approval) is lifted out of the mirror and rendered as tappable buttons; a tap sends the
  per-family keystrokes (digit, or digit+Enter for AskUserQuestion), guarded so a stale tap on a
  scrolled-up menu can't fire. The agent's own input box/statusline are stripped so they don't
  duplicate the composer.
- **Status strip.** The stripped statusline (model · ctx% · cwd · branch · tokens) is re-surfaced as
  a slim line above the composer, so the branch/context stays visible instead of vanishing with the
  input-box chrome.
- **Submission progress bar.** A slim indeterminate bar across the top of the app while any mutation
  (reply, keys, prompt tap, upload, tab/space create, close, snooze) is in flight; background polling
  never triggers it, and a 120ms delay means a fast action never flashes it.
- **Raw-terminal escape hatch.** A View toggle (terminal icon) that turns off the block renderer —
  native prompt buttons, chrome stripping, status strip — and shows the plain mirror, so a
  mis-detected/mis-rendered dialog can always be driven by hand with the keys pad. Persisted.
- **Multi-question wizard.** A multi-question AskUserQuestion (the `☒ Focus area ☐ Scope ✔ Submit`
  stepper) now renders as a native step-by-step wizard instead of bailing to the raw mirror: the
  stepper chips (answered/current per question), the current question's options as tappable buttons
  (one digit each — verified: a wizard digit instant-selects and advances), back/next step
  navigation, and the final Submit review step (answers echoed, submit/cancel). Incremental
  round-trip: every tap is a single race-guarded keystroke re-derived against a fresh read; the TUI
  stays the source of truth. Choreography + fixtures documented in
  `web/src/lib/grammar/WIZARD_NOTES.md`.
- **Galloping Collie loader.** The mascot now doubles as the app's activity indicator: a 6-frame
  gallop sprite (`web/public/dog-gallop.png`, a 768×128 transparent strip) stepped through with a
  pure-CSS `steps(6)` animation (no JS timers). At rest it's the familiar static app icon
  (`favicon.svg`); it springs into the gallop on the boot splash while the first snapshot loads and
  whenever the connection isn't live (connecting / reconnecting / offline), settling back to the
  static icon once live. Honours `prefers-reduced-motion`. New `DogGallop` component; rough
  first-pass art to be replaced with higher-quality frames.

### Changed
- **One consistent top-left mark on every screen.** The Collie is now the brand + home button +
  connection loader in a single shared `CollieHome` component, rendered identically on the dashboard
  and inside a pane — so the header's top-left always means the same thing (previously a "stacks"
  icon inside a pane vs. the Collie logo on the dashboard). Inside a pane the Collie gallops on
  reconnect from the same global connection state as the dashboard (shared `isConnecting` predicate).

### Removed
- **The pane's Nav-hub drawer** (the left "stacks" drawer). It was redundant now that the Collie
  handles Home, the swipe-up switcher already covers pane switching/closing, and the breadcrumb
  covers cross-space jumps — removed along with its `SpaceList` component. The swipe-up switcher now
  appears whenever a pane is open, so even the last pane stays closable.

### Fixed
- **Multi-question AskUserQuestion no longer mis-parsed.** A multi-step AskUserQuestion (the
  `☒ Focus area  ☐ Scope  ✔ Submit` stepper) was detected as a single-question select and answered
  with one digit+Enter — submitting a half-filled form. It's now recognized as a wizard and left as
  the raw mirror (drive it with the keys pad, or via the new escape hatch) rather than mis-sending.

### Security
- **Prompt/wizard taps are guarded against same-shaped successor dialogs.** The tap race guard now
  compares a byte-signature of the whole dialog region — including the subject above the options (the
  diff/command being approved), not just the question and option labels. So a tap on a frozen mirror
  can no longer approve a *different* action that happens to render an identical-looking prompt (e.g.
  a second edit to the same file after the first was answered elsewhere). Herdr's `revision` is a
  stub, so this content signature is the load-bearing freshness check.

## [0.3.0] - 2026-07-03

A full-codebase review pass: four audit agents (backend, frontend, security, ops/product) swept the
tree; everything they found was verified, fixed, and the top feature gaps were built.

### Added
- **Reply from the notification.** Needs-you pushes now carry up to two quick-reply action buttons
  (agent-aware: codex gets `yes`/`no`, others `yes`/`continue`; bridge sends `quickReplies` in the
  payload). Tapping one POSTs the reply straight from the service worker and confirms with a silent
  "Sent ✓" — no app open needed. Body tap still deep-links as before.
- **Find in output.** A magnifier in the pane header opens a find bar: case-insensitive match over
  the visible buffer, match count, prev/next that cooperates with the scroll-freeze, highlights
  rendered through the same React-text-node path (XSS boundary untouched).
- **Load older scrollback.** A "load older" row at the top of the mirror grows the fetched window
  600 lines at a time (up to 5000; the bridge clamps reads at 10000), preserving your scroll
  position across the refetch.
- **Destructive-input confirm.** Replies matching a reviewed pattern list (`rm -rf`, `sudo`,
  `git push --force`, `dd if=`, `mkfs`, redirects to system paths, …) flip Send into a two-tap
  "Really send?" state for ~3s — same pattern the `/clear` palette action already used.
- **Audit log.** Every write action (reply, keys, upload, tab/workspace create, pane close) appends
  a single JSONL line — timestamp, action, pane, device, truncated params — to
  `<state-dir>/audit.log` (mode 0600). Audit failures never block the action itself.
- `COLLIE_PUBLIC_HOSTS` env var — an explicit Host-header allowlist. When set, requests addressed
  to any other Host are rejected before origin logic, defeating DNS rebinding. Strongly
  recommended (set it to your MagicDNS name); effectively mandatory with `COLLIE_SERVE_MODE=http`.
- Startup warnings when `COLLIE_TRUSTED_USER` or `COLLIE_PUBLIC_HOSTS` is unset — parity with the
  existing bind/allowlist warnings, since an empty trusted-user means any tailnet device has write
  access.
- Uploaded images are now swept after 48h (was: kept forever).

### Changed
- **Builds are gated.** `bun run build` (root) and `collie-ctl.sh build` now typecheck bridge and
  web before building, and build into `dist-staging` with an atomic swap — a failed build can no
  longer leave an empty `web/dist` serving 503s. The pre-push hook typechecks both sides too
  (`SKIP_TYPECHECK=1` to bypass once). Root tsconfig now enforces `noUnusedLocals/Parameters`.
- **Write requests without an `Origin` header are rejected** unless they arrive on loopback
  (browsers always send Origin on POST; curl-on-host keeps working).
- Idle lock is now timestamp-based: backgrounding/foregrounding the app no longer resets the
  countdown, and returning past the deadline locks immediately.
- The composer moved into its own `<Composer>` component; `agent-chat.tsx` slimmed by ~230 lines.
- A reply whose text lands but whose submit keystroke fails now reports "typed into the pane but
  not submitted — check the pane before resending" (and `textDelivered: true`) instead of a generic
  error that invited double-sends.
- systemd unit hardened (`NoNewPrivileges`, `PrivateTmp`) and made persistent
  (`StartLimitIntervalSec=0`, `RestartSec=5`) so a crash-loop can't leave the service permanently
  down while you're phone-only.
- Notification deep links URL-encode the pane id; sheets manage focus (focus in on open, restore on
  close, `aria-labelledby`); space status dots gained screen-reader text; pinch-zoom re-enabled
  (removed `maximum-scale=1`).

### Fixed
- **Socket leak on RPC timeout** — a stalled Herdr left the Unix-socket FD open on every timed-out
  request; under the 1.5s poll cadence this exhausted file descriptors and wedged the bridge. Every
  terminal path now closes the socket.
- **UTF-8 corruption across socket chunks** — multi-byte characters (box drawing, emoji) straddling
  a socket-read boundary rendered as `�`; replies are now stream-decoded.
- **Overlapping polls** — a slow Herdr let 1.5s ticks pile up 3-4 concurrent polls; a tick is now
  skipped while the previous poll is in flight.
- **Upload buffering** — a too-large upload was buffered fully into RAM before the 10MB check;
  oversized `Content-Length` is now rejected up front and `Bun.serve` caps request bodies at 12MB.
- Push subscription saves are serialized and written atomically (temp+rename); concurrent
  add/prune can no longer drop a subscription. State files are written 0600 in 0700 dirs.
- First PWA load no longer flashes an immediate reload (service-worker `controllerchange` on
  initial claim was treated as an update).
- A rotated VAPID key now unsubscribes the stale push subscription and re-subscribes fresh instead
  of silently dead-ending pushes.
- Superseded loader revalidations are aborted (`request.signal` threaded through); raw key presses
  debounce their revalidate (one refetch per burst instead of one per keystroke).
- Slash-command insert appends to the draft instead of overwriting it; tap-to-focus no longer
  collapses an active text selection (copying pane output works now).
- `envInt` config parsing rejects garbage and out-of-range values (negative poll/debounce
  intervals, invalid ports) with a warning instead of silently accepting them.
- Static-file path guard now checks the directory boundary (`dist` vs `dist-*`); `?lines=` is
  clamped; API/static responses carry `X-Content-Type-Options: nosniff` and
  `Referrer-Policy: no-referrer`; graceful shutdown drains in-flight requests.
- Pre-commit version guard now also covers `web/vite.config.ts`, `web/index.html`,
  `web/package.json`, `web/public/`, `systemd/`, and root `package.json`, and requires the new
  version to sort strictly above the old one.

## [0.2.0] - 2026-06-30

### Changed
- **Smarter push notifications.** A blocked/done alert is no longer fire-and-forget. Each one now
  waits a short **debounce window** (`COLLIE_NOTIFY_DELAY_MS`, default 30s) before it sends; an agent
  you clear at your desk within that window never reaches your phone. Alerts that *do* fire are
  **retracted** automatically once the agent resolves (or its pane closes), so handled work stops
  piling up on your lock screen. The service worker also **suppresses** the system notification when a
  Collie tab is already open and visible (the in-app status surfaces it instead).
- **Coalesced into one notification.** The whole herd shares a single notification slot: one agent
  shows the named, deep-linked alert; several collapse into a *"N agents need you"* digest (tap → the
  triage home) that updates in place as agents come and go, instead of stacking N separate alerts.

### Added
- **Do Not Disturb / snooze** (Settings → *Do not disturb*): pause all push for 30m / 1h / 4h, or
  resume early. Server-enforced and self-expiring, so it quiets every device — and it clears whatever
  is already on the lock screen the moment you snooze. The current deadline rides the snapshot, so it
  stays in sync across devices.
- `COLLIE_NOTIFY_DELAY_MS` env var — the push debounce window in ms (default `30000`; `0` notifies on
  the next tick with no debounce).
- `POST /api/notifications/snooze` — set/clear the global snooze (`{ snoozedUntil: number | null }`);
  the active deadline is reported on the snapshot as `notifications.snoozedUntil`.

## [0.1.0] - 2026-06-30

Initial public release of **Collie** — a phone web UI to monitor and reply to your Herdr agent
herd over Tailscale.

### Added
- **Mobile-first PWA** (Vite + React + TypeScript + Tailwind v4 + shadcn): a triage dashboard
  (Spaces overview + Needs-you / Working / Idle agent groups), a per-agent colored terminal mirror,
  an agent-aware slash-command palette (Claude Code, Codex, pi, opencode), a special-keys pad with
  inline arrows/Tab, per-agent brand icons, image upload, and animated view transitions. Installable,
  with an auto-updating service worker and a build-stamp footer.
- **Bun/TypeScript bridge** over Herdr's Unix socket: a polled live snapshot (adaptive cadence,
  gzip + `ETag`/`304`) plus reply / keys / upload endpoints, and space/tab/pane management (create
  shell panes, switch, kill) through a unified nav hub.
- **Runs as a `systemd --user` service** supervised independently of Herdr, with a `tailscale serve`
  launcher (`scripts/collie-ctl.sh`) and a thin Herdr plugin (`herdr.collie`) exposing
  start / stop / restart / status / url / version / update / uninstall actions. One-command update
  (pull → rebuild → restart → re-link) for the linked checkout.
- **Optional Web Push (VAPID) notifications** when an agent needs you, with a custom service-worker
  push handler that renders the real message and deep-links the tap to the agent's pane.
- **Security posture:** loopback-only bind, `tailscale serve` as the sole ingress (never `funnel`),
  a same-origin gate, an optional `COLLIE_TRUSTED_USER` identity check, optional per-device
  authorisation via a trusted upstream header, a strict CSP, and terminal output rendered as React
  text nodes (the XSS boundary).

[Unreleased]: https://github.com/frizynn/nenu/compare/v0.39.0...HEAD
[0.39.0]: https://github.com/frizynn/nenu/compare/v0.38.0...v0.39.0
[0.38.0]: https://github.com/frizynn/nenu/compare/v0.37.3...v0.38.0
[0.37.0]: https://github.com/frizynn/nenu/releases/tag/v0.37.0
