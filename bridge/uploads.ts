import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { defaultStateDir } from "./config.ts";
import type { UploadResponse } from "./types.ts";

// Uploaded files (routes/files.ts → saveUpload → the first of `uploadDirs`) are referenced by path in
// a message and then never needed again, so nothing deletes them. This sweep prunes anything older
// than the TTL. The decision — which names are stale — is a pure, tested function; the runner that
// stats the dir and unlinks takes an injectable fs surface so it too can be exercised without disk.

/**
 * Where uploads go, first, then where older ones still wait to be previewed and swept. The agent is
 * handed the path, so with the default state dir they go to a Nenu folder beside it rather than under
 * Collie's name; a state dir the operator chose keeps its uploads inside it (ADR 0098).
 */
export function uploadDirs(stateDir: string, home: string = homedir()): readonly [string, ...string[]] {
  const inside = join(stateDir, "uploads");
  const fallback = defaultStateDir(home);
  return resolve(stateDir) === fallback ? [join(dirname(fallback), "nenu", "uploads"), inside] : [inside];
}

/** Nenu's own folders, its state and its uploads: never served, listed or opened (ADR 0074). */
export function nenuDirs(stateDir: string, home: string = homedir()): readonly string[] {
  return [stateDir, ...uploadDirs(stateDir, home)];
}

/** Uploads older than this are swept (Herdr already read them by path; they're single-use). */
export const UPLOAD_TTL_MS = 48 * 60 * 60 * 1000; // 48 h
/** How often the runner re-sweeps after the startup pass. */
export const SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 h

/**
 * How many leading bytes {@link imageExtFromBytes} needs. The longest signature we check is WebP's,
 * which is "RIFF" at 0 plus "WEBP" at 8 — twelve bytes.
 */
export const SNIFF_BYTES = 12;

/**
 * The upload allow-list, keyed by what the file IS rather than by what the client SAID it is.
 *
 * This used to be a lookup on the multipart part's Content-Type, which the client writes.
 * `IMAGE_EXT["__proto__"]` is Object.prototype and `IMAGE_EXT["constructor"]` is Object; both are
 * truthy, so both passed the check. Sniffing removes the lookup entirely.
 *
 * SVG is absent on purpose and must stay absent — it is script-bearing markup, not a raster image.
 */
const SIGNATURES: { ext: string; bytes: number[]; at: number }[] = [
  { ext: "png", at: 0, bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { ext: "jpg", at: 0, bytes: [0xff, 0xd8, 0xff] },
  { ext: "gif", at: 0, bytes: [0x47, 0x49, 0x46, 0x38] },
  { ext: "webp", at: 0, bytes: [0x52, 0x49, 0x46, 0x46] },
  { ext: "webp", at: 8, bytes: [0x57, 0x45, 0x42, 0x50] },
];

function matchesAt(head: Uint8Array, at: number, bytes: number[]): boolean {
  if (head.length < at + bytes.length) return false;
  return bytes.every((b, i) => head[at + i] === b);
}

/**
 * The file extension implied by a file's leading bytes, or null if they are not one of the four
 * image formats Nenu accepts. Pure — the whole decision, unit-tested.
 */
export function imageExtFromBytes(head: Uint8Array): string | null {
  for (const ext of ["png", "jpg", "gif", "webp"]) {
    const rows = SIGNATURES.filter((s) => s.ext === ext);
    // `every` on an empty list is true, which would type EVERY file as the first ext whose rows
    // someone deleted. No signature, no match.
    if (rows.length > 0 && rows.every((r) => matchesAt(head, r.at, r.bytes))) return ext;
  }
  return null;
}

/** One attached file, at most. The composer refuses a bigger one before it uploads (ADR 0074). */
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const TOO_LARGE = "File too large (max 25 MB).";

/** The extensions Claude Code attaches as images by name: only bytes that are an image may carry one. */
const IMAGE_NAME = /^(?:png|jpe?g|gif|webp)$/;

/**
 * The client's file name as a flat, portable tail for the generated name: its last path segment,
 * accents folded, every other character outside `[A-Za-z0-9._-]` as `_`, no dot runs and no
 * leading or trailing separator. The extension survives, lower-cased, so the agent can open it.
 */
function clientTail(name: string): string {
  const base = name.split(/[\\/]/).pop()!.normalize("NFKD").replace(/[\u0300-\u036f]/g, "");
  const dot = /\.([A-Za-z0-9]{1,10})$/.exec(base);
  const clean = (part: string) => part.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/\.{2,}/g, ".").replace(/^[._-]+|[._-]+$/g, "");
  const stem = clean(dot ? base.slice(0, dot.index) : base).slice(0, 64).replace(/[._-]+$/, "") || "file";
  const ext = dot?.[1]!.toLowerCase();
  if (!ext) return stem;
  // A file named like an image that is not one would be attached as an image by Claude.
  return IMAGE_NAME.test(ext) ? `${stem}.${ext}.bin` : `${stem}.${ext}`;
}

/**
 * Save one attached file under a name Nenu makes up, and return its path. Any kind is accepted;
 * the bytes are never read past the image sniff. An image is named by what its bytes are, in the
 * shape the chat preview accepts (chat-upload-preview.ts); anything else keeps its sanitized name
 * after the generated part, so no client name can choose a path, a dot segment or a device name.
 */
export async function saveUpload(stateDir: string, paneId: string, file: File, home: string = homedir()): Promise<UploadResponse> {
  if (file.size > MAX_UPLOAD_BYTES) return { ok: false, error: TOO_LARGE };
  const dir = uploadDirs(stateDir, home)[0];
  const ext = imageExtFromBytes(new Uint8Array(await file.slice(0, SNIFF_BYTES).arrayBuffer()));
  // 0700 — uploads may hold sensitive files; keep them
  // owner-only. recursive:true applies the mode to any intermediate dirs it creates too.
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const generated = `${paneId.replace(/[^A-Za-z0-9_-]/g, "_")}-${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const path = join(dir, ext ? `${generated}.${ext}` : `${generated}-${clientTail(file.name ?? "")}`);
  await Bun.write(path, file);
  return { ok: true, path };
}

/** Names whose mtime is older than `ttlMs` before `now`. Pure — the whole decision, unit-tested. */
export function filesToPrune(
  entries: { name: string; mtimeMs: number }[],
  now: number,
  ttlMs: number,
): string[] {
  return entries.filter((e) => now - e.mtimeMs > ttlMs).map((e) => e.name);
}

/** The slice of node:fs the sweep needs — injectable so the runner is testable with a fake. */
export interface UploadFs {
  readdir(dir: string): Promise<string[]>;
  stat(path: string): Promise<{ mtimeMs: number }>;
  unlink(path: string): Promise<void>;
}

const realFs: UploadFs = { readdir, stat: (p) => stat(p), unlink };

/**
 * Stat `dir`, prune every file past the TTL, and return the names actually removed. Best-effort
 * throughout: a missing uploads dir (nothing uploaded yet) is not an error, and a file that vanishes
 * between readdir and stat/unlink (or a stat/unlink that fails) is skipped rather than aborting the
 * sweep. `now` and `fs` are injected for tests; the bridge calls it with the defaults.
 */
export async function sweepUploads(
  dir: string,
  ttlMs: number = UPLOAD_TTL_MS,
  now: number = Date.now(),
  fs: UploadFs = realFs,
): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return []; // uploads dir doesn't exist yet — nothing to sweep
  }
  const entries: { name: string; mtimeMs: number }[] = [];
  for (const name of names) {
    try {
      const s = await fs.stat(join(dir, name));
      entries.push({ name, mtimeMs: s.mtimeMs });
    } catch {
      /* vanished between readdir and stat — skip */
    }
  }
  const removed: string[] = [];
  for (const name of filesToPrune(entries, now, ttlMs)) {
    try {
      await fs.unlink(join(dir, name));
      removed.push(name);
    } catch {
      /* already gone / unlink failed — skip */
    }
  }
  return removed;
}

/** {@link sweepUploads} over every folder uploads live in, one after another. */
export async function sweepUploadDirs(
  dirs: readonly string[],
  ttlMs: number = UPLOAD_TTL_MS,
  now: number = Date.now(),
  fs: UploadFs = realFs,
): Promise<string[]> {
  const removed: string[] = [];
  for (const dir of dirs) removed.push(...await sweepUploads(dir, ttlMs, now, fs));
  return removed;
}
