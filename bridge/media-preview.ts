import type { Stats } from "node:fs";
import type { FileHandle } from "node:fs/promises";

export const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

/** Headers every served file carries: raw bytes are never a document in the app's security context. */
export const FILE_SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
} as const;

/** Bytes may be reused only after the bridge re-runs its containment checks and the ETag still matches. */
export const REVALIDATE = "private, no-cache";

/** Identity of the bytes on disk: inode, size and mtime change whenever the file is replaced or rewritten. */
export function fileEtag(stat: Stats): string {
  return `"${stat.ino.toString(36)}-${stat.size.toString(36)}-${stat.mtimeMs.toString(36)}"`;
}

/** RFC 9110 weak comparison over an If-None-Match list. */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  return ifNoneMatch.split(",").some((tag) => {
    const value = tag.trim();
    return value === "*" || value.replace(/^W\//, "") === etag;
  });
}

export function notModifiedResponse(etag: string): Response {
  return new Response(null, { status: 304, headers: { etag, "cache-control": REVALIDATE, ...FILE_SECURITY_HEADERS } });
}

export function inlineDisposition(filename: string): string {
  return `inline; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, "%27")}`;
}

/**
 * Stream bytes [start, end] of an open file in bounded chunks, so a large image or video never
 * sits whole in the bridge's memory. The stream owns the handle and closes it on end, error or cancel.
 */
export function fileStream(file: FileHandle, start: number, end: number): ReadableStream<Uint8Array> {
  let position = start;
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await file.close();
    }
  };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const bytes = Buffer.alloc(Math.min(CHUNK_BYTES, end - position + 1));
        const read = bytes.length ? await file.read(bytes, 0, bytes.length, position) : { bytesRead: 0 };
        if (!read.bytesRead) {
          controller.close();
          await close();
          return;
        }
        position += read.bytesRead;
        controller.enqueue(bytes.subarray(0, read.bytesRead));
        if (position > end) {
          controller.close();
          await close();
        }
      } catch (error) {
        controller.error(error);
        await close();
      }
    },
    cancel: close,
  });
}

export async function videoResponse(
  file: FileHandle,
  size: number,
  range: string | null,
  filename: string,
  etag: string,
): Promise<Response> {
  const head = Buffer.alloc(Math.min(64, size));
  await file.read(head, 0, head.length, 0);
  const mp4 = head.subarray(4, 8).toString() === "ftyp";
  const webm =
    head.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])) &&
    head.includes(Buffer.from("webm"));
  if (!mp4 && !webm) {
    await file.close();
    return new Response("Unsupported video content.", { status: 415 });
  }
  let start = 0,
    end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2])) {
      await file.close();
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${size}` },
      });
    }
    start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
    end =
      match[1] && match[2] ? Math.min(size - 1, Number(match[2])) : size - 1;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start > end ||
      start >= size
    ) {
      await file.close();
      return new Response(null, {
        status: 416,
        headers: { "content-range": `bytes */${size}` },
      });
    }
  }
  return new Response(fileStream(file, start, end), {
    status: range ? 206 : 200,
    headers: {
      "content-type": mp4 ? "video/mp4" : "video/webm",
      "content-length": String(end - start + 1),
      "accept-ranges": "bytes",
      ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
      "content-disposition": inlineDisposition(filename),
      etag,
      "cache-control": REVALIDATE,
      ...FILE_SECURITY_HEADERS,
    },
  });
}
