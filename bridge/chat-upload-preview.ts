import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { TranscriptEntry } from "./journal/types.ts";
import { containedRealpath } from "./journal/files.ts";
import {
  etagMatches, fileEtag, fileStream, FILE_SECURITY_HEADERS, notModifiedResponse, REVALIDATE,
} from "./media-preview.ts";
import { imageExtFromBytes, SNIFF_BYTES } from "./uploads.ts";

const MAX_BYTES = 10 * 1024 * 1024;
const UPLOAD_NAME_SOURCE = "[A-Za-z0-9_-]+-[a-z0-9]+-[a-f0-9]{8}\\.(?:png|jpg|gif|webp)";
const UPLOAD_NAME = new RegExp(`^${UPLOAD_NAME_SOURCE}$`);

/** Only Nenu's generated upload filenames, directly in its configured upload directory. */
export function isChatUploadPath(stateDir: string, path: string | null): path is string {
  return !!path && path.length <= 4096 && isAbsolute(path) &&
    !/[\x00-\x1f]/.test(path) && path === resolve(path) &&
    dirname(path) === resolve(stateDir, "uploads") && UPLOAD_NAME.test(basename(path));
}

const referencedCache = new WeakMap<readonly TranscriptEntry[], { dir: string; paths: Set<string> }>();

/**
 * Every generated upload path a user message names as a whole token. The set is memoized per
 * parsed journal window, so a message with several photos scans the journal once, not per photo.
 */
function referencedUploads(entries: readonly TranscriptEntry[], stateDir: string): Set<string> {
  const dir = resolve(stateDir, "uploads");
  const cached = referencedCache.get(entries);
  if (cached?.dir === dir) return cached.paths;
  const escaped = dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reference = new RegExp(
    `(?:^|[\\s\\[('"\x60<])(${escaped}/${UPLOAD_NAME_SOURCE})(?=$|[\\s\\])'"\x60>]|[.,](?=\\s|$))`, "g");
  const paths = new Set<string>();
  for (const entry of entries) {
    if (entry.role !== "user") continue;
    for (const part of entry.parts) {
      if (part.kind === "text") for (const match of part.text.matchAll(reference)) paths.add(match[1]!);
    }
  }
  referencedCache.set(entries, { dir, paths });
  return paths;
}

/**
 * Uploads live outside the workspace. A contained journal for the CURRENT pane must prove the
 * user shared this exact generated path before it can be previewed. This is not host-file access
 * and does not alter project-file containment or the upload retention policy.
 */
export async function chatUploadPreviewResponse(
  stateDir: string,
  path: string,
  entries: readonly TranscriptEntry[],
  ifNoneMatch: string | null = null,
): Promise<Response> {
  const unavailable = () => new Response("Photo unavailable in this conversation.", {
    status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
  if (!isChatUploadPath(stateDir, path) || !referencedUploads(entries, stateDir).has(path)) return unavailable();
  const root = await realpath(join(stateDir, "uploads")).catch(() => null);
  if (!root) return unavailable();
  const resolved = await containedRealpath(path, root);
  // A generated upload is a direct file, never a link to another upload or directory.
  if (!resolved || resolved !== join(root, basename(path))) return unavailable();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return unavailable();
  let streaming = false;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES || await containedRealpath(path, root) !== resolved) return unavailable();
    const etag = fileEtag(stat);
    if (etagMatches(ifNoneMatch, etag)) return notModifiedResponse(etag);
    const head = Buffer.alloc(Math.min(SNIFF_BYTES, stat.size));
    await handle.read(head, 0, head.length, 0);
    const ext = imageExtFromBytes(head);
    if (!ext) return unavailable();
    streaming = true;
    return new Response(fileStream(handle, 0, stat.size - 1), { headers: {
      "content-type": ext === "jpg" ? "image/jpeg" : `image/${ext}`,
      "content-length": String(stat.size),
      etag,
      "cache-control": REVALIDATE,
      ...FILE_SECURITY_HEADERS,
      "content-disposition": `inline; filename="${basename(path)}"`,
    } });
  } catch {
    return unavailable();
  } finally {
    if (!streaming) await handle.close();
  }
}
