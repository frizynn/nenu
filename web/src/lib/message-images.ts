import { filePathsInText } from "./chat-files";

// A message that carries images is plain text on the wire: the agent CLIs (Claude Code, Codex) read
// an image by its absolute path, so the composer appends each uploaded path to the text it sends.
// Everything the operator LOOKS at, though, shows the images as images ("Image 1", "Image 2", …), never
// as paths. These helpers are the one place that converts between the two shapes.

const IMAGE_EXTENSION = /\.(?:png|jpe?g|gif|webp)$/i;
/** Nenu's own generated upload names (bridge/chat-upload-preview.ts UPLOAD_NAME), in an uploads dir. */
const UPLOAD_PATH = /\/uploads\/[A-Za-z0-9_-]+-[a-z0-9]+-[a-f0-9]{8}\.(?:png|jpg|gif|webp)$/;
/** Claude Code's own placeholder when it turns a pasted image path into an attachment. */
const IMAGE_TOKEN = /\[Image #\d+\]/g;

export function isUploadPath(path: string): boolean {
  return UPLOAD_PATH.test(path);
}

function removePaths(text: string, paths: string[]): string {
  let out = text;
  for (const path of paths) out = out.split(path).join("");
  // Removing a path leaves the spaces that separated it; collapse those, keep line breaks.
  return out.replace(/[ \t]{2,}/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n").trim();
}

/** The prose of a message and the image paths it carries, in order, without duplicates. */
export function splitMessageImages(text: string): { text: string; images: string[] } {
  const images = [...new Set(filePathsInText(text).filter((path) => IMAGE_EXTENSION.test(path)))];
  return images.length ? { text: removePaths(text, images), images } : { text, images };
}

/** Same split, but only Nenu's own uploads leave the text — a path the operator typed stays prose. */
export function splitDraftUploads(text: string): { text: string; uploads: string[] } {
  const uploads = splitMessageImages(text).images.filter(isUploadPath);
  return uploads.length ? { text: removePaths(text, uploads), uploads } : { text, uploads };
}

/** The wire text: the prose, then every image path, space-separated (what the composer always sent). */
export function serializeMessage(text: string, paths: readonly string[]): string {
  const body = text.trimEnd();
  if (!paths.length) return body;
  return body.trim() ? `${body} ${paths.join(" ")}` : paths.join(" ");
}

/**
 * A comparison key for "is this journal message the one I sent?" — whitespace-insensitive, and blind
 * to whether the harness kept the image paths or swapped them for its own `[Image #N]` tokens.
 */
export function messageMatchKey(text: string): string {
  const { text: prose, images } = splitMessageImages(text);
  const tokens = prose.match(IMAGE_TOKEN)?.length ?? 0;
  return `${prose.replace(IMAGE_TOKEN, " ").replace(/\s+/g, " ").trim()}\u0000${images.length + tokens}`;
}

/** "Image 1", "Image 2", … — numbered per message, the way the agent CLIs label attachments. */
export function imageLabel(index: number): string {
  return `Image ${index + 1}`;
}
