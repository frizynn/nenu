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
