import type { LivePublisher } from "./types.ts";

// Live Codex thread notifications over the daemon socket Nenu already opens; observe-only (B7).
// Stub: constructed by the server, subscribes to nothing yet.
export class CodexLive {
  constructor(readonly live: LivePublisher) {}
}
