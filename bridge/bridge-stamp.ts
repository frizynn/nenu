import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * How long after a file's mtime its metadata is trusted to move with its content. ext4 stamps writes
 * from a coarse clock: two writes in a row read back the same mtime and ctime (measured), so a
 * same-size edit right after a hash would keep the old one. Like git's "racy" index entries, a file
 * hashed within this window of its mtime is hashed again on the next read.
 */
const RACY_NS = 1_000_000_000n;

/** Content, not checkout timestamps, determines whether loaded code needs a restart. Metadata
 * only invalidates each file's cached hash, keeping the snapshot's throttled scan inexpensive. */
export function createBridgeStampReader(bridgeDir: string, rootDir: string): () => string {
  const cache = new Map<string, { metadata: string; digest: string; settled: boolean }>();
  return () => {
    const entries: [string, string][] = [];
    const seen = new Set<string>();
    const add = (path: string) => {
      seen.add(path);
      try {
        const stat = statSync(path, { bigint: true });
        const metadata = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
        let cached = cache.get(path);
        if (cached?.metadata !== metadata || !cached.settled) {
          const hashedAt = BigInt(Date.now()) * 1_000_000n;
          cached = { metadata, digest: createHash("sha256").update(readFileSync(path)).digest("hex"), settled: stat.mtimeNs + RACY_NS < hashedAt };
          cache.set(path, cached);
        }
        entries.push([relative(rootDir, path), cached.digest]);
      } catch {
        cache.delete(path);
        entries.push([relative(rootDir, path), "unavailable"]);
      }
    };
    const walk = (dir: string) => {
      try {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) walk(path);
          else if (entry.name.endsWith(".ts") && !/\.(?:test|spec|d)\.ts$/.test(entry.name)) add(path);
        }
      } catch {
        entries.push([relative(rootDir, dir), "unavailable-directory"]);
      }
    };
    walk(bridgeDir);
    add(join(rootDir, "package.json"));
    add(join(rootDir, "bun.lock"));
    for (const path of cache.keys()) if (!seen.has(path)) cache.delete(path);
    entries.sort(([a], [b]) => a.localeCompare(b));
    return createHash("sha256").update(JSON.stringify(entries)).digest("hex");
  };
}
