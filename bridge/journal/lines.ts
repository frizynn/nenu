import { constants } from "node:fs";
import { open } from "node:fs/promises";

// Line framing shared by the store and the adapters' pure `parse(text)`. Both hand a parser the same
// thing — one complete line plus where its bytes sit in the file — so an incremental read and a whole
// re-read cannot frame a log differently.

const decoder = new TextDecoder();

export type LineSink = (text: string, offset: number, bytes: number) => void;

/**
 * Feed every newline-terminated line of `bytes`, which start at file offset `base`, and return how
 * many bytes that consumed. A trailing line with no newline yet is a write still in flight: it is left
 * for the next read, which resumes at the returned position.
 */
export function feedLines(bytes: Uint8Array, base: number, sink: LineSink): number {
  let start = 0;
  for (;;) {
    const nl = bytes.indexOf(10, start);
    if (nl === -1) return start;
    if (nl > start) sink(decoder.decode(bytes.subarray(start, nl)), base + start, nl - start);
    start = nl + 1;
  }
}

/** The text twin of {@link feedLines}, for `parse(text)`: offsets are the UTF-8 bytes `text` would be. */
export function feedText(text: string, sink: LineSink): void {
  let offset = 0;
  for (const line of text.split("\n")) {
    const bytes = Buffer.byteLength(line);
    if (line !== "") sink(line, offset, bytes);
    offset += bytes + 1;
  }
}

export interface TailState { ino: number; offset: number; rest: Buffer }

/**
 * Complete lines appended to `path` since `prev`, framed by {@link feedLines}. The first read (or one
 * after the file was replaced or shrank, `reset`) starts at most `cap` bytes from the end and drops
 * the partial line there. A burst larger than `cap` is treated like a reset, so memory stays bounded.
 * The caller keeps the returned `tail` with whatever it folded the lines into, so the two can never
 * be evicted apart.
 */
export async function readAppended(path: string, cap: number, prev?: TailState): Promise<{ lines: string[]; reset: boolean; truncated: boolean; mtime: number; tail: TailState }> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await file.stat();
    if (!st.isFile()) throw new Error("not a file");
    const reset = !prev || prev.ino !== st.ino || st.size < prev.offset || st.size - prev.offset > cap;
    const start = reset ? Math.max(0, st.size - cap) : prev.offset;
    const fresh = Buffer.alloc(st.size - start);
    const { bytesRead } = await file.read(fresh, 0, fresh.length, start);
    let bytes = fresh.subarray(0, bytesRead);
    if (reset && start > 0) bytes = bytes.subarray(bytes.indexOf(0x0a) + 1);
    else if (!reset) bytes = Buffer.concat([prev.rest, bytes]);
    const lines: string[] = [];
    const end = feedLines(bytes, 0, (text) => void lines.push(text));
    const tail = { ino: st.ino, offset: start + bytesRead, rest: Buffer.from(bytes.subarray(end)) };
    return { lines, reset, truncated: reset && start > 0, mtime: st.mtimeMs, tail };
  } finally { await file.close(); }
}
