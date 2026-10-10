import type { LivePublisher } from "./types.ts";

// Observer-only Claude Code hook events (status changes, dialog text). Hooks never decide anything:
// they only poke the engine and enrich an Interaction. Stub: routes/hooks.ts exposes no route yet.
export class ClaudeHooks {
  constructor(readonly live: LivePublisher) {}
}
