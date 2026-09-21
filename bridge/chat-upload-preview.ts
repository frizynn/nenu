import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { TranscriptEntry } from "./journal/types.ts";
import { containedRealpath } from "./journal/files.ts";
import { imageExtFromBytes } from "./uploads.ts";

const MAX_BYTES = 10 * 1024 * 1024;
const UPLOAD_NAME = /^[A-Za-z0-9_-]+-[a-z0-9]+-[a-f0-9]{8}\.(?:png|jpg|gif|webp)$/;

/** Only Nenu's generated upload filenames, directly in its configured upload directory. */
export function isChatUploadPath(stateDir: string, path: string | null): path is string {
  return !!path && path.length <= 4096 && isAbsolute(path) &&
    !/[\x00-\x1f]/.test(path) && path === resolve(path) &&
    dirname(path) === resolve(stateDir, "uploads") && UPLOAD_NAME.test(basename(path));
}

function referencedByUser(entries: readonly TranscriptEntry[], path: string): boolean {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const reference = new RegExp(`(?:^|[\\s\\[('"\x60<])${escaped}(?=$|[\\s\\])'"\x60>]|[.,](?=\\s|$))`);
  return entries.some((entry) => entry.role === "user" && entry.parts.some((part) =>
    part.kind === "text" && reference.test(part.text)));
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
): Promise<Response> {
  const unavailable = () => new Response("Photo unavailable in this conversation.", {
    status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
  });
  if (!isChatUploadPath(stateDir, path) || !referencedByUser(entries, path)) return unavailable();
  const root = await realpath(join(stateDir, "uploads")).catch(() => null);
  if (!root) return unavailable();
  const resolved = await containedRealpath(path, root);
  // A generated upload is a direct file, never a link to another upload or directory.
  if (!resolved || resolved !== join(root, basename(path))) return unavailable();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return unavailable();
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES || await containedRealpath(path, root) !== resolved) return unavailable();
    const bytes = Buffer.alloc(stat.size);
    let length = 0;
    while (length < bytes.length) {
      const result = await handle.read(bytes, length, bytes.length - length, length);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    const content = bytes.subarray(0, length);
    const ext = imageExtFromBytes(content);
    if (!ext) return unavailable();
    return new Response(content, { headers: {
      "content-type": ext === "jpg" ? "image/jpeg" : `image/${ext}`,
      "content-length": String(length),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "content-disposition": `inline; filename="${basename(path)}"`,
    } });
  } catch {
    return unavailable();
  } finally {
    await handle.close();
  }
}
