import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { basename, extname, isAbsolute, sep } from "node:path";
import { HTML_PREVIEW_CSP } from "../web/src/lib/html-preview.ts";
import { FILE_SECURITY_HEADERS, fileStream } from "./media-preview.ts";
import { binaryMime, isPrivateProjectPath, isTextPath } from "./pane-files.ts";

// The operator-confirmed way out for a file Nenu refuses to preview (ADR 0063): outside the
// agent's folder, or past a preview size cap. A write-level device asks for a grant naming one
// absolute path; the bridge answers with a short-lived, single-use link bound to the resolved file
// and that device. The link opens the file as its own page, sandboxed and offline when the browser
// could execute it, and as a download when the browser would not know what to do with it.

export const MAX_OPEN_FILE_BYTES = 64 * 1024 * 1024;
export const GRANT_TTL_MS = 2 * 60 * 1000;
/** Outstanding links kept at once; the oldest is dropped first. */
const MAX_GRANTS = 64;
const SNIFF_HEAD_BYTES = 64;

interface Grant { path: string; device: string | null; expires: number }

/** In-memory single-use links. A restart forgets every one, which only costs a second tap. */
export class FileGrants {
  private readonly grants = new Map<string, Grant>();

  constructor(
    private readonly now: () => number = Date.now,
    private readonly token: () => string = () => randomBytes(16).toString("base64url"),
  ) {}

  issue(path: string, device: string | null): string {
    const now = this.now();
    for (const [key, grant] of this.grants) if (grant.expires <= now) this.grants.delete(key);
    while (this.grants.size >= MAX_GRANTS) this.grants.delete(this.grants.keys().next().value!);
    const token = this.token();
    this.grants.set(token, { path, device, expires: now + GRANT_TTL_MS });
    return token;
  }

  /** The granted path, spending the token whatever the outcome; null when it cannot be used. */
  consume(token: string | null, device: string | null): string | null {
    if (!token) return null;
    const grant = this.grants.get(token);
    if (!grant) return null;
    this.grants.delete(token);
    return grant.expires > this.now() && grant.device === device ? grant.path : null;
  }
}

export interface OpenableFile { path: string; name: string; size: number; type: string }
type Refusal = { status: number; message: string };

const refuse = (status: number, message: string): Refusal => ({ status, message });
const PRIVATE = refuse(403, "This file is private and cannot be opened from Nenu.");
const MISSING = refuse(404, "File not found.");

/**
 * The checks a path passes both when it is granted and again when its link is opened: absolute,
 * resolved, not private (the preview's own policy, on the given and the resolved name), not inside
 * Nenu's state directory (push keys, audit log), a regular file, and within the size cap. Returns an
 * open descriptor on the resolved file so the bytes served are the bytes checked.
 */
async function openChecked(requested: unknown, stateDir: string): Promise<{ handle: FileHandle; path: string; size: number } | Refusal> {
  if (typeof requested !== "string" || !isAbsolute(requested) || requested.length > 4096 || /[\x00-\x1f]/.test(requested))
    return refuse(400, "An absolute file path is required.");
  if (isPrivateProjectPath(requested)) return PRIVATE;
  const path = await realpath(requested).catch(() => null);
  if (!path) return MISSING;
  const state = await realpath(stateDir).catch(() => stateDir);
  if (isPrivateProjectPath(path) || path === state || path.startsWith(state + sep)) return PRIVATE;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return MISSING;
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw MISSING;
    if (stat.size > MAX_OPEN_FILE_BYTES) throw refuse(413, `File is too large to open (maximum ${MAX_OPEN_FILE_BYTES / 1024 / 1024} MB).`);
    return { handle, path, size: stat.size };
  } catch (error) {
    await handle.close();
    return error && typeof error === "object" && "status" in error ? error as Refusal : MISSING;
  }
}

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp"]);
const ATTACHMENT = "application/octet-stream";

/** What the browser is told the file is, from its name. Images and PDFs are confirmed by sniffing at open. */
function namedType(path: string): string {
  const ext = extname(path).toLowerCase();
  if ([".html", ".htm", ".xhtml"].includes(ext)) return "text/html; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".pdf") return "application/pdf";
  if (IMAGE_EXT.has(ext)) return ext === ".jpg" ? "image/jpeg" : `image/${ext.slice(1)}`;
  if (isTextPath(path)) return "text/plain; charset=utf-8";
  return ATTACHMENT;
}

function disposition(kind: "inline" | "attachment", name: string): string {
  return `${kind}; filename*=UTF-8''${encodeURIComponent(name).replace(/'/g, "%27")}`;
}

/** Validate a grant request; on success the caller issues a link for `path`. */
export async function checkOpenable(requested: unknown, stateDir: string): Promise<OpenableFile | Refusal> {
  const file = await openChecked(requested, stateDir);
  if ("status" in file) return file;
  await file.handle.close();
  return { path: file.path, name: basename(file.path), size: file.size, type: namedType(file.path).split(";")[0]! };
}

function errorPage(refusal: Refusal): Response {
  return new Response(refusal.message, {
    status: refusal.status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...FILE_SECURITY_HEADERS },
  });
}

export const EXPIRED_MESSAGE = "This link expired or was already used. Go back to Nenu and tap Open again.";

/**
 * Serve a granted file as a page of its own. A document the browser can execute (HTML, SVG) gets the
 * HTML preview's no-network policy plus `sandbox allow-scripts`, so it runs in an opaque origin that
 * cannot reach Nenu or the network. Text is plain text, images and PDFs are served only when their
 * bytes match the name, and anything else downloads.
 */
export async function grantedFileResponse(path: string | null, stateDir: string): Promise<Response> {
  if (!path) return errorPage(refuse(410, EXPIRED_MESSAGE));
  const file = await openChecked(path, stateDir);
  if ("status" in file) return errorPage(file);
  let streaming = false;
  try {
    // The grant bound the resolved name; a path that now resolves elsewhere is not what was confirmed.
    if (file.path !== path) return errorPage(MISSING);
    let type = namedType(file.path);
    if (type === "application/pdf" || type.startsWith("image/") && type !== "image/svg+xml") {
      const head = Buffer.alloc(Math.min(SNIFF_HEAD_BYTES, file.size));
      await file.handle.read(head, 0, head.length, 0);
      type = binaryMime(type === "application/pdf" ? "pdf" : "image", head) ?? ATTACHMENT;
    }
    const executable = type.startsWith("text/html") || type === "image/svg+xml";
    const headers: Record<string, string> = {
      "content-type": type,
      "content-length": String(file.size),
      "content-disposition": disposition(type === ATTACHMENT ? "attachment" : "inline", basename(file.path)),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    };
    // A sandboxed response blocks the browser's PDF viewer, so a PDF keeps the viewer's own isolation.
    if (executable) headers["content-security-policy"] = `${HTML_PREVIEW_CSP}; frame-ancestors 'none'; sandbox allow-scripts`;
    else if (type !== "application/pdf") headers["content-security-policy"] = `${FILE_SECURITY_HEADERS["content-security-policy"]}; frame-ancestors 'none'`;
    streaming = true;
    return new Response(fileStream(file.handle, 0, file.size - 1), { headers });
  } finally {
    if (!streaming) await file.handle.close();
  }
}
