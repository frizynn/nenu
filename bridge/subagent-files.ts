import { open } from "node:fs/promises";
import { constants } from "node:fs";

/** Bounded tail cache. Growing logs only read newly appended bytes; rotations invalidate it. */
export class SubagentFiles {
  private cache = new Map<string, { size: number; mtime: number; ino: number; bytes: Buffer }>();
  async tail(path: string, cap = 256 * 1024): Promise<{ text: string; truncated: boolean; updatedAt: string }> {
    const readCap = cap + 1;
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const st = await file.stat();
      if (!st.isFile()) throw new Error("Not a transcript file.");
      const key = `${cap}:${path}`;
      const old = this.cache.get(key);
      let bytes: Buffer;
      if (old && old.ino === st.ino && old.size === st.size && old.mtime === st.mtimeMs) bytes = old.bytes;
      else {
        const append = old && old.ino === st.ino && st.size > old.size && st.size - old.size < readCap;
        const start = append ? old.size : Math.max(0, st.size - readCap);
        const added = Buffer.alloc(st.size - start);
        const { bytesRead } = await file.read(added, 0, added.length, start);
        bytes = append ? Buffer.concat([old.bytes, added.subarray(0, bytesRead)]) : added.subarray(0, bytesRead);
        bytes = bytes.subarray(Math.max(0, bytes.length - readCap));
        if (this.cache.size >= 128 && !this.cache.has(key)) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { size: st.size, mtime: st.mtimeMs, ino: st.ino, bytes });
      }
      const truncated = st.size > cap;
      const text = bytes.toString("utf8");
      return { text: truncated ? text.slice(text.indexOf("\n") + 1) : text, truncated, updatedAt: st.mtime.toISOString() };
    } finally { await file.close(); }
  }
}

export function jsonRows(text: string): Record<string, unknown>[] {
  return text.split("\n").flatMap((line) => {
    try { const row: unknown = JSON.parse(line); return row && typeof row === "object" && !Array.isArray(row) ? [row as Record<string, unknown>] : []; }
    catch { return []; }
  });
}
export const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export const shortText = (v: unknown, cap = 160): string => typeof v === "string" ? v.slice(0, cap) : "";
export const isAgentId = (id: string): boolean => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(id);
