import { lstat, realpath } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";

import { renderedHtmlResponse } from "./html-preview.ts";
import { containedRealpath } from "./journal/files.ts";
import { paneFileResponse } from "./pane-files.ts";

// A project's library (`<project>/library/<thread id>/`) is where Organizations copies the pictures
// and documents each thread produced, without symbolic links. The Summary view shows them, so the
// bridge serves files from it, and only from it: a path is served when its real path is inside the
// real library folder, which must itself be a folder and not a link, and when its kind is a picture,
// HTML or a PDF. Everything else is the same 404, so a probe cannot tell a missing file from a refused
// one. The reads go through the pane preview's own readers, which repeat the containment on the open
// descriptor, apply the private-path policy and Nenu's state directory, cap the size and check a
// picture's or a PDF's bytes; HTML runs only in the preview's opaque, offline sandbox (ADR 0085).

const SERVED = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".html", ".pdf"]);

function notFound(): Response {
  return new Response("Not in this project's library.", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

export async function libraryFileResponse(
  library: string | undefined,
  requested: string | null,
  options: { ifNoneMatch?: string | null; inlineAssets?: boolean; host?: string; stateDir: string },
): Promise<Response> {
  if (!requested) return new Response("A file path is required.", { status: 400, headers: { "content-type": "text/plain; charset=utf-8" } });
  const ext = extname(requested).toLowerCase();
  if (!library || !isAbsolute(requested) || requested.length > 4096 || /[\x00-\x1f]/.test(requested) || !SERVED.has(ext)) return notFound();
  const folder = await lstat(library).catch(() => null);
  if (!folder?.isDirectory()) return notFound();
  const root = await realpath(library).catch(() => null);
  const path = root && await containedRealpath(requested, root);
  // A link inside the library may lead only to a file of the kind its name says.
  if (!root || !path || path === root || extname(path).toLowerCase() !== ext) return notFound();
  if (ext === ".html") return renderedHtmlResponse(root, path, { inlineAssets: options.inlineAssets, host: options.host, stateDir: options.stateDir });
  const response = await paneFileResponse(root, path, { ifNoneMatch: options.ifNoneMatch, stateDir: options.stateDir });
  // A sandboxed response blocks the browser's PDF viewer; a PDF keeps the viewer's own isolation (ADR 0063).
  if (response.headers.get("content-type") === "application/pdf") response.headers.delete("content-security-policy");
  return response;
}
