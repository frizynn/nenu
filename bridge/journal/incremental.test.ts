import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { claudeJournal } from "./claude.ts";
import { codexJournal } from "./codex.ts";
import { TranscriptStore } from "./store.ts";
import type { JournalAdapter, TranscriptSource } from "./types.ts";

// The incremental store against the whole-read parse, over real logs the P0 probes captured
// (scrubbed, committed under web/src/lib/harness/*/fixtures). Any split of a log into appends must
// leave the store exactly where one read of the whole log leaves it.

const FIXTURES = join(import.meta.dir, "..", "..", "web", "src", "lib", "harness");
const CLAUDE_LOG = join(FIXTURES, "claude", "fixtures", "journal-queue-and-dialogs-v2296.jsonl");
const CODEX_LOG = join(FIXTURES, "codex", "fixtures", "rollout-steer-queue-approval-v0160.jsonl");
const encode = (text: string) => new TextEncoder().encode(text);
const REF = { kind: "id", value: "00000000-0000-0000-0000-000000000001" } as const;
const ALL = { limit: Number.MAX_SAFE_INTEGER };

/** One log in memory that a test appends to, rewrites or replaces, counting the bytes each read asks for. */
function memoryLog(initial: Uint8Array) {
  const file = { bytes: initial, ino: 1, mtimeMs: 1 };
  const reads: Array<[number, number]> = [];
  const source: TranscriptSource = {
    resolve: async () => "/mem/log.jsonl",
    stat: async () => ({ size: file.bytes.length, mtimeMs: file.mtimeMs, ino: file.ino }),
    load: async () => { throw new Error("the incremental path never loads"); },
    read: async (_path, start, end) => {
      reads.push([start, end]);
      return file.bytes.slice(start, Math.min(end, file.bytes.length));
    },
  };
  return {
    source,
    reads,
    append(more: Uint8Array) {
      const next = new Uint8Array(file.bytes.length + more.length);
      next.set(file.bytes);
      next.set(more, file.bytes.length);
      file.bytes = next;
      file.mtimeMs++;
    },
    replace(bytes: Uint8Array, ino = file.ino) {
      file.bytes = bytes;
      file.ino = ino;
      file.mtimeMs++;
    },
  };
}

const withSource = (adapter: JournalAdapter, source: TranscriptSource): JournalAdapter => ({ ...adapter, source });

/** Everything a reader can observe of a store's view of a log. */
async function observe(store: TranscriptStore, adapter: JournalAdapter) {
  const page = await store.page(adapter, REF, ALL);
  return JSON.stringify({ page, facts: await store.facts(adapter, REF) });
}

/** Deterministic cut points, mid-line and mid-character included. */
function cuts(size: number, count: number, seed: number): number[] {
  const points = new Set<number>();
  let x = seed;
  while (points.size < count) {
    x = (x * 1103515245 + 12345) % 2147483648;
    points.add(1 + (x % (size - 1)));
  }
  return [...points].sort((a, b) => a - b);
}

async function compareSplits(adapter: JournalAdapter, bytes: Uint8Array) {
  const whole = memoryLog(bytes);
  const expected = await observe(new TranscriptStore(), withSource(adapter, whole.source));
  for (const seed of [1, 7, 42]) {
    const points = cuts(bytes.length, 25, seed);
    const log = memoryLog(bytes.slice(0, points[0]));
    const store = new TranscriptStore();
    const live = withSource(adapter, log.source);
    await observe(store, live);
    for (let i = 0; i < points.length; i++) {
      log.append(bytes.slice(points[i], points[i + 1] ?? bytes.length));
      await observe(store, live);
    }
    expect(await observe(store, live)).toBe(expected);
  }
  return JSON.parse(expected) as { page: { entries: unknown[] } };
}

describe("incremental journal reads match a whole read", () => {
  test("a real Claude log appended in arbitrary pieces", async () => {
    const bytes = new Uint8Array(await Bun.file(CLAUDE_LOG).arrayBuffer());
    const { page } = await compareSplits(claudeJournal("/nowhere"), bytes);
    expect(page.entries.length).toBeGreaterThan(20);
  });

  test("a real Codex rollout appended in arbitrary pieces", async () => {
    const bytes = new Uint8Array(await Bun.file(CODEX_LOG).arrayBuffer());
    const { page } = await compareSplits(codexJournal("/nowhere"), bytes);
    expect(page.entries.length).toBeGreaterThan(3);
  });

  test("crossing a (small) cap rebases to a newer tail window instead of re-parsing every append", async () => {
    // Across a rebase the window starts where the last rebase put it, not where a cold read would,
    // so the two differ at their head by design. What must hold: a tail of the same conversation,
    // newest entry included, and far fewer whole reads than appends.
    const bytes = new Uint8Array(await Bun.file(CLAUDE_LOG).arrayBuffer());
    const limits = { max: 40_000, headroom: 8_000 };
    const full = (await new TranscriptStore().page(withSource(claudeJournal("/nowhere"), memoryLog(bytes).source), REF, ALL))!;
    const points = cuts(bytes.length, 60, 3);
    const log = memoryLog(bytes.slice(0, points[0]));
    const store = new TranscriptStore(limits);
    const live = withSource(claudeJournal("/nowhere"), log.source);
    for (let i = 0; i < points.length; i++) {
      await store.page(live, REF, ALL);
      log.append(bytes.slice(points[i], points[i + 1] ?? bytes.length));
    }
    const page = (await store.page(live, REF, ALL))!;
    expect(page.fileTruncated).toBe(true);
    const order = full.entries.map((e) => e.uuid);
    // A result whose call fell before the window is kept as an orphan, the one entry a full read lacks.
    const kept = page.entries.filter((e) => !(e.parts.length === 1 && e.parts[0]!.kind === "tool" && e.parts[0]!.name === "result"));
    const seen = kept.map((e) => order.indexOf(e.uuid));
    expect(seen.every((at, i) => at >= 0 && (i === 0 || at > seen[i - 1]!))).toBe(true);
    expect(page.entries.at(-1)).toEqual(full.entries.at(-1)!);
    const wholeReads = log.reads.filter(([start, end]) => end - start > limits.headroom).length;
    expect(wholeReads).toBeLessThan(points.length / 3);
  });
});

describe("the incremental path reads only what changed", () => {
  const row = (uuid: string, text: string) =>
    JSON.stringify({ type: "user", uuid, timestamp: "2026-10-10T00:00:00Z", message: { role: "user", content: text } }) + "\n";

  test("an append reads the fingerprint plus the new bytes, and a partial line waits for its newline", async () => {
    const first = encode(row("u1", "hello"));
    const log = memoryLog(first);
    const store = new TranscriptStore();
    const adapter = withSource(claudeJournal("/nowhere"), log.source);
    expect((await store.page(adapter, REF, ALL))!.total).toBe(1);
    log.reads.length = 0;

    const second = encode(row("u2", "second"));
    log.append(second.slice(0, 10));
    expect((await store.page(adapter, REF, ALL))!.total).toBe(1);
    log.append(second.slice(10));
    expect((await store.page(adapter, REF, ALL))!.entries.map((e) => e.uuid)).toEqual(["u1", "u2"]);
    // Each append read starts at most a fingerprint before the resume point, never at 0.
    for (const [start] of log.reads) expect(start).toBeGreaterThanOrEqual(first.length - 256);
  });

  test("a shrink, a new inode or rewritten bytes before the resume point re-read the whole log", async () => {
    const log = memoryLog(encode(row("u1", "one") + row("u2", "two")));
    const store = new TranscriptStore();
    const adapter = withSource(claudeJournal("/nowhere"), log.source);
    await store.page(adapter, REF, ALL);

    log.replace(encode(row("x1", "shrunk")));
    expect((await store.page(adapter, REF, ALL))!.entries.map((e) => e.uuid)).toEqual(["x1"]);

    log.replace(encode(row("y1", "rotated") + row("y2", "under the same name")), 2);
    expect((await store.page(adapter, REF, ALL))!.entries.map((e) => e.uuid)).toEqual(["y1", "y2"]);

    // Same inode, longer, but not an append: the bytes before the resume point changed.
    log.replace(encode(row("z1", "rewritten-in-place") + row("z2", "longer than before") + row("z3", "!")));
    expect((await store.page(adapter, REF, ALL))!.entries.map((e) => e.uuid)).toEqual(["z1", "z2", "z3"]);
  });

  test("a compressed log fails closed, like an absent one", async () => {
    for (const magic of [[0x1f, 0x8b, 8, 0], [0x28, 0xb5, 0x2f, 0xfd]]) {
      const log = memoryLog(new Uint8Array([...magic, ...encode(row("u1", "hidden"))]));
      const adapter = withSource(codexJournal("/nowhere"), log.source);
      expect(await new TranscriptStore().page(adapter, REF, ALL)).toBeNull();
      expect(await new TranscriptStore().facts(adapter, REF)).toBeNull();
    }
  });
});

describe("journal images by entry and index", () => {
  const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
  const image = (data: string) => ({ type: "image", source: { type: "base64", media_type: "image/png", data } });

  test("history carries a byte-free marker and image() finds the bytes again", async () => {
    const lines = [
      { type: "user", uuid: "u1", timestamp: "t", message: { role: "user", content: [{ type: "text", text: "look" }, image(PNG)] } },
      { type: "assistant", uuid: "a1", timestamp: "t", message: { role: "assistant", content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "/x.png" } }] } },
      { type: "user", uuid: "t1", timestamp: "t", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "r1", content: [image("AAAA"), image(PNG)] }] } },
    ].map((l) => JSON.stringify(l) + "\n").join("");
    const log = memoryLog(encode(lines));
    const store = new TranscriptStore();
    const adapter = withSource(claudeJournal("/nowhere"), log.source);
    const page = (await store.page(adapter, REF, ALL))!;
    expect(JSON.stringify(page)).not.toContain(PNG);
    expect(page.entries[0]!.parts).toEqual([{ kind: "text", text: "look" }, { kind: "image", index: 0, mediaType: "image/png" }]);
    expect(page.entries[1]!.parts[0]).toMatchObject({ result: { attachments: [
      { kind: "image", index: 0, mediaType: "image/png" }, { kind: "image", index: 1, mediaType: "image/png" },
    ] } });

    const user = await store.image(adapter, REF, "u1", 0);
    expect(await user!.load()).toEqual({ mediaType: "image/png", data: PNG });
    const second = await store.image(adapter, REF, "a1", 1);
    expect(await second!.load()).toEqual({ mediaType: "image/png", data: PNG });
    expect(second!.key).not.toBe(user!.key);
    expect(await store.image(adapter, REF, "a1", 2)).toBeNull();
    expect(await store.image(adapter, REF, "missing", 0)).toBeNull();
  });
});
