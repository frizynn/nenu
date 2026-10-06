import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fakeLiveStream } from "@/test/live-stream";
import { concerns, isLiveHealthy, onLiveEvent, parseLiveEvent, resetLiveEvents, type LiveEvent } from "./live-events";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  resetLiveEvents();
});

describe("parseLiveEvent", () => {
  it("accepts the bridge's frames and nothing else", () => {
    expect(parseLiveEvent('{"topic":"snapshot"}')).toEqual({ topic: "snapshot" });
    expect(parseLiveEvent('{"topic":"queue","paneId":"w1:p1"}')).toEqual({ topic: "queue", paneId: "w1:p1" });
    expect(parseLiveEvent('{"topic":"resync"}')).toBeNull();
    expect(parseLiveEvent('{"topic":"pane","paneId":3}')).toBeNull();
    expect(parseLiveEvent("not json")).toBeNull();
  });
});

describe("concerns", () => {
  it("matches the reader's own pane, and every reader after a resync", () => {
    expect(concerns({ topic: "queue", paneId: "a" }, "queue", "a")).toBe(true);
    expect(concerns({ topic: "queue", paneId: "b" }, "queue", "a")).toBe(false);
    expect(concerns({ topic: "journal", paneId: "a" }, "queue", "a")).toBe(false);
    expect(concerns({ topic: "resync" }, "journal", "a")).toBe(true);
  });
});

describe("connectLiveEvents", () => {
  it("reports health, forwards events, reconnects with backoff and resyncs after a gap", () => {
    const events: LiveEvent[] = [];
    onLiveEvent((event) => events.push(event));
    const stream = fakeLiveStream();
    expect(isLiveHealthy()).toBe(false);
    stream.open();
    expect(isLiveHealthy()).toBe(true);
    stream.send({ topic: "pane", paneId: "w1:p1" });
    expect(events).toEqual([{ topic: "pane", paneId: "w1:p1" }]);

    stream.fail();
    expect(isLiveHealthy()).toBe(false);
    expect(stream.sources[0]!.close).toHaveBeenCalled();
    vi.advanceTimersByTime(999);
    expect(stream.sources).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(stream.sources).toHaveLength(2);
    stream.open();
    expect(events.at(-1)).toEqual({ topic: "resync" });

    stream.stop();
    expect(isLiveHealthy()).toBe(false);
    expect(stream.sources[1]!.close).toHaveBeenCalled();
    vi.advanceTimersByTime(60_000);
    expect(stream.sources).toHaveLength(2);
  });
});
