import { useSyncExternalStore } from "react";

// The bridge's live invalidations (bridge/live-events.ts), received over one same-origin
// EventSource. An event only NAMES what changed (the herd, a pane's mirror, its queue or its
// transcript), and whoever shows that thing re-reads it through the usual API. Polling stays as the
// fallback: relaxed while the stream is up, at its old cadence while it is down, so a lost event
// costs one fallback interval and never correctness.

export type LiveTopic = "snapshot" | "pane" | "queue" | "journal";
/** `resync` follows a reconnect: events may have been missed, so every reader refreshes once. */
export type LiveEvent = { topic: LiveTopic; paneId?: string } | { topic: "resync"; paneId?: undefined };

const listeners = new Set<(event: LiveEvent) => void>();
const storeListeners = new Set<() => void>();
let healthy = false;
let mirrorShown = true;

function notifyStore(): void {
  for (const fn of storeListeners) fn();
}

function subscribeStore(fn: () => void): () => void {
  storeListeners.add(fn);
  return () => {
    storeListeners.delete(fn);
  };
}

/** Hear every invalidation; the returned function unsubscribes. */
export function onLiveEvent(listener: (event: LiveEvent) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Whether `event` asks the reader of `topic` for `paneId` to refresh. */
export function concerns(event: LiveEvent, topic: LiveTopic, paneId?: string | null): boolean {
  return event.topic === "resync" || (event.topic === topic && (topic === "snapshot" || event.paneId === paneId));
}

/** Live read, safe from timers, like idle.ts's isLocked. */
export function isLiveHealthy(): boolean {
  return healthy;
}

export function useLiveHealthy(): boolean {
  return useSyncExternalStore(subscribeStore, isLiveHealthy, isLiveHealthy);
}

/**
 * Whether the open pane's terminal mirror is on screen. The conversation view reads the journal and
 * uses the mirror only to notice a dialog, which arrives with a status change the stream announces,
 * so the mirror's poll may relax while this is false. Defaults to true: unknown means "keep up".
 */
export function setMirrorShown(next: boolean): void {
  if (mirrorShown === next) return;
  mirrorShown = next;
  notifyStore();
}

export function useMirrorShown(): boolean {
  return useSyncExternalStore(subscribeStore, () => mirrorShown, () => mirrorShown);
}

function setHealthy(next: boolean): void {
  if (healthy === next) return;
  healthy = next;
  notifyStore();
}

function emit(event: LiveEvent): void {
  for (const listener of listeners) listener(event);
}

const TOPICS: readonly string[] = ["snapshot", "pane", "queue", "journal"];

/** Validate one `data:` payload; anything else is ignored rather than trusted. */
export function parseLiveEvent(data: string): LiveEvent | null {
  try {
    const value: unknown = JSON.parse(data);
    if (!value || typeof value !== "object" || !("topic" in value) || typeof value.topic !== "string") return null;
    if (!TOPICS.includes(value.topic)) return null;
    const topic = value.topic as LiveTopic;
    if (!("paneId" in value)) return { topic };
    return typeof value.paneId === "string" ? { topic, paneId: value.paneId } : null;
  } catch {
    return null;
  }
}

/** The slice of EventSource this module drives, a seam for tests. */
export interface LiveSource {
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  close(): void;
}

export interface LiveDeps {
  open(url: string): LiveSource;
  setTimeout(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

const browserDeps: LiveDeps = {
  open: (url) => new EventSource(url),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
};

/** Reconnect delays after a failure; the last repeats. EventSource's own retry is not used, because
 *  it gives up for good on a non-200 answer (a proxy's sign-in redirect, a restart's 502). */
export const LIVE_BACKOFF_MS: readonly number[] = [1_000, 2_000, 5_000, 15_000, 30_000];

/**
 * Hold one stream open until the returned stop function runs. Opening marks the store healthy, an
 * error marks it unhealthy and reconnects after the backoff, and a reconnect emits `resync`.
 */
export function connectLiveEvents(url: string, deps: LiveDeps = browserDeps): () => void {
  let source: LiveSource | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let opened = false;
  let stopped = false;

  const connect = () => {
    timer = undefined;
    const current = deps.open(url);
    source = current;
    current.onopen = () => {
      if (source !== current) return;
      failures = 0;
      setHealthy(true);
      if (opened) emit({ topic: "resync" });
      opened = true;
    };
    current.onmessage = (message) => {
      if (source !== current || typeof message.data !== "string") return;
      const event = parseLiveEvent(message.data);
      if (event) emit(event);
    };
    current.onerror = () => {
      if (source !== current) return;
      current.close();
      source = null;
      setHealthy(false);
      if (stopped) return;
      const delay = LIVE_BACKOFF_MS[Math.min(failures, LIVE_BACKOFF_MS.length - 1)]!;
      failures++;
      timer = deps.setTimeout(connect, delay);
    };
  };

  connect();
  return () => {
    stopped = true;
    if (timer !== undefined) deps.clearTimeout(timer);
    source?.close();
    source = null;
    setHealthy(false);
  };
}

/** Test-only: drop listeners and state so suites can't leak into each other. */
export function resetLiveEvents(): void {
  listeners.clear();
  storeListeners.clear();
  healthy = false;
  mirrorShown = true;
}
