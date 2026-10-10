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
  stopped: boolean;
}

export interface PaneWatcherOptions {
  readEveryMs?: number;
  quietMaxMs?: number;
  retryMs?: number;
  publishGapMs?: number;
}

export class PaneWatcher {
  private readonly watches = new Map<string, Watch>();
  private readonly throttle: LiveThrottle;
  private readonly readEveryMs: number;
  private readonly quietMaxMs: number;
  private readonly retryMs: number;

  constructor(readonly live: LivePublisher, options: PaneWatcherOptions = {}) {
    this.readEveryMs = options.readEveryMs ?? READ_EVERY_MS;
    this.quietMaxMs = options.quietMaxMs ?? QUIET_MAX_MS;
    this.retryMs = options.retryMs ?? RETRY_MS;
    this.throttle = new LiveThrottle(live, options.publishGapMs ?? PUBLISH_GAP_MS);
  }

  /** Watch `paneIds` in `session` until `signal` aborts (the SSE client went away). */
  watch(session: string, herdr: PaneReader, paneIds: readonly string[], signal: AbortSignal): void {
    if (signal.aborted) return;
    const held = [...new Set(paneIds)].slice(0, MAX_WATCHED_PER_CLIENT).map((paneId) => {
      const key = `${session}\u0000${paneId}`;
      let watch = this.watches.get(key);
      if (!watch) {
        watch = { session, paneId, herdr, clients: 0, quiet: 0, stopped: false };
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

  /** Panes currently read, for tests and diagnostics. */
  get watching(): string[] {
    return [...this.watches.values()].map((watch) => watch.paneId);
  }

  private async read(watch: Watch): Promise<void> {
    let failed = false;
    try {
      const { text } = await watch.herdr.readPane(watch.paneId, "visible", VISIBLE_LINES, "ansi");
      const hash = Bun.hash(text).toString(16);
      // The first read only sets the baseline: the page that asked has just read the pane itself.
      if (!watch.stopped && watch.hash !== undefined && hash !== watch.hash) {
        this.throttle.publish({ session: watch.session, topic: "pane", paneId: watch.paneId });
      }
      watch.quiet = hash === watch.hash ? watch.quiet + 1 : 0;
      watch.hash = hash;
    } catch {
      failed = true;
    }
    const next = failed ? this.retryMs : quietDelay(watch.quiet, this.readEveryMs, this.quietMaxMs);
    if (!watch.stopped) watch.timer = setTimeout(() => void this.read(watch), next);
  }
}
