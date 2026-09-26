import type { FileHandle } from "node:fs/promises";

export const MAX_VIDEO_BYTES = 256 * 1024 * 1024;
export async function videoResponse(
  file: FileHandle,
  size: number,
  range: string | null,
  filename: string,
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
  let position = start;
  let closed = false;
  const close = async () => {
    if (!closed) {
      closed = true;
      await file.close();
    }
  };
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const bytes = Buffer.alloc(Math.min(256 * 1024, end - position + 1));
        const read = await file.read(bytes, 0, bytes.length, position);
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
  return new Response(stream, {
    status: range ? 206 : 200,
    headers: {
      "content-type": mp4 ? "video/mp4" : "video/webm",
      "content-length": String(end - start + 1),
      "accept-ranges": "bytes",
      ...(range ? { "content-range": `bytes ${start}-${end}/${size}` } : {}),
      "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(filename).replace(/'/g, "%27")}`,
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
    },
  });
}
