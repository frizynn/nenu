import type { LivePublisher } from "./types.ts";

// Fast, local re-reads of the panes an open page is watching, publishing `pane` only when the screen
// changed (ADR 0058). Stub: the events route registers watches, nothing is read yet.
export class PaneWatcher {
  constructor(readonly live: LivePublisher) {}

  /** Watch `paneIds` in `session` until `signal` aborts (the SSE client went away). */
  watch(_session: string, _paneIds: string[], _signal: AbortSignal): void {}
}
