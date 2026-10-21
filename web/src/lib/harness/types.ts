// The pluggable detection seam. Each supported agent (claude, codex and omp today; opencode/pi/… tomorrow)
// contributes ONE HarnessAdapter: its own block-building pipeline plus the two chrome re-surfacing
// probes (the statusline the mirror strips, and a stranded input-box draft). The registry
// (registry.ts) maps a Herdr snapshot `agent` string to its adapter; everything not in the registry
// falls back to the universal raw mirror. This is the single decision site the render pipeline and
// agent-chat's status strip both route through, so the "which agents get grammars" policy can't drift.
//
// An adapter is DETECTION only. The Block union + renderers and the keystroke ACTION recipes
// (prompt/wizard/preview-action) stay in core, dispatched from agent-chat — the adapter just tells
// core what's on screen.

import type { Block, StyledLine } from "../blocks";

export interface HarnessAdapter {
  /** The exact Herdr snapshot `agent` string this adapter claims (its registry key). */
  agent: string;
  /** The native TUI accepts bracketed paste, preserving newlines as text until verified submit:
   *  for every message, or for the ones the predicate names. */
  bracketedPaste?: true | ((text: string) => boolean);
  /** The CLI attaches a picture whose path arrives as a bracketed paste of its own and draws
   *  `[Image #N]` at the cursor, so a message holding Nenu's picture uploads is typed piece by piece,
   *  each path pasted alone where it sits (bridge/guarded-send.ts, ADR 0104). */
  pastesImagePaths?: true;
  /** The adapter's OWN full block pipeline over the pane's styled lines — for Claude that is the
   *  raw-or-dialog result (dialog lift + chrome strip, else a single raw block). */
  buildBlocks(lines: StyledLine[]): Block[];
  /** Re-surface the statusline RUN this agent's chrome-stripping peeled off the mirror tail, one
   *  entry per row, top to bottom. A statusline is an arbitrary user command's output and is
   *  routinely several rows tall (model/cwd/branch on one, permission mode on another), so the
   *  contract is a list — a single-row harness returns a one-element array. Rows stay STYLED: a
   *  statusline separates its fields by colour, so flattening them to text loses what makes it
   *  readable at a glance. Empty = no box at the tail (a menu is up, or a foreign/torn buffer), so
   *  nothing to surface. */
  extractStatusLines(lines: StyledLine[]): StyledLine[];
  /** Re-surface a block of rows the harness paints UNDER its statusline about work running beside
   *  the main session (Claude's background-agents footer: "● main" plus one row per agent). Stripped
   *  off the mirror with the rest of the tail, so this is its only surface. STYLED rows, top to
   *  bottom, verbatim. OPTIONAL: a harness without such a block omits it, and `[]` means none now. */
  extractAgentsFooter?(lines: StyledLine[]): StyledLine[];
  /** Re-surface a user draft stranded on the input box's prompt line (null = no box / empty / a
   *  known placeholder). */
  extractInputDraft(lines: StyledLine[]): string | null;
  /**
   * Whether this agent's free-text input box is on screen right now — i.e. whether typing a reply
   * would reach the composer at all, rather than a modal that has the keyboard.
   *
   * OPTIONAL, and its absence means "no idea": the reply path's pre-flight (bridge/guarded-send.ts)
   * only refuses to type when an adapter answers a definite `false`. An adapter that can't tell
   * omits it and keeps today's type-then-verify behaviour, which is still safe — the submit key is
   * withheld either way; the pre-flight just avoids depositing the text in a menu first.
   */
  composerReady?(lines: StyledLine[]): boolean;
  /** The CLI is still taking in a paste (Claude's "Pasting…" under its box): what the box shows of
   *  it is not final yet. OPTIONAL: a harness that never says so omits it. */
  pasting?(lines: StyledLine[]): boolean;
  /**
   * Literal on-screen text from the composer's prompt/draft tail — the region a DESTRUCTIVE write
   * aimed at that composer may be bound to. Null = no composer at the tail (the same screens
   * `composerReady` answers false about).
   *
   * The reply path's pre-clear sweep (`ctrl+k` + a run of Backspaces, bridge/guarded-send.ts) is the one
   * keystroke burst in the app that is authorised by a client-side read rather than by a dialog
   * model, so it has no `signature` to carry. This is its equivalent: pass the region through as
   * `expected_prompt` and the bridge re-reads the pane immediately before `send_keys`, 409ing the
   * write if that row is no longer there (bridge/server.ts `checkPromptBinding`). That collapses the
   * window between "a read said composer" and "the keys land" from a network round-trip to two local
   * RPCs — the same mitigation `lib/dialog-guard.ts` gives every tap.
   *
   * OPTIONAL, and absence means the sweep goes out unbound, which is the pre-existing behaviour. The
   * bridge accepts a region only if its match ends within the last few non-blank rows, so an adapter
   * with a wrapping composer should include enough of the tail for the match to end there. A region
   * whose final row sits too high would refuse legitimate sweeps, which is worse than leaving it out.
   */
  composerPrompt?(lines: StyledLine[]): string | null;
  /**
   * SUPPLEMENTAL evidence that `sent` reached the input box, for the case the reply guard's own
   * literal-substring match structurally cannot see: a harness that swallows what was typed and paints
   * a TOKEN of its own instead (Claude's `[Pasted text #N +M lines]`), so the box never holds our
   * words at all and the send stalls forever while every retry re-collapses.
   *
   * OPTIONAL, and consulted ONLY after the generic match has already failed (bridge/guarded-send.ts) —
   * it can widen what counts as evidence, never narrow it. The contract is strict-or-false: return
   * true only when the token on screen is CONSISTENT with this exact send, because a `true` here fires
   * the submit key. An adapter that can't tell omits it and keeps today's stall.
   */
  draftCarriesSend?(sent: string, draft: string): boolean;
  /**
   * Stop (ADR 0066): the key that interrupts this CLI's running turn, measured on the CLI, and how to
   * read from the screen whether a turn runs and what the key does to the CLI's own queue.
   *
   * OPTIONAL, and absence means Nenu offers no Stop for this agent. A key that only usually
   * interrupts is not enough: pressed at an idle screen, Claude's and Codex's Escape opens their
   * rewind on the second press, so the bridge presses it only while a turn runs. The CLI's own state
   * (bridge/agent-state.ts, ADR 0067) says that when the bridge has it; `read` is the fallback, and
   * still the only source for what the key does to Codex's own queue.
   */
  interrupt?: TurnInterrupt;
  /**
   * Where this agent's model picker sets the reasoning effort, measured on its `/model` screen:
   * `"arrows"`, a `←/→` row on that screen beside the model list; `"after-model"`, a list of its own
   * the picker opens once a model is chosen. OPTIONAL, and absence means unknown: Nenu then shows
   * the reported effort without offering a way to change it.
   */
  modelEffort?: "arrows" | "after-model";
}

export interface TurnInterrupt {
  keys: string[];
  /** Reads a `pane.read` in ANSI form, the way the bridge gets it. */
  read(text: string): TurnReading;
}

/** What one screen says about the running turn. */
export interface TurnReading {
  /** The CLI paints its own interrupt hint, so its interrupt key reaches a running turn. */
  running: boolean;
  /**
   * What interrupting does to messages waiting in the CLI's own queue, as measured: `sends` submits
   * them at once (Claude's queue, Codex's pending steer), `returns` puts them back in the input box
   * (Codex's follow-up queue). Null when nothing waits there.
   */
  queued: "sends" | "returns" | null;
}
