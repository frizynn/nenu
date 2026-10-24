import { useCallback, useEffect, useRef, useState } from "react";

// Bound one request when an IME or paste commits a large string at once. The remainder stays queued
// behind it, preserving order without handing the bridge an unbounded JSON array.
const MAX_BATCH = 64;

/**
 * A write that takes its turn among the keys: a paste, or a file's path once it is saved. `current`
 * turns false once the queue is reset (a pane change): a write still waiting on an upload then sends
 * nothing, since its pane is no longer the one on screen.
 */
export type OrderedWrite = (current: () => boolean) => Promise<boolean>;

// Serialize bursts of keys through Herdr's one-shot RPC. Ordering is guaranteed inside one
// `send_keys` array, but not across concurrent connections, so one batch stays in flight while any
// later input accumulates into the next batch. This is transport backpressure, not a typing delay:
// the first key leaves immediately and a slow round trip merely makes the following batch larger.
// A paste is one write of its own in the same line: keys typed after it wait for its answer. The line
// belongs to one pane: after a reset, a write still running for the old pane (an upload, say) no
// longer holds it, and the new pane's keys go at once.
export function useOrderedKeySender(
  send: (keys: string[]) => Promise<boolean>,
  onFailure: () => void,
) {
  const pending = useRef<Array<string | OrderedWrite>>([]);
  /** The generation whose write is on its way, or null: only the current generation's blocks the line. */
  const inFlight = useRef<number | null>(null);
  const generation = useRef(0);
  const mounted = useRef(true);
  const sendRef = useRef(send);
  const failureRef = useRef(onFailure);
  const pumpRef = useRef<() => void>(() => {});
  const [busy, setBusy] = useState(false);

  sendRef.current = send;
  failureRef.current = onFailure;

  const pump = useCallback(() => {
    if (inFlight.current === generation.current || pending.current.length === 0) return;

    const head = pending.current[0]!;
    let write: () => Promise<boolean>;
    if (typeof head === "function") {
      pending.current.shift();
      const writeGeneration = generation.current;
      write = () => head(() => writeGeneration === generation.current);
    } else {
      const end = pending.current.findIndex((item, i) => i >= MAX_BATCH || typeof item === "function");
      const batch = pending.current.splice(0, end === -1 ? MAX_BATCH : end) as string[];
      write = () => sendRef.current(batch);
    }
    const batchGeneration = generation.current;
    inFlight.current = batchGeneration;

    const flush = async () => {
      try {
        let ok = false;
        try {
          ok = await write();
        } catch {
          // A thrown transport failure has the same stop-now semantics as a false verdict.
        }
        if (!ok && batchGeneration === generation.current) {
          // A failure makes the target's input state unknown. Stop immediately and discard anything
          // that had not reached the wire rather than resuming blind after a transient error.
          pending.current = [];
          generation.current += 1;
          failureRef.current();
        }
      } finally {
        if (inFlight.current === batchGeneration) inFlight.current = null;
        if (pending.current.length > 0) {
          pumpRef.current();
        } else if (inFlight.current === null && mounted.current) {
          setBusy(false);
        }
      }
    };
    void flush();
  }, []);
  pumpRef.current = pump;

  const enqueue = useCallback((keys: Array<string | OrderedWrite>) => {
    if (keys.length === 0) return;
    pending.current.push(...keys);
    if (mounted.current) setBusy(true);
    pumpRef.current();
  }, []);

  // Invalidate queued work when the pane changes. An RPC already in flight cannot be recalled, but
  // it captured the old target before the reset; no unsent key is allowed to leak into the new pane.
  const reset = useCallback(() => {
    generation.current += 1;
    pending.current = [];
    if (mounted.current) setBusy(false);
  }, []);

  useEffect(
    () => () => {
      mounted.current = false;
      generation.current += 1;
      pending.current = [];
    },
    [],
  );

  return { enqueue, reset, busy };
}
