import { afterEach, describe, expect, it } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { JournalWatch, journalPathResolver, type FileWatch } from "./journal-watch.ts";
import type { LiveEvent } from "./types.ts";

function recorder() {
  const events: LiveEvent[] = [];
  return { events, live: { publish: (event: LiveEvent) => events.push(event) } };
}

/** An fs.watch double: records open watchers and lets a test fire a change. */
function fakeWatch() {
  const open = new Map<string, (event: string) => void>();
  const watch: FileWatch = (path, onChange) => {
    open.set(path, onChange);
    return { close: () => { open.delete(path); }, on: () => ({}) as never } as unknown as ReturnType<FileWatch>;
  };
  return { open, watch };
}

let dir: string | undefined;
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
  dir = undefined;
});

describe("JournalWatch", () => {
  it("does nothing until a resolver is set", async () => {
    const { live } = recorder();
    const fs = fakeWatch();
    const watch = new JournalWatch(live, { watch: fs.watch });
    watch.noteRead("s", "p");
    await Bun.sleep(1);
    expect(fs.open.size).toBe(0);
  });

  it("publishes journal for the pane whose log changed", async () => {
    const { events, live } = recorder();
    const fs = fakeWatch();
    const watch = new JournalWatch(live, { watch: fs.watch, publishDelayMs: 0, publishGapMs: 0 });
    watch.resolveWith(async (_session, paneId) => `/logs/${paneId}.jsonl`);
    watch.noteRead("s", "p");
    await Bun.sleep(1);
    expect(watch.watching).toEqual(["/logs/p.jsonl"]);
    fs.open.get("/logs/p.jsonl")!("change");
    expect(events).toEqual([{ session: "s", topic: "journal", paneId: "p" }]);
    watch.close();
  });

  it("re-arms on a new path and keeps the set bounded", async () => {
    const { live } = recorder();
    const fs = fakeWatch();
    let generation = 1;
    const watch = new JournalWatch(live, { watch: fs.watch, maxWatched: 2, resolveEveryMs: 0 });
    watch.resolveWith(async (_session, paneId) => `/logs/${paneId}-${generation}.jsonl`);
    watch.noteRead("s", "a");
    await Bun.sleep(1);
    generation = 2;
    watch.noteRead("s", "a");
    await Bun.sleep(1);
    expect([...fs.open.keys()]).toEqual(["/logs/a-2.jsonl"]);
    watch.noteRead("s", "b");
    await Bun.sleep(1);
    watch.noteRead("s", "c");
    await Bun.sleep(1);
    expect(watch.watching.sort()).toEqual(["/logs/b-2.jsonl", "/logs/c-2.jsonl"]);
    expect(fs.open.size).toBe(2);
    watch.close();
    expect(fs.open.size).toBe(0);
  });

  it("closes a watcher nobody read within the keep window", async () => {
    const { live } = recorder();
    const fs = fakeWatch();
    const watch = new JournalWatch(live, { watch: fs.watch, keepMs: 20 });
    watch.resolveWith(async () => "/logs/p.jsonl");
    watch.noteRead("s", "p");
    await Bun.sleep(5);
    expect(fs.open.size).toBe(1);
    await Bun.sleep(60);
    expect(fs.open.size).toBe(0);
    watch.close();
  });

  it("re-resolves after the file was replaced", async () => {
    const { live } = recorder();
    const fs = fakeWatch();
    let resolves = 0;
    const watch = new JournalWatch(live, { watch: fs.watch, resolveEveryMs: 60_000 });
    watch.resolveWith(async () => { resolves++; return "/logs/p.jsonl"; });
    watch.noteRead("s", "p");
    await Bun.sleep(1);
    watch.noteRead("s", "p");
    await Bun.sleep(1);
    expect(resolves).toBe(1);
    fs.open.get("/logs/p.jsonl")!("rename");
    expect(fs.open.size).toBe(0);
    watch.noteRead("s", "p");
    await Bun.sleep(1);
    expect(resolves).toBe(2);
    expect(fs.open.size).toBe(1);
    watch.close();
  });

  it("hears a real append through fs.watch", async () => {
    dir = await mkdtemp(join(tmpdir(), "nenu-journal-watch-"));
    const path = join(dir, "s.jsonl");
    await writeFile(path, "{}\n");
    const { events, live } = recorder();
    const watch = new JournalWatch(live, { publishDelayMs: 0, publishGapMs: 0 });
    watch.resolveWith(async () => path);
    watch.noteRead("s", "p");
    await Bun.sleep(20);
    await appendFile(path, "{}\n");
    for (let i = 0; i < 50 && events.length === 0; i++) await Bun.sleep(10);
    expect(events[0]).toEqual({ session: "s", topic: "journal", paneId: "p" });
    watch.close();
  });
});

describe("journalPathResolver", () => {
  const pane = { paneId: "p", agent: "claude", agentSession: { kind: "id" as const, value: "abc" } };
  const runtime = { engine: { current: () => ({ agents: [pane], shellPanes: [] }) }, herdr: {} };
  const deps = (transcript: boolean) => ({
    transcript,
    journals: { claude: { agent: "claude", source: { resolve: async (ref: { value: string }) => `/logs/${ref.value}.jsonl` } } } as never,
    conversations: { resolve: async (p: unknown) => p } as never,
    registry: { get: (name?: string) => (name === "s" ? runtime : undefined) } as never,
  });

  it("resolves a live pane through its adapter and nothing else", async () => {
    const resolve = journalPathResolver(deps(true));
    expect(await resolve("s", "p")).toBe("/logs/abc.jsonl");
    expect(await resolve("s", "missing")).toBeNull();
    expect(await resolve("other", "p")).toBeNull();
    expect(await journalPathResolver(deps(false))("s", "p")).toBeNull();
  });
});
