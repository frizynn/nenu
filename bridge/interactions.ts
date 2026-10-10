import type { Interaction, LivePublisher } from "./types.ts";

// One detected dialog per pane, read from the screen with the same adapters the web app uses
// (ADR 0057). Stub: wired into the server so routes/interactions.ts can serve it, detects nothing yet.
export class Interactions {
  constructor(readonly live: LivePublisher) {}

  current(_session: string, _paneId: string): Interaction | null {
    return null;
  }
}
