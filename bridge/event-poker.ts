import type { HerdrClient, OutputMatch, PaneRead, ReadSource } from "./herdr-client.ts";
import { allowedTokens } from "./state-engine.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Event-poked polling. A long-lived events.subscribe stream whose ONLY job is to
// trigger immediate (debounced) re-polls. While the stream is healthy the engine
// relaxes to a safety-net cadence; when it's down the engine falls back to fast
// polling. Events are never state here — a missed event costs one interval, never
// correctness — so the snapshot poll stays the single source of truth. See index.ts.
// ─────────────────────────────────────────────────────────────────────────────

/** A subscription request entry: global (just `type`) or pane-scoped (needs `pane_id`). */
export type Subscription = { type: string; pane_id?: string } & Record<string, unknown>;

// Global events that change what Nenu's snapshot renders. We deliberately DROP layout.*,
// worktree.* and pane.scroll_changed — none of them alter the herd view we poll for, so
// subscribing would only add pokes that re-fetch identical state.
const GLOBAL_SUBSCRIPTIONS: readonly string[] = [
  "workspace.created",
  "workspace.updated",
  "workspace.renamed",
  "workspace.closed",
  "workspace.focused",
  "tab.created",
  "tab.closed",
  "tab.focused",
  "tab.renamed",
  "pane.created",
  "pane.closed",
  "pane.focused",
  "pane.moved",
  "pane.exited",
  "pane.agent_detected",
];

/**
 * Types an older server does not know. One unknown subscription type rejects the WHOLE subscribe,
 * so these go out only when `ping` reports this protocol or newer, and a server that still rejects
 * them is remembered and served the base list. `pane.updated` is a metadata poke (title, tokens,
 * session id), about once a second for Codex's animated title; it never tracks status.
 */
export const EXTENDED_SUBSCRIPTIONS_PROTOCOL = 22;
const EXTENDED_SUBSCRIPTIONS: readonly string[] = [
  "pane.updated",
  "workspace.metadata_updated",
  "workspace.moved",
  "workspace.reordered",
  "tab.moved",
];

/**
 * A standing `pane.output_matched` request. Herdr re-reads the pane every 100 ms for each one, so a
 * caller asks only for the panes it needs. A match is a trigger to look, never the answer itself.
 */
export interface OutputWatch {
  paneId: string;
  source: ReadSource;
  match: OutputMatch;
  lines?: number;
}

export interface OutputMatched {
  paneId: string;
  matchedLine: string;
  read?: PaneRead;
}

/**
 * The full subscription list: every global above (plus the extended ones when the server supports
 * them), one pane-scoped `pane.agent_status_changed` per agent pane, and one `pane.output_matched`
 * per watch on a known agent pane. A watch on any other pane is left out: a subscription naming a
 * pane that no longer exists rejects the whole subscribe.
 */
export function buildSubscriptions(
  agentPaneIds: string[],
  opts: { extended?: boolean; outputWatches?: OutputWatch[] } = {},
): Subscription[] {
  const globals = opts.extended ? [...GLOBAL_SUBSCRIPTIONS, ...EXTENDED_SUBSCRIPTIONS] : GLOBAL_SUBSCRIPTIONS;
  const subs: Subscription[] = globals.map((type) => ({ type }));
  for (const id of agentPaneIds) subs.push({ type: "pane.agent_status_changed", pane_id: id });
  const known = new Set(agentPaneIds);
  for (const w of opts.outputWatches ?? []) {
    if (!known.has(w.paneId)) continue;
    subs.push({
      type: "pane.output_matched", pane_id: w.paneId, source: w.source, match: w.match,
      ...(w.lines !== undefined ? { lines: w.lines } : {}),
    });
  }
  return subs;
}

/** Order-insensitive, duplicate-insensitive comparison — the subscription set only cares which ids. */
export function sameIdSet(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const id of sa) if (!sb.has(id)) return false;
  return true;
}

/**
 * What a `pane.updated` record must change for Nenu to re-poll early. The title is left out on
 * purpose: Codex animates it about once a second, and the regular poll already carries it.
 */
function paneMetaKey(pane: Record<string, unknown>): string {
  return JSON.stringify([pane.agent, pane.label, pane.agent_session, allowedTokens(pane.tokens as Record<string, unknown>)]);
}

const watchKey = (watches: OutputWatch[]) =>
  JSON.stringify(watches.map((w) => [w.paneId, w.source, w.match.type, w.match.value, w.lines ?? null]).sort());

/**
 * Default trailing debounce. A herd-wide burst (pane.agent_detected on re-detection) arrives within a
 * few milliseconds, so this still folds it into one poll, and a status flip now reaches an open page
 * (through live-events.ts) in about this long rather than a fifth of a second.
 */
export const EVENT_DEBOUNCE_MS = 50;

interface EventPokerOpts {
  /** Trailing-debounce window (ms) that coalesces a burst of events into one poke. */
  debounceMs?: number;
  /** Reconnect backoff schedule (ms); the last entry repeats indefinitely. */
  backoffMs?: number[];
}

export class EventPoker {
  private readonly debounceMs: number;
  private readonly backoff: number[];
  private agentPanes: string[] = [];
  private outputWatches: OutputWatch[] = [];
  private started = false;
  private healthy = false;
  private backoffIdx = 0;
  // The server's protocol, probed with `ping` before a subscribe and forgotten when the stream drops
  // on its own (the server may have been upgraded). null = not probed yet.
  private protocol: number | null = null;
  // Set once a server rejected the extended types despite its protocol; it then gets the base list.
  private extendedRejected = false;
  // Bumped by every connect/reconnect/stop so a protocol probe that resolves late is discarded.
  private attempt = 0;
  private probing: Promise<number> | null = null;
  // The active stream handle; identity-compared in callbacks so a superseded stream's late `onDown`
  // (from a deliberate close during reconnect/stop) is ignored instead of flapping health.
  private stream: { close(): void } | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly pokeListeners = new Set<() => void>();
  private readonly healthListeners = new Set<(healthy: boolean) => void>();
  private readonly outputListeners = new Set<(event: OutputMatched) => void>();
  // Last `paneMetaKey` per pane seen on this stream; reset on every subscribe.
  private readonly paneMeta = new Map<string, string>();

  constructor(
    private readonly client: HerdrClient,
    opts: EventPokerOpts = {},
  ) {
    this.debounceMs = opts.debounceMs ?? EVENT_DEBOUNCE_MS;
    this.backoff = opts.backoffMs ?? [1000, 2000, 5000, 15000];
  }

  onPoke(cb: () => void): () => void {
    this.pokeListeners.add(cb);
    return () => this.pokeListeners.delete(cb);
  }

  onHealth(cb: (healthy: boolean) => void): () => void {
    this.healthListeners.add(cb);
    return () => this.healthListeners.delete(cb);
  }

  /** Hears every `pane.output_matched` for the watches set with {@link setOutputWatches}, undebounced. */
  onOutputMatched(cb: (event: OutputMatched) => void): () => void {
    this.outputListeners.add(cb);
    return () => this.outputListeners.delete(cb);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.connect();
  }

  stop(): void {
    this.started = false;
    this.attempt++;
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer);
      this.debounceTimer = null;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    // Detach BEFORE closing so the close's `onDown` is seen as stale (no health flip, no reconnect).
    const s = this.stream;
    this.stream = null;
    if (s) s.close();
  }

  /** The fresh snapshot after any pane lifecycle event feeds this; a changed set means re-subscribe. */
  setAgentPanes(ids: string[]): void {
    if (sameIdSet(ids, this.agentPanes)) return;
    this.agentPanes = [...ids];
    if (this.started) this.reconnect();
  }

  /** Replace the standing output watches; a changed set means re-subscribe. */
  setOutputWatches(watches: OutputWatch[]): void {
    if (watchKey(watches) === watchKey(this.outputWatches)) return;
    this.outputWatches = [...watches];
    if (this.started) this.reconnect();
  }

  private connect(): void {
    const attempt = ++this.attempt;
    if (this.protocol !== null) return this.open(this.protocol);
    // A resubscribe while the probe is still out (the first poll lands right after start) shares it.
    this.probing ??= this.probeProtocol().finally(() => {
      this.probing = null;
    });
    this.probing.then(
      (protocol) => {
        if (!this.started || attempt !== this.attempt) return;
        this.protocol = protocol;
        this.open(protocol);
      },
      (err: unknown) => {
        if (!this.started || attempt !== this.attempt) return;
        this.setHealthy(false, 0, `protocol probe failed: ${(err as Error).message}`);
        this.scheduleReconnect();
      },
    );
  }

  /** A server too old to answer `ping` (or a client without it) reads as protocol 0: base list only. */
  private async probeProtocol(): Promise<number> {
    if (typeof this.client.serverInfo !== "function") return 0;
    try {
      return (await this.client.serverInfo()).protocol;
    } catch (err) {
      if (err instanceof Error && err.message.includes("unknown variant")) return 0;
      throw err;
    }
  }

  private open(protocol: number): void {
    const extended = protocol >= EXTENDED_SUBSCRIPTIONS_PROTOCOL && !this.extendedRejected;
    const subs = buildSubscriptions(this.agentPanes, { extended, outputWatches: this.outputWatches });
    this.paneMeta.clear();
    let acked = false;
    const handle = this.client.subscribeEvents({
      subscriptions: subs,
      onUp: () => {
        if (this.stream !== handle) return;
        acked = true;
        this.backoffIdx = 0;
        // A resubscribe acks while already healthy, so setHealthy dedupes it silently — but it's
        // the only journal evidence that the per-pane subscriptions followed the herd. Log it.
        if (this.healthy) console.log(`[events] resubscribed (${subs.length} subscriptions)`);
        this.setHealthy(true, subs.length);
      },
      onEvent: (event, data) => {
        if (this.stream !== handle) return;
        // Pane-scoped events arrive dot-form on 0.9.3 (`pane.agent_status_changed`), globals snake_case.
        const kind = event.replace(".", "_");
        if (kind === "pane_output_matched") return this.emitOutput(data);
        if (kind === "pane_updated" && !this.paneMetaChanged(data)) return;
        this.schedulePoke();
      },
      onDown: (reason, code) => {
        if (this.stream !== handle) return;
        this.stream = null;
        if (!this.started) return;
        // The server rejected a type its protocol number promised: serve it the base list from now on.
        if (extended && !acked && reason.includes("unknown variant")) {
          this.extendedRejected = true;
          console.log(`[events] server rejected the protocol ${protocol} subscriptions, using the base list: ${reason}`);
          return this.connect();
        }
        this.setHealthy(false, subs.length, reason);
        if (code === "events_lost") {
          // The stream fell behind and Herdr dropped it: whatever happened meanwhile is unknown, so
          // re-read the herd now and resubscribe at once (the docs-prescribed recovery).
          this.schedulePoke();
          return this.connect();
        }
        // A subscription named a pane that is gone. A fresh poll hands back the live pane set
        // (setAgentPanes resubscribes with it); the backoff below is only the fallback.
        if (code === "pane_not_found") this.schedulePoke();
        else this.protocol = null;
        this.scheduleReconnect();
      },
    });
    this.stream = handle;
  }

  private paneMetaChanged(data: unknown): boolean {
    const pane = (data as { pane?: unknown } | null)?.pane;
    if (!pane || typeof pane !== "object") return true;
    const { pane_id: id } = pane as { pane_id?: unknown };
    if (typeof id !== "string") return true;
    const key = paneMetaKey(pane as Record<string, unknown>);
    if (this.paneMeta.get(id) === key) return false;
    this.paneMeta.set(id, key);
    return true;
  }

  private emitOutput(data: unknown): void {
    if (!data || typeof data !== "object") return;
    const d = data as { pane_id?: unknown; matched_line?: unknown; read?: PaneRead };
    if (typeof d.pane_id !== "string") return;
    const event: OutputMatched = {
      paneId: d.pane_id,
      matchedLine: typeof d.matched_line === "string" ? d.matched_line : "",
      ...(d.read && typeof d.read.text === "string" ? { read: d.read } : {}),
    };
    for (const cb of this.outputListeners) cb(event);
  }

  private reconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const old = this.stream;
    this.stream = null;
    if (old) old.close();
    this.connect();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    const delay = this.backoff[Math.min(this.backoffIdx, this.backoff.length - 1)] ?? 1000;
    this.backoffIdx++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.started) this.connect();
    }, delay);
  }

  private schedulePoke(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      for (const cb of this.pokeListeners) cb();
    }, this.debounceMs);
  }

  private setHealthy(healthy: boolean, subCount: number, reason?: string): void {
    if (this.healthy === healthy) return;
    this.healthy = healthy;
    if (healthy) console.log(`[events] stream up (${subCount} subscriptions)`);
    else console.log(`[events] stream down: ${reason ?? "unknown"} — fast polling until it recovers`);
    for (const cb of this.healthListeners) cb(healthy);
  }
}
