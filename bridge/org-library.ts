import { lstat, realpath } from "node:fs/promises";
import { extname, isAbsolute } from "node:path";

import { renderedHtmlResponse } from "./html-preview.ts";
import { containedRealpath } from "./journal/files.ts";
import { openPaneFile, paneFileResponse, readPaneText } from "./pane-files.ts";
import type { ThreadSummary, ThreadVerdict } from "./types.ts";

// A project's library (`<project>/library/<thread id>/`) is where Organizations copies the pictures
// and documents each thread produced, without symbolic links. The Summary view shows them, so the
// bridge serves files from it, and only from it: a path is served when its real path is inside the
// real library folder, which must itself be a folder and not a link, and when its kind is a picture,
// HTML or a PDF. Everything else is the same 404, so a probe cannot tell a missing file from a refused
// one. The reads go through the pane preview's own readers, which repeat the containment on the open
// descriptor, apply the private-path policy and Nenu's state directory, cap the size and check a
// picture's or a PDF's bytes; HTML runs only in the preview's opaque, offline sandbox (ADR 0088).
// The library sits in the project's records folder, which Organizations may keep anywhere, and so do
// the reports: a thread's report is served by its id, from the path Organizations gave, under the same
// readers rooted at that records folder (ADR 0096).

/** Longer reports are cut: a report is a page someone reads, not a log. */
const MAX_REPORT_CHARS = 100_000;
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

/** Where a thread's report is, the records folder it must sit in, and what the overview read of it (`ProjectRegistry.report`). */
export interface ThreadReportSource {
  path: string;
  records: string;
  title: string;
  summary?: ThreadSummary;
  verdict?: ThreadVerdict;
}

/** A thread's report as Your asks shows it: what Organizations read of it, and its Markdown as written. */
export interface ThreadReport {
  title: string;
  verdict?: ThreadVerdict;
  /** The Markdown as the agent wrote it: drawn as text, never as markup. */
  text: string;
  captures: ThreadSummary["captures"];
  deliverables: ThreadSummary["deliverables"];
}

/**
 * The report at `found.path`, read only when its real path is inside the real records folder, it is a
 * regular Markdown file and not a link, under the private-path policy and outside Nenu's state
 * directory (the pane preview's reader). Anything else, a thread without a report included, is the
 * same 404.
 */
export async function reportResponse(
  found: ThreadReportSource | undefined,
  options: { stateDir: string },
): Promise<Response> {
  const missing = new Response(JSON.stringify({ ok: false, error: "No report for this thread." }), { status: 404, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  if (!found || extname(found.path).toLowerCase() !== ".md") return missing;
  // Organizations copies a report home as a regular file: a link in its place is not one.
  const [folder, own] = await Promise.all([lstat(found.records).catch(() => null), lstat(found.path).catch(() => null)]);
  if (!folder?.isDirectory() || !own?.isFile()) return missing;
  const file = await openPaneFile(found.records, found.path, undefined, options.stateDir);
  if (file instanceof Response) return missing;
  try {
    if (file.kind !== "markdown") return missing;
    const text = await readPaneText(file);
    if (text === null) return missing;
    const report: ThreadReport = {
      title: found.title, ...(found.verdict ? { verdict: found.verdict } : {}), text: text.slice(0, MAX_REPORT_CHARS),
      captures: found.summary?.captures ?? [], deliverables: found.summary?.deliverables ?? [],
    };
    return new Response(JSON.stringify({ ok: true, report }), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } finally {
    await file.handle.close();
  }
}
