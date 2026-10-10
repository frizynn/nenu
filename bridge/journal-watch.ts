import type { LivePublisher } from "./types.ts";

// fs.watch on the journals a page read recently, publishing `journal` on append (ADR 0058). Stub:
// the history route reports its reads, nothing is watched yet.
export class JournalWatch {
  constructor(readonly live: LivePublisher) {}

  /** A page just read this pane's journal; keep it watched for a while. */
  noteRead(_session: string, _paneId: string): void {}
}
