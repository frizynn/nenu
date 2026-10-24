import { describe, expect, it } from "bun:test";

import { MAX_WATCHED_PER_CLIENT, PaneWatcher, quietDelay, type PaneReader } from "./pane-watcher.ts";
import type { LiveEvent } from "./types.ts";

function screen(initial = "a") {
  const reads: string[] = [];
  let text = initial;
  let fail = false;
  const herdr: PaneReader = {
    async readPane(paneId) {
      reads.push(paneId);
      if (fail) throw new Error("gone");
      return { pane_id: paneId, text, truncated: false, revision: 0 };
    },
  };
  return { herdr, reads, set: (next: string) => { text = next; }, failing: (next: boolean) => { fail = next; } };
}

function recorder() {
  const events: LiveEvent[] = [];
  return { events, live: { publish: (event: LiveEvent) => events.push(event) } };
}

describe("PaneWatcher", () => {
  it("publishes pane only when the screen changes, and nothing for a quiet pane", async () => {
    const { events, live } = recorder();
    const pane = screen();
    const watcher = new PaneWatcher(live, { readEveryMs: 5, quietMaxMs: 5, publishGapMs: 0 });
    const abort = new AbortController();
    watcher.watch("s", pane.herdr, ["p"], abort.signal);
    await Bun.sleep(40);
    expect(pane.reads.length).toBeGreaterThan(3);
    expect(events).toEqual([]);
    pane.set("b");
    await Bun.sleep(20);
    expect(events).toEqual([{ session: "s", topic: "pane", paneId: "p" }]);
    abort.abort();
  });

  it("backs off on a quiet pane and returns to the fast cadence on the first change", async () => {
    const { events, live } = recorder();
    const pane = screen();
    const watcher = new PaneWatcher(live, { readEveryMs: 5, quietMaxMs: 40, publishGapMs: 0 });
    const abort = new AbortController();
    watcher.watch("s", pane.herdr, ["p"], abort.signal);
    await Bun.sleep(200);
    // Reads at 0, 5, 15, 35, 75, 115, 155, 195 ms instead of every 5 ms.
    expect(pane.reads.length).toBeLessThan(12);
    pane.set("b");
    await Bun.sleep(60);
    expect(events).toEqual([{ session: "s", topic: "pane", paneId: "p" }]);
    abort.abort();
  });

  it("after a write, reads a quiet pane at once and lets its changes out on the short gap for a moment", async () => {
    const { events, live } = recorder();
    const pane = screen();
    const watcher = new PaneWatcher(live, { readEveryMs: 20, quietMaxMs: 400, publishGapMs: 1_000, typedReadMs: 5, typedGapMs: 10, typedForMs: 200 });
    const abort = new AbortController();
    watcher.watch("s", pane.herdr, ["p"], abort.signal);
    // Quiet: backed off to reads at 0, 20, 60, 140 ms, the next not before 300 ms.
    await Bun.sleep(150);
    pane.set("b");
    watcher.wrote("s", "p");
    await Bun.sleep(25);
    expect(events.length).toBe(1);
    pane.set("c");
    watcher.wrote("s", "p");
    await Bun.sleep(50);
    // Inside the one-second gap, the typed gap let the second change out.
    expect(events.length).toBe(2);
    abort.abort();
  });

  it("reads a typed pane once per typed gap, however fast the writes come", async () => {
    const { live } = recorder();
    const pane = screen();
    const watcher = new PaneWatcher(live, { readEveryMs: 5, quietMaxMs: 400, typedReadMs: 1, typedGapMs: 25 });
    const abort = new AbortController();
    watcher.watch("s", pane.herdr, ["p"], abort.signal);
    await Bun.sleep(5);
    const before = pane.reads.length;
    const started = Date.now();
    for (let i = 0; i < 50; i++) {
      watcher.wrote("s", "p");
      await Bun.sleep(2);
    }
    // One read per 25 ms gap, plus the one a write pulls and the timer's slack, where the 5 ms fast
    // cadence alone would read about once per write.
    const reads = pane.reads.length - before;
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(reads).toBeLessThanOrEqual(Math.ceil((Date.now() - started) / 25) + 2);
    expect(reads).toBeLessThan(25);
    abort.abort();
  });

  it("reads a burst of writes once it settles, not a typed gap later", async () => {
    const { events, live } = recorder();
    const pane = screen();
    const watcher = new PaneWatcher(live, { readEveryMs: 20, quietMaxMs: 400, publishGapMs: 1_000, typedReadMs: 1, settledMs: 20, typedGapMs: 400 });
    const abort = new AbortController();
    watcher.watch("s", pane.herdr, ["p"], abort.signal);
    await Bun.sleep(150);
    pane.set("w");
    watcher.wrote("s", "p");
    await Bun.sleep(10);
    expect(events.length).toBe(1);
    for (const next of ["wo", "wor", "word"]) {
      pane.set(next);
      watcher.wrote("s", "p");
      await Bun.sleep(5);
    }
    // The burst's last key shows about 20 ms after it, inside both the 400 ms gap and the one-second one.
    await Bun.sleep(40);
    expect(events.length).toBe(2);
    abort.abort();
  });

  it("ignores a write to a pane nobody watches", () => {
    const { events, live } = recorder();
    const watcher = new PaneWatcher(live);
    watcher.wrote("s", "p");
    expect(watcher.watching).toEqual([]);
    expect(events).toEqual([]);
  });

  it("a change resets the wait to the fast cadence; quiet reads double it up to the cap", () => {
    expect([0, 1, 2, 3, 4, 10].map((quiet) => quietDelay(quiet, 200, 1_000))).toEqual([200, 400, 800, 1_000, 1_000, 1_000]);
    expect(quietDelay(3, 200, 0)).toBe(200);
  });

  it("stops reading when the last client watching a pane leaves", async () => {
    const { live } = recorder();
    const pane = screen();
    const watcher = new PaneWatcher(live, { readEveryMs: 5, quietMaxMs: 5 });
    const first = new AbortController();
    const second = new AbortController();
    watcher.watch("s", pane.herdr, ["p"], first.signal);
    watcher.watch("s", pane.herdr, ["p"], second.signal);
    first.abort();
    await Bun.sleep(20);
    expect(watcher.watching).toEqual(["p"]);
    second.abort();
    expect(watcher.watching).toEqual([]);
    const before = pane.reads.length;
    await Bun.sleep(20);
    expect(pane.reads.length).toBeLessThanOrEqual(before + 1);
  });

  it("reads nothing for an aborted client and caps how many panes one client watches", () => {
    const { live } = recorder();
    const pane = screen();
    const watcher = new PaneWatcher(live, { readEveryMs: 1_000 });
    const gone = new AbortController();
    gone.abort();
    watcher.watch("s", pane.herdr, ["p"], gone.signal);
    expect(watcher.watching).toEqual([]);
    const abort = new AbortController();
    watcher.watch("s", pane.herdr, ["a", "a", "b", "c", "d", "e", "f"], abort.signal);
    expect(watcher.watching).toEqual(["a", "b", "c", "d"].slice(0, MAX_WATCHED_PER_CLIENT));
    abort.abort();
  });

  it("collapses a fast-repainting screen into at most one event per gap", async () => {
    const { events, live } = recorder();
    const pane = screen();
    const watcher = new PaneWatcher(live, { readEveryMs: 2, publishGapMs: 60 });
    const abort = new AbortController();
    watcher.watch("s", pane.herdr, ["p"], abort.signal);
    await Bun.sleep(10);
    for (let i = 0; i < 20; i++) {
      pane.set(`frame ${i}`);
      await Bun.sleep(4);
    }
    abort.abort();
    // 80 ms of changes at a 60 ms gap: the leading event plus at most one trailing one.
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events.length).toBeLessThanOrEqual(2);
  });

  it("keeps going after a failed read without publishing", async () => {
    const { events, live } = recorder();
    const pane = screen();
    const watcher = new PaneWatcher(live, { readEveryMs: 5, quietMaxMs: 5, retryMs: 5, publishGapMs: 0 });
    const abort = new AbortController();
    watcher.watch("s", pane.herdr, ["p"], abort.signal);
    await Bun.sleep(15);
    pane.failing(true);
    await Bun.sleep(15);
    expect(events).toEqual([]);
    pane.failing(false);
    pane.set("after");
    await Bun.sleep(20);
    expect(events).toEqual([{ session: "s", topic: "pane", paneId: "p" }]);
    abort.abort();
  });
});
