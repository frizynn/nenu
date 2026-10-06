import { vi } from "vitest";

import { connectLiveEvents, type LiveSource } from "@/lib/live-events";

/** A live-events connection over a fake EventSource the test drives by hand. */
export function fakeLiveStream() {
  const sources: LiveSource[] = [];
  const stop = connectLiveEvents("/api/events", {
    open: () => {
      const source: LiveSource = { onopen: null, onmessage: null, onerror: null, close: vi.fn() };
      sources.push(source);
      return source;
    },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle),
  });
  const current = () => sources[sources.length - 1]!;
  return {
    sources,
    open: () => current().onopen?.(new Event("open")),
    fail: () => current().onerror?.(new Event("error")),
    send: (data: unknown) => current().onmessage?.(new MessageEvent("message", { data: JSON.stringify(data) })),
    stop,
  };
}
