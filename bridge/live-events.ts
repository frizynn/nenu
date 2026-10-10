import type { EngineSnapshot } from "./state-engine.ts";
import type { LiveEvent, LivePublisher } from "./types.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Live invalidations for the browser. The bridge already learns about herd changes the moment they
// happen (Herdr's event stream pokes the engine; the queue is written here), but the page only found
// out on its next poll. This hub carries a NAME of what changed, never state, over one same-origin
// Server-Sent Events stream, and the page re-reads that one thing through the existing API. Exactly
// like the event poker, a lost event costs one fallback poll and never correctness: every read still
// goes through the usual routes, gates and caches.
// ─────────────────────────────────────────────────────────────────────────────

export type { LiveEvent, LiveTopic } from "./types.ts";

export class LiveEvents implements LivePublisher {
  private readonly listeners = new Set<(event: LiveEvent) => void>();

  publish(event: LiveEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  subscribe(listener: (event: LiveEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/**
 * Turn the engine's successive snapshots into invalidations: `snapshot` when anything the herd view
 * renders changed, plus `pane` and `journal` for each pane whose own entry changed (a status flip is
 * when a dialog appears or a turn lands in the transcript). An identical re-poll publishes nothing.
 */
export function snapshotWatcher(session: string, publish: (event: LiveEvent) => void): (snap: EngineSnapshot) => void {
  let herd: string | null = null;
  let panes = new Map<string, string>();
  return (snap) => {
    const nextHerd = JSON.stringify(snap);
    if (nextHerd === herd) return;
    const first = herd === null;
    herd = nextHerd;
    const next = new Map<string, string>();
    for (const pane of [...snap.agents, ...snap.shellPanes]) next.set(pane.paneId, JSON.stringify(pane));
    const previous = panes;
    panes = next;
    if (first) return;
    publish({ session, topic: "snapshot" });
    for (const [paneId, entry] of next) {
      if (previous.get(paneId) === entry) continue;
      publish({ session, topic: "pane", paneId });
      publish({ session, topic: "journal", paneId });
    }
  };
}

const eventKey = (event: LiveEvent) => `${event.session}\u0000${event.topic}\u0000${event.paneId ?? ""}`;

/**
 * Publish one event key at most once per `gapMs`. A change after a quiet spell goes out after
 * `delayMs` (0 = at once); changes inside the gap collapse into one trailing publish, so a screen that
 * repaints four times a second costs a watching phone one re-read a second.
 */
export class LiveThrottle {
  private readonly last = new Map<string, number>();
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly live: LivePublisher,
    private readonly gapMs: number,
    private readonly delayMs = 0,
  ) {}

  publish(event: LiveEvent): void {
    const key = eventKey(event);
    if (this.pending.has(key)) return;
    const wait = Math.max(this.delayMs, (this.last.get(key) ?? -Infinity) + this.gapMs - Date.now());
    const fire = () => {
      this.pending.delete(key);
      this.last.set(key, Date.now());
      this.live.publish(event);
    };
    if (wait <= 0) fire();
    else this.pending.set(key, setTimeout(fire, wait));
  }

  /** Drop what is held for this event: the producer stopped watching it. */
  forget(event: LiveEvent): void {
    const key = eventKey(event);
    clearTimeout(this.pending.get(key));
    this.pending.delete(key);
    this.last.delete(key);
  }
}

const encoder = new TextEncoder();
// Frames a client may leave unread before the stream is closed. A page that stopped reading reopens
// and refreshes everything on reconnect, so dropping it loses nothing and bounds what one slow phone
// can make the bridge hold.
const MAX_UNREAD_FRAMES = 256;

interface StreamOptions {
  /** Comment frame cadence; keeps proxies from reaping a quiet stream. */
  heartbeatMs?: number;
  /** Window that coalesces a burst (one engine poll emits several events) into one frame each. */
  flushMs?: number;
  /** The reconnect delay suggested to EventSource, in ms. */
  retryMs?: number;
  signal?: AbortSignal;
}

/**
 * One session's invalidations as an SSE body. Each frame is `data: {"topic":…,"paneId":…}`; an
 * identical event inside the flush window is sent once. Closing the request (or `cancel`) drops the
 * subscription and both timers.
 */
export function liveEventStream(hub: LiveEvents, session: string, options: StreamOptions = {}): ReadableStream<Uint8Array> {
  const { heartbeatMs = 15_000, flushMs = 25, retryMs = 2_000, signal } = options;
  let stop = () => {};
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const pending = new Map<string, Omit<LiveEvent, "session">>();
      let flushTimer: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      const send = (frame: string) => {
        if (closed) return;
        if ((controller.desiredSize ?? 0) < -MAX_UNREAD_FRAMES) return stop();
        try {
          controller.enqueue(encoder.encode(frame));
        } catch {
          stop();
        }
      };
      const flush = () => {
        flushTimer = undefined;
        for (const event of pending.values()) send(`data: ${JSON.stringify(event)}\n\n`);
        pending.clear();
      };
      const unsubscribe = hub.subscribe((event) => {
        if (event.session !== session) return;
        const wire = event.paneId === undefined ? { topic: event.topic } : { topic: event.topic, paneId: event.paneId };
        pending.set(`${event.topic}\u0000${event.paneId ?? ""}`, wire);
        flushTimer ??= setTimeout(flush, flushMs);
      });
      const heartbeat = setInterval(() => send(": ping\n\n"), heartbeatMs);
      stop = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
        clearTimeout(flushTimer);
        signal?.removeEventListener("abort", stop);
        try {
          controller.close();
        } catch {
          // Already closed by the consumer.
        }
      };
      signal?.addEventListener("abort", stop);
      if (signal?.aborted) return stop();
      send(`retry: ${retryMs}\nevent: ready\ndata: {}\n\n`);
    },
    cancel() {
      stop();
    },
  });
}
