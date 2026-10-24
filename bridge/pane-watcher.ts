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
 * A page that just wrote to a pane (a key, a reply, a paste) is waiting to see it land, so for a
 * moment after each write the pane is read at {@link TYPED_READ_MS} and its changes go out at most
 * every {@link TYPED_GAP_MS}: typing shows in the mirror in about a tenth of a second instead of
 * waiting out the one-second gap, and stops costing extra reads {@link TYPED_FOR_MS} after the last key.
 */
const TYPED_READ_MS = 30;
const TYPED_GAP_MS = 200;
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
  reading: boolean;
  /** Until when a write from a page keeps the pane on the typed cadence (epoch ms). */
  typedUntil: number;
  stopped: boolean;
}

export interface PaneWatcherOptions {
  readEveryMs?: number;
  quietMaxMs?: number;
  retryMs?: number;
  publishGapMs?: number;
  typedReadMs?: number;
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
  private readonly typedGapMs: number;
  private readonly typedForMs: number;

  constructor(readonly live: LivePublisher, options: PaneWatcherOptions = {}) {
    this.readEveryMs = options.readEveryMs ?? READ_EVERY_MS;
    this.quietMaxMs = options.quietMaxMs ?? QUIET_MAX_MS;
    this.retryMs = options.retryMs ?? RETRY_MS;
    this.typedReadMs = options.typedReadMs ?? TYPED_READ_MS;
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
        watch = { session, paneId, herdr, clients: 0, quiet: 0, reading: false, typedUntil: 0, stopped: false };
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
   * A page just wrote to this pane: read it soon and keep it on the typed cadence for a moment. Only a
   * watched pane is read; nobody is looking at the others' screens.
   */
  wrote(session: string, paneId: string): void {
    const watch = this.watches.get(`${session}\u0000${paneId}`);
    if (!watch) return;
    watch.typedUntil = Date.now() + this.typedForMs;
    watch.quiet = 0;
    // A read in flight schedules the next one itself, on the typed cadence now.
    if (watch.reading) return;
    clearTimeout(watch.timer);
    watch.timer = setTimeout(() => void this.read(watch), this.typedReadMs);
  }

  /** Panes currently read, for tests and diagnostics. */
  get watching(): string[] {
    return [...this.watches.values()].map((watch) => watch.paneId);
  }

  private async read(watch: Watch): Promise<void> {
    let failed = false;
    watch.reading = true;
    try {
      const { text } = await watch.herdr.readPane(watch.paneId, "visible", VISIBLE_LINES, "ansi");
      const hash = Bun.hash(text).toString(16);
      // The first read only sets the baseline: the page that asked has just read the pane itself.
      if (!watch.stopped && watch.hash !== undefined && hash !== watch.hash) {
        const typed = Date.now() < watch.typedUntil;
        this.throttle.publish({ session: watch.session, topic: "pane", paneId: watch.paneId }, typed ? this.typedGapMs : undefined);
      }
      watch.quiet = hash === watch.hash ? watch.quiet + 1 : 0;
      watch.hash = hash;
    } catch {
      failed = true;
    }
    watch.reading = false;
    const next = failed ? this.retryMs : Date.now() < watch.typedUntil ? this.typedReadMs : quietDelay(watch.quiet, this.readEveryMs, this.quietMaxMs);
    if (!watch.stopped) watch.timer = setTimeout(() => void this.read(watch), next);
  }
}
