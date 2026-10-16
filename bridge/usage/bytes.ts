// Field extraction straight from a log's bytes. A usage scan touches hundreds of thousands of rows;
// decoding each row into a string and an object is what grew a scan to ~170 MB (measured: the same
// loop without decoding stays at 34 MB), so the hot path reads numbers and hashes ids in place and
// allocates only when a model name or a day changes.

const QUOTE = 0x22, BACKSLASH = 0x5c, COLON = 0x3a, OPEN = 0x7b, CLOSE = 0x7d, LIST = 0x5b, END_LIST = 0x5d;

/** Index of the `}` that closes the object opened at `open`, or -1 if `to` comes first. */
export function objectEnd(b: Uint8Array, open: number, to: number): number {
  let depth = 0;
  let inString = false;
  for (let i = open; i < to; i++) {
    const c = b[i]!;
    if (inString) {
      if (c === BACKSLASH) i++;
      else if (c === QUOTE) inString = false;
    } else if (c === QUOTE) inString = true;
    else if (c === OPEN || c === LIST) depth++;
    else if ((c === CLOSE || c === END_LIST) && --depth === 0) return i;
  }
  return -1;
}

/** A non-negative integer starting at `at`, or 0 when there is none (JSON `null`, a string…). */
export function uintAt(b: Uint8Array, at: number): number {
  let n = 0;
  for (let i = at; ; i++) {
    const c = b[i]! - 48;
    if (c < 0 || c > 9 || i >= b.length) return n;
    n = n * 10 + c;
  }
}

/** End (exclusive) of the JSON string whose first character is at `from`, honouring escapes. */
export function stringEnd(b: Uint8Array, from: number, to: number): number {
  for (let i = from; i < to; i++) {
    const c = b[i]!;
    if (c === BACKSLASH) i++;
    else if (c === QUOTE) return i;
  }
  return -1;
}

/** Whether `b[at…]` spells `key`. */
export function bytesEqual(b: Uint8Array, at: number, key: Uint8Array): boolean {
  if (at < 0 || at + key.length > b.length) return false;
  for (let i = 0; i < key.length; i++) if (b[at + i] !== key[i]) return false;
  return true;
}

/**
 * The value of each `keys[k]` found directly inside the object spanning `[open, close]`, as the byte
 * index where its value starts (-1 when absent). Keys of nested objects are not matched, so a field
 * that also appears deeper (`usage.iterations[].input_tokens`) cannot be mistaken for the top one.
 */
export function topLevelFields(b: Uint8Array, open: number, close: number, keys: readonly Uint8Array[], out: Int32Array): void {
  out.fill(-1);
  let depth = 0;
  for (let i = open; i <= close; i++) {
    const c = b[i]!;
    if (c === QUOTE) {
      const end = stringEnd(b, i + 1, close);
      if (end < 0) return;
      // A string at depth 1 followed by a colon is a key of this object.
      if (depth === 1 && b[end + 1] === COLON) {
        const len = end - i - 1;
        for (let k = 0; k < keys.length; k++) {
          if (out[k]! < 0 && keys[k]!.length === len && bytesEqual(b, i + 1, keys[k]!)) out[k] = end + 2;
        }
      }
      i = end;
    } else if (c === OPEN || c === LIST) depth++;
    else if (c === CLOSE || c === END_LIST) depth--;
  }
}

/** FNV-1a over byte ranges, two 32-bit lanes folded into a 52-bit integer that a double holds exactly. */
export function hashRanges(b: Uint8Array, a0: number, a1: number, c0: number, c1: number): number {
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = a0; i < a1; i++) { const x = b[i]!; h1 = Math.imul(h1 ^ x, 16777619) >>> 0; h2 = Math.imul(h2 ^ x, 2246822519) >>> 0; }
  for (let i = c0; i < c1; i++) { const x = b[i]!; h1 = Math.imul(h1 ^ x, 16777619) >>> 0; h2 = Math.imul(h2 ^ x, 2246822519) >>> 0; }
  return (h2 & 0xfffff) * 4294967296 + h1;
}

/** Epoch ms of an ISO-8601 UTC timestamp (`2026-10-16T12:34:56.789Z`) at `at`, or NaN. */
export function isoMsAt(b: Uint8Array, at: number): number {
  const d = (i: number, n: number) => {
    let v = 0;
    for (let k = 0; k < n; k++) { const c = b[at + i + k]! - 48; if (c < 0 || c > 9) return NaN; v = v * 10 + c; }
    return v;
  };
  if (b[at + 4] !== 0x2d || b[at + 10] !== 0x54) return NaN;
  const ms = b[at + 19] === 0x2e ? d(20, 3) : 0;
  return Date.UTC(d(0, 4), d(5, 2) - 1, d(8, 2), d(11, 2), d(14, 2), d(17, 2), ms);
}

const decoder = new TextDecoder();
/** The only allocating read: used for names that repeat (models, cwds), which callers intern. */
export function text(b: Uint8Array, from: number, to: number): string {
  return decoder.decode(b.subarray(from, to));
}
