import { watch as fsWatch, type FSWatcher } from "node:fs";

import type { ConversationService } from "./conversation-service.ts";
import { adapterFor } from "./journal/registry.ts";
import type { JournalAdapter } from "./journal/types.ts";
import { LiveThrottle } from "./live-events.ts";
import type { SessionRegistry } from "./sessions.ts";
import type { LivePublisher } from "./types.ts";

// fs.watch on the journals a page read recently, publishing `journal` on append (ADR 0058). A turn
// streaming into the log then reaches the open conversation as one frame and one read, instead of a
// 1.5 s poll. fs.watch on macOS can coalesce or drop events and a log can be replaced; both cost one
// fallback poll on the page, never correctness.

/** A pane's journal stays watched this long after its history was last read. */
const KEEP_MS = 60_000;
/** Bounds the open file watchers; the least recently read pane goes first. */
const MAX_WATCHED = 8;
/** Re-resolving costs a readdir of the project dir; a page re-reads history every few seconds. */
const RESOLVE_EVERY_MS = 5_000;
/** An append is several lines written in a burst; wait for the burst, then at most once a second. */
const PUBLISH_DELAY_MS = 100;
const PUBLISH_GAP_MS = 1_000;

/** The absolute journal path of a live pane, or null when it has none. */
export type JournalResolver = (session: string, paneId: string) => Promise<string | null>;
export type FileWatch = (path: string, onChange: (event: string) => void) => Pick<FSWatcher, "close" | "on">;

interface Entry {
  readonly session: string;
  readonly paneId: string;
  readAt: number;
  resolvedAt: number;
  path: string | null;
  watcher?: Pick<FSWatcher, "close">;
}

export interface JournalWatchOptions {
  keepMs?: number;
  maxWatched?: number;
  publishDelayMs?: number;
  publishGapMs?: number;
  resolveEveryMs?: number;
  watch?: FileWatch;
}

export class JournalWatch {
  private readonly entries = new Map<string, Entry>();
  private readonly throttle: LiveThrottle;
  private resolver: JournalResolver | null = null;
  private sweepTimer?: ReturnType<typeof setTimeout>;
  private readonly keepMs: number;
  private readonly maxWatched: number;
  private readonly resolveEveryMs: number;
  private readonly watchFile: FileWatch;

  constructor(readonly live: LivePublisher, options: JournalWatchOptions = {}) {
    this.keepMs = options.keepMs ?? KEEP_MS;
    this.maxWatched = options.maxWatched ?? MAX_WATCHED;
    this.resolveEveryMs = options.resolveEveryMs ?? RESOLVE_EVERY_MS;
    this.watchFile = options.watch ?? ((path, onChange) => fsWatch(path, { persistent: false }, onChange));
    this.throttle = new LiveThrottle(live, options.publishGapMs ?? PUBLISH_GAP_MS, options.publishDelayMs ?? PUBLISH_DELAY_MS);
  }

  /**
   * How a pane's journal is found. Set by the live-events route on its first stream: until a page
   * holds a stream nobody would hear the event, so there is nothing to watch.
   */
  resolveWith(resolver: JournalResolver): void {
    this.resolver ??= resolver;
  }

  /** A page just read this pane's journal; keep it watched for a while. */
  noteRead(session: string, paneId: string): void {
    if (!this.resolver) return;
    const now = Date.now();
    this.sweep(now);
    const key = `${session}\u0000${paneId}`;
    let entry = this.entries.get(key);
    if (!entry) {
      entry = { session, paneId, readAt: now, resolvedAt: -Infinity, path: null };
      this.entries.set(key, entry);
      this.evictBeyondCap();
    }
    entry.readAt = now;
    this.scheduleSweep();
    if (now - entry.resolvedAt < this.resolveEveryMs) return;
    entry.resolvedAt = now;
    void this.arm(key, entry, this.resolver);
  }

  /** Watched journal paths, for tests and diagnostics. */
  get watching(): string[] {
    return [...this.entries.values()].flatMap((entry) => (entry.watcher && entry.path ? [entry.path] : []));
  }

  /** Close every watcher (process shutdown, tests). */
  close(): void {
    clearTimeout(this.sweepTimer);
    this.sweepTimer = undefined;
    for (const key of [...this.entries.keys()]) this.drop(key);
  }

  /** Close the watchers nobody read for `keepMs`, even when no further read comes to notice. */
  private scheduleSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setTimeout(() => {
      this.sweepTimer = undefined;
      this.sweep(Date.now());
      if (this.entries.size > 0) this.scheduleSweep();
    }, this.keepMs);
    this.sweepTimer.unref?.();
  }

  private async arm(key: string, entry: Entry, resolve: JournalResolver): Promise<void> {
    const path = await resolve(entry.session, entry.paneId).catch(() => null);
    // Dropped while resolving, or the same file is already watched.
    if (this.entries.get(key) !== entry || (path === entry.path && entry.watcher)) return;
    entry.watcher?.close();
    entry.watcher = undefined;
    entry.path = path;
    if (!path) return;
    const event = { session: entry.session, topic: "journal" as const, paneId: entry.paneId };
    try {
      const watcher = this.watchFile(path, (kind) => {
        this.throttle.publish(event);
        // A rename means the file was replaced or moved: this watcher follows the old inode. Re-arm on
        // the next history read.
        if (kind === "rename") this.unwatch(entry);
      });
      watcher.on("error", () => this.unwatch(entry));
      entry.watcher = watcher;
    } catch {
      entry.path = null;
    }
  }

  private unwatch(entry: Entry): void {
    entry.watcher?.close();
    entry.watcher = undefined;
    entry.path = null;
    entry.resolvedAt = -Infinity;
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.entries) if (now - entry.readAt >= this.keepMs) this.drop(key);
  }

  private evictBeyondCap(): void {
    while (this.entries.size > this.maxWatched) {
      let oldest: [string, Entry] | undefined;
      for (const item of this.entries) if (!oldest || item[1].readAt < oldest[1].readAt) oldest = item;
      this.drop(oldest![0]);
    }
  }

  private drop(key: string): void {
    const entry = this.entries.get(key);
    if (!entry) return;
    entry.watcher?.close();
    this.entries.delete(key);
    this.throttle.forget({ session: entry.session, topic: "journal", paneId: entry.paneId });
  }
}

export interface JournalResolverDeps {
  transcript: boolean;
  journals: Record<string, JournalAdapter> | null;
  conversations: Pick<ConversationService, "resolve">;
  registry: Pick<SessionRegistry, "get">;
}

/**
 * Find a pane's journal the way the history route does: by pane id from the live snapshot, through
 * the pane's conversation binding and its harness adapter. Never a path from the client.
 */
export function journalPathResolver({ transcript, journals, conversations, registry }: JournalResolverDeps): JournalResolver {
  return async (session, paneId) => {
    const rt = registry.get(session);
    if (!transcript || !journals || !rt) return null;
    const { agents, shellPanes } = rt.engine.current();
    const original = [...agents, ...shellPanes].find((pane) => pane.paneId === paneId);
    if (!original) return null;
    const pane = await conversations.resolve(original, rt.herdr, session);
    const adapter = pane.agentSession ? adapterFor(journals, pane.agent) : undefined;
    return pane.agentSession && adapter ? adapter.source.resolve(pane.agentSession) : null;
  };
}
