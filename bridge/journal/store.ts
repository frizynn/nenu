// Reads + caches parsed journals, for whichever adapter the pane's agent selects.
//
// History is fetched ON DEMAND (it is not on the 1.5 s poll path), so the cost that matters is the
// repeat visit, not the first — a parse is reused until the log's size or mtime moves. The cache is
// keyed by absolute path, which is why one store can serve every agent and every herdr session at
// once: two sessions fronting panes whose agents write into the same root still hit the same entry.

import { isCompressed, MAX_TRANSCRIPT_BYTES, TAIL_HEADROOM_BYTES, UnreadableJournal } from "./files.ts";
import { feedLines } from "./lines.ts";
import type {
  AgentSessionRef,
  JournalAdapter,
  JournalFacts,
  JournalParser,
  SessionTelemetry,
  TranscriptEntry,
  TranscriptPage,
  TranscriptSource,
} from "./types.ts";

/** How many parsed journals to keep hot. Each is re-parsed only when its file's size/mtime moves. */
const CACHE_MAX = 4;

/**
 * Bytes just before the resume point that an append read re-reads and compares. A log rewritten in
 * place under the same inode (a truncate-and-write) almost never reproduces them, so it is caught
 * there and re-read whole instead of being appended to a parse of different content.
 */
const FINGERPRINT_BYTES = 256;

type Meta = { size: number; mtimeMs: number; ino?: number };

/** Where an incremental parse stands in its file. */
interface Tail {
  parser: JournalParser;
  /** File offset the parsed window starts at; 0 unless the log is over the cap. */
  start: number;
  /** File offset just past the last complete line fed. */
  offset: number;
  fingerprint: Uint8Array;
}

interface CacheEntry extends Meta {
  complete: boolean;
  entries: TranscriptEntry[];
  telemetry?: SessionTelemetry;
  facts: JournalFacts;
  tail?: Tail;
  pages: Map<string, Omit<TranscriptPage, "paneId">>;
}

const NO_FACTS: JournalFacts = { queue: [] };

/**
 * Page a parsed journal, newest-anchored: with no cursor you get the LAST `limit` turns (the phone
 * opens at the recent end, like the mirror it replaces); `before` walks backwards from a turn you
 * already hold. Returned entries stay oldest-first so the view renders top-down either way.
 */
export function pageEntries(
  entries: TranscriptEntry[],
  opts: { limit: number; before?: string },
): { window: TranscriptEntry[]; hasMore: boolean } {
  // An unknown cursor (log rewritten under us, a stale client, or a synthesised cursor whose row
  // fell out of the window) degrades to "newest", never to an empty page — the user asked for older
  // history and must still see something.
  const end =
    opts.before === undefined
      ? entries.length
      : (() => {
          const i = entries.findIndex((e) => e.uuid === opts.before);
          return i === -1 ? entries.length : i;
        })();
  const start = Math.max(0, end - opts.limit);
  return { window: entries.slice(start, end), hasMore: start > 0 };
}

/** The byte cap and the headroom below it (files.ts); injectable so tests can cross a small cap. */
export interface TailLimits {
  max: number;
  headroom: number;
}

export class TranscriptStore {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly loading = new Map<string, Promise<CacheEntry | null>>();

  constructor(private readonly limits: TailLimits = { max: MAX_TRANSCRIPT_BYTES, headroom: TAIL_HEADROOM_BYTES }) {}

  /**
   * Read one page of a pane's journal.
   *
   * Null means "nothing to serve" for every reason the client is allowed to distinguish: the ref
   * names no file, the adapter refused the ref's shape, the path failed containment, or the log is
   * not JSONL. Those stay indistinguishable on purpose — a containment failure must not be probeable.
   */
  async page(
    adapter: JournalAdapter,
    ref: AgentSessionRef,
    opts: { limit: number; before?: string },
  ): Promise<Omit<TranscriptPage, "paneId"> | null> {
    const entry = await this.current(adapter, ref);
    if (entry === null) return null;
    const key = JSON.stringify([opts.limit, opts.before ?? null]);
    const cachedPage = entry.pages.get(key);
    if (cachedPage) return cachedPage;
    const { entries, complete } = entry;

    const { window, hasMore } = pageEntries(entries, opts);
    const page = {
      entries: window,
      // A clipped file always has more behind it, even at the window's start.
      hasMore: hasMore || (!complete && window.length > 0 && window[0] === entries[0]),
      total: entries.length,
      fileTruncated: !complete,
      ...(entry.telemetry ? { telemetry: entry.telemetry } : {}),
    };
    entry.pages.set(key, page);
    if (entry.pages.size > 8) entry.pages.delete(entry.pages.keys().next().value!);
    return page;
  }

  /**
   * What the journal says beside the conversation: the session's title, the CLI's own queue
   * operations, a question still waiting for its answer. Same contained, cached read as {@link page}.
   */
  async facts(adapter: JournalAdapter, ref: AgentSessionRef): Promise<JournalFacts | null> {
    return (await this.current(adapter, ref))?.facts ?? null;
  }

  /**
   * One inline image of an entry, by the entry's uuid and the image's index — never by path. `key`
   * names the exact bytes (inode, row position, image), so a caller can answer a validator before
   * `load` decodes anything; `load` re-reads only that row of the already-contained log.
   */
  async image(
    adapter: JournalAdapter,
    ref: AgentSessionRef,
    entryUuid: string,
    index: number,
  ): Promise<{ key: string; load(): Promise<{ data: string; mediaType?: string } | null> } | null> {
    const path = await adapter.source.resolve(ref);
    const entry = path === null ? null : await this.current(adapter, ref, path);
    const read = adapter.source.read?.bind(adapter.source);
    const rowImages = adapter.rowImages;
    const locator = entry?.tail?.parser.images(entryUuid)[index];
    if (path === null || !entry || !read || !rowImages || !locator) return null;
    return {
      key: `${entry.ino ?? 0}:${locator.offset}:${locator.bytes}:${locator.nth}`,
      async load() {
        try {
          const row: unknown = JSON.parse(new TextDecoder().decode(await read(path, locator.offset, locator.offset + locator.bytes)));
          return rowImages(row)[locator.nth] ?? null;
        } catch {
          return null; // the log changed under us since it was indexed
        }
      },
    };
  }

  /** The cache entry for the log `ref` names, refreshed only when a stat says it moved. */
  private async current(adapter: JournalAdapter, ref: AgentSessionRef, resolved?: string): Promise<CacheEntry | null> {
    const path = resolved ?? await adapter.source.resolve(ref);
    if (path === null) return null;

    // Cache check BEFORE the read: a journal can be 32 MB and paging walks the same file repeatedly,
    // so validity is decided by a stat. Only a moved size/mtime costs a read + parse.
    const meta = await adapter.source.stat(path);
    if (meta === null) return null; // vanished between resolve and read
    const cached = this.cache.get(path);
    if (cached && cached.size === meta.size && cached.mtimeMs === meta.mtimeMs && cached.ino === meta.ino) {
      // Re-set to move it to the end: eviction below is insertion-ordered, so touching a hit keeps
      // the hot journal from being evicted underneath a colder one.
      this.cache.delete(path);
      this.cache.set(path, cached);
      return cached;
    }
    // Multiple phones can request the same changed log before its first read settles.
    let pending = this.loading.get(path);
    if (!pending) {
      pending = this.load(adapter, path, meta, cached).finally(() => this.loading.delete(path));
      this.loading.set(path, pending);
    }
    return pending;
  }

  private async load(adapter: JournalAdapter, path: string, meta: Meta, cached: CacheEntry | undefined): Promise<CacheEntry | null> {
    let entry: CacheEntry;
    try {
      const { source } = adapter;
      if (adapter.parser && source.read) {
        const tail = (cached?.tail && await extend(source, path, meta, cached, this.limits))
          || await reread(adapter.parser(), source, path, meta, this.limits);
        const usage = tail.parser.usage();
        const complete = tail.start === 0;
        entry = {
          ...meta, complete, tail, entries: tail.parser.entries(), facts: tail.parser.facts(), pages: new Map(),
          ...(usage ? { telemetry: { ...usage, fileTruncated: !complete } } : {}),
        };
      } else {
        const { text, complete, size, mtimeMs } = await source.load(path);
        const usage = adapter.parseUsage?.(text);
        entry = {
          size, mtimeMs, ino: meta.ino, complete, entries: adapter.parse(text), facts: NO_FACTS, pages: new Map(),
          ...(usage ? { telemetry: { ...usage, fileTruncated: !complete } } : {}),
        };
      }
    } catch (err) {
      if (err instanceof UnreadableJournal) return null;
      throw err;
    }
    this.cache.delete(path);
    this.cache.set(path, entry);
    if (this.cache.size > CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
    return entry;
  }
}

/**
 * Parse a log's window from scratch. Over the cap the window starts the headroom below it, so the appends that follow extend this parse rather than each forcing a new one.
 */
async function reread(parser: JournalParser, source: TranscriptSource, path: string, meta: Meta, limits: TailLimits): Promise<Tail> {
  const read = source.read!.bind(source);
  if (isCompressed(await read(path, 0, 4))) throw new UnreadableJournal(path);
  const start = Math.max(0, meta.size - limits.max);
  const bytes = await read(path, start, meta.size);
  const consumed = feedLines(bytes, start, (line, offset, n) => parser.line(line, offset, n));
  // A copy, so the window's buffer is not kept alive by its last few bytes.
  return { parser, start, offset: start + consumed, fingerprint: bytes.slice(Math.max(0, consumed - FINGERPRINT_BYTES), consumed) };
}

/**
 * Feed only what was appended since the last read, or null when the change is not a plain append:
 * another file under the name (inode), a shrink or same-size rewrite, different bytes before the
 * resume point, or a window that would outgrow the cap by more than the headroom. Each of those is
 * re-read whole.
 */
async function extend(source: TranscriptSource, path: string, meta: Meta, cached: CacheEntry, limits: TailLimits): Promise<Tail | null> {
  const tail = cached.tail!;
  if (meta.ino !== cached.ino || meta.size <= cached.size || meta.size - tail.start > limits.max + limits.headroom) return null;
  const from = tail.offset - tail.fingerprint.length;
  const bytes = await source.read!(path, from, meta.size);
  const seen = bytes.subarray(0, tail.fingerprint.length);
  if (seen.length !== tail.fingerprint.length || seen.some((byte, i) => byte !== tail.fingerprint[i])) return null;
  const fresh = bytes.subarray(tail.fingerprint.length);
  const consumed = feedLines(fresh, tail.offset, (line, offset, n) => tail.parser.line(line, offset, n));
  const end = tail.fingerprint.length + consumed;
  return { ...tail, offset: tail.offset + consumed, fingerprint: bytes.slice(Math.max(0, end - FINGERPRINT_BYTES), end) };
}
