import { describe, expect, it } from "bun:test";

import { MAX_WATCHED_PER_CLIENT, PaneWatcher, type PaneReader } from "./pane-watcher.ts";
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
    const watcher = new PaneWatcher(live, { readEveryMs: 5, publishGapMs: 0 });
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

  it("stops reading when the last client watching a pane leaves", async () => {
    const { live } = recorder();
    const pane = screen();
    const watcher = new PaneWatcher(live, { readEveryMs: 5 });
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
    const watcher = new PaneWatcher(live, { readEveryMs: 5, retryMs: 5, publishGapMs: 0 });
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
