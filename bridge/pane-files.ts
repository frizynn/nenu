import {
  etagMatches, fileEtag, fileStream, FILE_SECURITY_HEADERS, inlineDisposition, MAX_VIDEO_BYTES,
  notModifiedResponse, REVALIDATE, videoResponse,
} from "./media-preview.ts";
import { constants } from "node:fs";
import { open, realpath, type FileHandle } from "node:fs/promises";
import { basename, extname, isAbsolute, normalize, resolve, sep } from "node:path";
import { containedRealpath } from "./journal/files.ts";
import { imageExtFromBytes } from "./uploads.ts";

export const MAX_TEXT_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_PREVIEW_FILE_BYTES = 20 * 1024 * 1024;
/** Enough leading bytes to sniff every image and PDF signature we accept. */
const SNIFF_HEAD_BYTES = 64;

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

/** Header that tells the client why a 404 happened when the reason is visible from the name alone. */
export const FILE_STATE_HEADER = "x-file-state";
export const OUTSIDE_PROJECT_MESSAGE = "This file is outside the project.";

function fileError(message: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(message, { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...headers } });
}

type FileKind = "text" | "markdown" | "pdf" | "image" | "video";

function fileKind(path: string): FileKind | null {
  const ext = extname(path).toLowerCase();
  if ([".md", ".markdown"].includes(ext)) return "markdown";
  if ([".mp4", ".m4v", ".mov", ".webm"].includes(ext)) return "video";
  if (ext === ".pdf") return "pdf";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) return "image";
  if (TEXT_EXTENSIONS.has(ext) || TEXT_NAMES.has(basename(path).toLowerCase())) return "text";
  return null;
}

function kindLimit(kind: FileKind): number {
  return kind === "video" ? MAX_VIDEO_BYTES : kind === "text" || kind === "markdown" ? MAX_TEXT_FILE_BYTES : MAX_PREVIEW_FILE_BYTES;
}

/** A contained, opened, bounded regular file. The caller owns `handle` and must close it. */
export interface PaneFile {
  handle: FileHandle;
  /** Real path after containment. */
  path: string;
  kind: FileKind;
  size: number;
  etag: string;
}

/**
 * Project previews are an explicit exception to journal-only reads: the client may name a file,
 * but the live pane supplies its root. Resolve both names, refuse escapes and sensitive paths,
 * then open a bounded regular file through one descriptor (never reopen its name while serving).
 * A file outside the root is served only when the pane's journal shows the agent delivered it
 * (`delivered`, loaded lazily), named by its exact path or by a trailing part of it; the
 * private-path policy and bounded read still apply.
 */
export async function openPaneFile(
  cwd: string | undefined,
  requestedPath: string | null,
  delivered: () => Promise<readonly string[]> = async () => [],
): Promise<PaneFile | Response> {
  if (!requestedPath || requestedPath.length > 4096 || /[\x00-\x1f]/.test(requestedPath)) {
    return fileError("A valid project file path is required.", 400);
  }
  const unavailable = () => fileError("File unavailable in this workspace.", 404);
  if (!cwd || !isAbsolute(cwd) || isPrivateProjectPath(requestedPath)) return unavailable();
  const root = await realpath(cwd).catch(() => null);
  if (!root || root === sep) return unavailable();
  const candidate = resolve(cwd, requestedPath);
  // Prose names a delivered file loosely ("ai.jpg", "ronda-2/ai.jpg"), so a relative name that
  // is not in the project falls back to the newest delivery whose path ends with it.
  const suffix = isAbsolute(requestedPath) ? null : sep + normalize(requestedPath);
  let outside: Promise<string | undefined> | undefined;
  const locate = async () => {
    const contained = await containedRealpath(candidate, root);
    if (contained) return contained;
    const sent = await (outside ??= delivered().then((paths) => paths.includes(candidate)
      ? candidate : suffix ? paths.findLast((path) => path.endsWith(suffix)) : undefined, () => undefined));
    return sent ? await realpath(sent).catch(() => null) : null;
  };
  const path = await locate();
  if (!path) {
    // Decided from the name alone, so it says nothing about whether the file exists.
    const within = (base: string) => candidate === base || candidate.startsWith(base + sep);
    return within(resolve(cwd)) || within(root)
      ? unavailable()
      : fileError(OUTSIDE_PROJECT_MESSAGE, 404, { [FILE_STATE_HEADER]: "outside-project" });
  }
  if (isPrivateProjectPath(path)) return unavailable();
  const kind = fileKind(path);
  if (!kind) return fileError("This file type cannot be previewed.", 415);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => null);
  if (!handle) return unavailable();
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || await locate() !== path) throw unavailable();
    const limit = kindLimit(kind);
    if (stat.size > limit) throw fileError(`File is too large to preview (maximum ${limit / 1024 / 1024} MB).`, 413);
    return { handle, path, kind, size: stat.size, etag: fileEtag(stat) };
  } catch (error) {
    await handle.close();
    return error instanceof Response ? error : unavailable();
  }
}

/** Read up to `size` bytes; a file that grows after the stat stays capped at that size. */
export async function readPaneBytes(file: PaneFile, size = file.size): Promise<Buffer<ArrayBuffer>> {
  const bytes = Buffer.alloc(Math.min(size, file.size));
  let length = 0;
  while (length < bytes.length) {
    const read = await file.handle.read(bytes, length, bytes.length - length, length);
    if (read.bytesRead === 0) break;
    length += read.bytesRead;
  }
  return bytes.subarray(0, length);
}

/** The bytes as text, or null when they are binary. */
export async function readPaneText(file: PaneFile): Promise<string | null> {
  const bytes = await readPaneBytes(file);
  return bytes.includes(0) ? null : bytes.toString("utf8");
}

/** The served MIME of a sniffed image or PDF head, or null when the bytes are not what the name says. */
function binaryMime(kind: "pdf" | "image", head: Buffer): string | null {
  if (kind === "pdf") return head.subarray(0, 5).toString("ascii") === "%PDF-" ? "application/pdf" : null;
  const image = imageExtFromBytes(head);
  return image ? (image === "jpg" ? "image/jpeg" : `image/${image}`) : null;
}

/**
 * Serve a contained project file (see {@link openPaneFile}). HTML/SVG/source code remain text/plain;
 * none of the project's markup is executed by the browser. Images, PDFs and videos stream in
 * bounded chunks; text is read whole (it is capped at 2 MB and must be checked for binary bytes).
 * A matching If-None-Match gets a 304 only after every containment check has passed again.
 */
export async function paneFileResponse(
  cwd: string | undefined,
  requestedPath: string | null,
  options: {
    range?: string | null;
    ifNoneMatch?: string | null;
    delivered?: () => Promise<readonly string[]>;
  } = {},
): Promise<Response> {
  const file = await openPaneFile(cwd, requestedPath, options.delivered);
  if (file instanceof Response) return file;
  let streaming = false;
  try {
    if (etagMatches(options.ifNoneMatch ?? null, file.etag)) return notModifiedResponse(file.etag);
    const filename = basename(file.path);
    if (file.kind === "video") {
      streaming = true;
      return await videoResponse(file.handle, file.size, options.range ?? null, filename, file.etag);
    }
    const headers = {
      "content-disposition": inlineDisposition(filename),
      etag: file.etag,
      "cache-control": REVALIDATE,
      ...FILE_SECURITY_HEADERS,
    };
    if (file.kind === "pdf" || file.kind === "image") {
      const mime = binaryMime(file.kind, await readPaneBytes(file, SNIFF_HEAD_BYTES));
      if (!mime) return fileError(file.kind === "pdf" ? "This file is not a valid PDF." : "This file is not a supported image.", 415);
      streaming = true;
      return new Response(fileStream(file.handle, 0, file.size - 1), {
        headers: { "content-type": mime, "content-length": String(file.size), ...headers },
      });
    }
    const content = await readPaneBytes(file);
    if (content.includes(0)) return fileError("Binary files cannot be displayed as text.", 415);
    return new Response(content, {
      headers: {
        "content-type": file.kind === "markdown" ? "text/markdown; charset=utf-8" : "text/plain; charset=utf-8",
        "content-length": String(content.length),
        ...headers,
      },
    });
  } catch {
    return fileError("File unavailable in this workspace.", 404);
  } finally {
    if (!streaming) await file.handle.close();
  }
}
