import type { HerdrClient } from "./herdr-client.ts";
import { LiveThrottle } from "./live-events.ts";
import type { LivePublisher } from "./types.ts";

// Fast, local re-reads of the panes an open page is watching, publishing `pane` only when the screen
// changed (ADR 0058). Herdr 0.9.1 announces no output, so the poll that used to run on the phone over
// the network runs here instead, next to the socket, and only for panes a live stream asked about.

/** Reads per watched pane while it is changing. A visible read costs ~0.23 ms (measured). */
const READ_EVERY_MS = 200;
/**
 * A quiet pane backs off by doubling up to this, so a phone left on a static dialog stops costing
 * Herdr five connections a second. It equals PUBLISH_GAP_MS, so a first change is not seen later
 * than an event could go out anyway.
 */
const QUIET_MAX_MS = 1_000;
/** After a failed read: a pane that went away or a Herdr restart should not be hammered. */
const RETRY_MS = 2_000;
/** At most one `pane` event a second per pane; the phone re-reads the mirror on each. */
const PUBLISH_GAP_MS = 1_000;
/**
 * A page that just wrote to a pane (a key, a reply, a paste) is waiting to see it land. A write after a
 * pause is read {@link TYPED_READ_MS} after it, a burst of writes {@link SETTLED_MS} after its last one,
 * and continuous typing once per {@link TYPED_GAP_MS}; each change then goes out at once instead of
 * once a second, for {@link TYPED_FOR_MS} after the last write. Continuous typing so costs fewer reads
 * than a pane changing on its own and no more phone mirror reads than before (the phone re-read the
 * herd after each burst); the gap is where latency is traded for those reads (ADR 0126).
 */
const TYPED_READ_MS = 30;
const SETTLED_MS = 300;
const TYPED_GAP_MS = 700;
const TYPED_FOR_MS = 1_500;
/** One page shows one pane; a few more covers a split view without letting a client ask for the herd. */
export const MAX_WATCHED_PER_CLIENT = 4;
// `visible` is the rendered viewport whatever the count (HERDR_API.md), so this only has to cover it.
const VISIBLE_LINES = 1_000;

/** The wait before the next read after `quiet` unchanged reads: doubling from `every`, up to `max`. */
export function quietDelay(quiet: number, every: number, max: number): number {
  return Math.min(every * 2 ** quiet, Math.max(max, every));
}

export type PaneReader = Pick<HerdrClient, "readPane">;

interface Watch {
  readonly session: string;
  readonly paneId: string;
  readonly herdr: PaneReader;
  clients: number;
  hash?: string;
  /** Consecutive reads that found the screen unchanged. */
  quiet: number;
  timer?: ReturnType<typeof setTimeout>;
  /** When the last read with a write behind it started (epoch ms): the typed gap runs from there. */
  typedReadAt: number;
  /** When a page last wrote to the pane (epoch ms). */
  writeAt: number;
  /** A read is on its way; it schedules the next one when it ends. */
  reading: boolean;
  /** Until when the pane's changes go out on the typed gap (epoch ms). */
  typedUntil: number;
  stopped: boolean;
}

export interface PaneWatcherOptions {
  readEveryMs?: number;
  quietMaxMs?: number;
  retryMs?: number;
  publishGapMs?: number;
  typedReadMs?: number;
  settledMs?: number;
  typedGapMs?: number;
  typedForMs?: number;
}

export class PaneWatcher {
  private readonly watches = new Map<string, Watch>();
  private readonly throttle: LiveThrottle;
  private readonly readEveryMs: number;
  private readonly quietMaxMs: number;
  private readonly retryMs: number;
  private readonly typedReadMs: number;
  private readonly settledMs: number;
  private readonly typedGapMs: number;
  private readonly typedForMs: number;

  constructor(readonly live: LivePublisher, options: PaneWatcherOptions = {}) {
    this.readEveryMs = options.readEveryMs ?? READ_EVERY_MS;
    this.quietMaxMs = options.quietMaxMs ?? QUIET_MAX_MS;
    this.retryMs = options.retryMs ?? RETRY_MS;
    this.typedReadMs = options.typedReadMs ?? TYPED_READ_MS;
    this.settledMs = options.settledMs ?? SETTLED_MS;
    this.typedGapMs = options.typedGapMs ?? TYPED_GAP_MS;
    this.typedForMs = options.typedForMs ?? TYPED_FOR_MS;
    this.throttle = new LiveThrottle(live, options.publishGapMs ?? PUBLISH_GAP_MS);
  }

  /** Watch `paneIds` in `session` until `signal` aborts (the SSE client went away). */
  watch(session: string, herdr: PaneReader, paneIds: readonly string[], signal: AbortSignal): void {
    if (signal.aborted) return;
    const held = [...new Set(paneIds)].slice(0, MAX_WATCHED_PER_CLIENT).map((paneId) => {
      const key = `${session}\u0000${paneId}`;
      let watch = this.watches.get(key);
      if (!watch) {
        watch = { session, paneId, herdr, clients: 0, quiet: 0, typedReadAt: 0, writeAt: 0, reading: false, typedUntil: 0, stopped: false };
        this.watches.set(key, watch);
        void this.read(watch);
      }
      watch.clients++;
      return key;
    });
    signal.addEventListener("abort", () => {
      for (const key of held) {
        const watch = this.watches.get(key);
        if (!watch || --watch.clients > 0) continue;
        watch.stopped = true;
        clearTimeout(watch.timer);
        this.watches.delete(key);
        this.throttle.forget({ session: watch.session, topic: "pane", paneId: watch.paneId });
      }
    }, { once: true });
  }

  /**
   * A page just wrote to this pane: read it soon, and let its changes out on the typed gap for a
   * moment. Only a watched pane is read; nobody is looking at the others' screens.
   */
  wrote(session: string, paneId: string): void {
    const watch = this.watches.get(`${session}\u0000${paneId}`);
    if (!watch) return;
    watch.writeAt = Date.now();
    watch.typedUntil = watch.writeAt + this.typedForMs;
    // A read in flight schedules the next one itself.
    if (!watch.reading) this.schedule(watch, this.afterWrite(watch));
  }

  /**
   * The wait for the read after a write: soon after it following a pause, else once the burst settles
   * or one typed gap after the last read for a write, whichever comes first.
   */
  private afterWrite(watch: Watch): number {
    const now = Date.now();
    const gap = watch.typedReadAt + this.typedGapMs - now;
    if (gap <= this.typedReadMs) return this.typedReadMs;
    return Math.max(this.typedReadMs, Math.min(gap, watch.writeAt + this.settledMs - now));
  }

  /** Read again in `delay`, in place of any read already pending. */
  private schedule(watch: Watch, delay: number): void {
    if (watch.stopped) return;
    clearTimeout(watch.timer);
    watch.timer = setTimeout(() => {
      watch.timer = undefined;
      void this.read(watch);
    }, delay);
  }

  /** Panes currently read, for tests and diagnostics. */
  get watching(): string[] {
    return [...this.watches.values()].map((watch) => watch.paneId);
  }

  private async read(watch: Watch): Promise<void> {
    let failed = false;
    watch.reading = true;
    const now = Date.now();
    if (watch.writeAt > watch.typedReadAt) watch.typedReadAt = now;
    try {
      const { text } = await watch.herdr.readPane(watch.paneId, "visible", VISIBLE_LINES, "ansi");
      const hash = Bun.hash(text).toString(16);
      // The first read only sets the baseline: the page that asked has just read the pane itself.
      if (!watch.stopped && watch.hash !== undefined && hash !== watch.hash) {
        // While typed into, the reads above set the pace.
        const typed = Date.now() < watch.typedUntil;
        this.throttle.publish({ session: watch.session, topic: "pane", paneId: watch.paneId }, typed ? 0 : undefined);
      }
      watch.quiet = hash === watch.hash ? watch.quiet + 1 : 0;
      watch.hash = hash;
    } catch {
      failed = true;
    }
    watch.reading = false;
    // Writes since the last typed read: the next one. Typing paused: one look per gap for a late echo.
    const next = failed ? this.retryMs
      : watch.writeAt > watch.typedReadAt ? this.afterWrite(watch)
      : Date.now() < watch.typedUntil ? this.typedGapMs
      : quietDelay(watch.quiet, this.readEveryMs, this.quietMaxMs);
    this.schedule(watch, next);
  }
}
