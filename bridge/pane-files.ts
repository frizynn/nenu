import { videoResponse, MAX_VIDEO_BYTES } from "./media-preview.ts";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { basename, extname, isAbsolute, resolve, sep } from "node:path";
import { containedRealpath } from "./journal/files.ts";
import { imageExtFromBytes } from "./uploads.ts";

export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_PREVIEW_FILE_BYTES = 20 * 1024 * 1024;

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".mdx", ".json", ".jsonc", ".jsonl", ".csv", ".tsv", ".log",
  ".yaml", ".yml", ".toml", ".xml", ".html", ".htm", ".svg", ".css", ".scss",
  ".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".py", ".rb", ".go", ".rs",
  ".java", ".kt", ".swift", ".c", ".h", ".cpp", ".hpp", ".sh", ".bash", ".zsh",
  ".sql", ".graphql", ".prisma", ".diff", ".patch", ".ini", ".conf", ".rst",
]);
const TEXT_NAMES = new Set(["readme", "license", "licence", "dockerfile", "makefile", ".gitignore", ".gitattributes", ".editorconfig"]);
const PRIVATE_PART = /^(?:\.env(?:\..*)?|\.git|\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.config|\.codex|\.claude|\.npmrc|\.pypirc|\.netrc|credentials(?:\..*)?|auth\.json|id_(?:rsa|ed25519|ecdsa|dsa)(?:\..*)?)$/i;
const PRIVATE_EXTENSION = /\.(?:pem|key|p12|pfx|keystore)$/i;

/** Apply the same policy to the supplied name and the resolved target of an in-project symlink. */
export function isPrivateProjectPath(path: string): boolean {
  return path.split(/[\\/]/).some((part) => PRIVATE_PART.test(part)) || PRIVATE_EXTENSION.test(path);
}

function fileError(message: string, status: number): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } });
}

function fileKind(path: string): "text" | "markdown" | "pdf" | "image" | "video" | null {
  const ext = extname(path).toLowerCase();
  if ([".md", ".markdown"].includes(ext)) return "markdown";
  if ([".mp4", ".m4v", ".mov", ".webm"].includes(ext)) return "video";
  if (ext === ".pdf") return "pdf";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return "image";
  if (TEXT_EXTENSIONS.has(ext) || TEXT_NAMES.has(basename(path).toLowerCase())) return "text";
  return null;
}

/**
 * Project previews are an explicit exception to journal-only reads: the client may name a file,
 * but the live pane supplies its root. Resolve both names, refuse escapes and sensitive paths,
 * then read a bounded regular file through one descriptor (never reopen its name while serving).
 * HTML/SVG/source code remain text/plain; none of the project's markup is executed by the browser.
 */
export async function paneFileResponse(cwd: string | undefined, requestedPath: string | null, range: string | null = null): Promise<Response> {
  if (!requestedPath || requestedPath.length > 4096 || /[\x00-\x1f]/.test(requestedPath)) {
    return fileError("A valid project file path is required.", 400);
  }
  const unavailable = () => fileError("File unavailable in this workspace.", 404);
  if (!cwd || !isAbsolute(cwd) || isPrivateProjectPath(requestedPath)) return unavailable();
  const root = await realpath(cwd).catch(() => null);
  if (!root || root === sep) return unavailable();
  const candidate = resolve(cwd, requestedPath);
  const path = await containedRealpath(candidate, root);
  if (!path || isPrivateProjectPath(path)) return unavailable();
  const kind = fileKind(path);
  if (!kind) return fileError("This file type cannot be previewed.", 415);
  const limit = kind === "video" ? MAX_VIDEO_BYTES : kind === "text" || kind === "markdown" ? MAX_TEXT_FILE_BYTES : MAX_PREVIEW_FILE_BYTES;
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return unavailable();
  let streaming = false;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || await containedRealpath(path, root) !== path) return unavailable();
    if (stat.size > limit) return fileError(`File is too large to preview (maximum ${limit / 1024 / 1024} MB).`, 413);
    if (kind === "video") {
      const response = await videoResponse(handle, stat.size, range, basename(path));
      streaming = true;
      return response;
    }
    // A growing file stays capped, even when it changes after the initial stat.
    const bytes = Buffer.alloc(stat.size);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    const content = bytes.subarray(0, length);
    let mime = kind === "markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8";
    if (kind === "pdf") {
      if (content.subarray(0, 5).toString("ascii") !== "%PDF-") return fileError("This file is not a valid PDF.", 415);
      mime = "application/pdf";
    } else if (kind === "image") {
      const image = imageExtFromBytes(content);
      if (!image) return fileError("This file is not a supported image.", 415);
      mime = image === "jpg" ? "image/jpeg" : `image/${image}`;
    } else if (content.includes(0)) {
      return fileError("Binary files cannot be displayed as text.", 415);
    }
    return new Response(content, {
      headers: {
        "content-type": mime,
        "content-length": String(length),
        "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(basename(path)).replace(/'/g, "%27")}`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        // Raw files are not documents in the app's security context, even when navigated directly.
        "content-security-policy": "default-src 'none'; sandbox",
      },
    });
  } catch {
    return unavailable();
  } finally {
    if (!streaming) await handle.close();
  }
}
