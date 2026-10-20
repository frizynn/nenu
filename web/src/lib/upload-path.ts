// Nenu's own generated upload names, on their own: the bridge reads them too (harness/inline-images.ts),
// and it typechecks without the web's dependencies, so nothing here may import beyond this file.

/**
 * Nenu's own generated upload names (bridge/uploads.ts saveUpload), in an uploads dir: an image named
 * by its bytes (chat-upload-preview.ts UPLOAD_NAME), or any other file with the name it was attached
 * under after the generated part (group 1).
 */
const UPLOAD_PATH = /\/uploads\/[A-Za-z0-9_-]+-[a-z0-9]+-[a-f0-9]{8}(?:\.(?:png|jpg|gif|webp)|-([A-Za-z0-9._-]+))$/;

export function isUploadPath(path: string): boolean {
  return UPLOAD_PATH.test(path);
}

/** The name a non-image upload was attached under; null for an image (named by its bytes) or any other path. */
export function uploadName(path: string): string | null {
  return UPLOAD_PATH.exec(path)?.[1] ?? null;
}

/** A picture Nenu uploaded: an upload named by its image bytes. The one rule for which paths travel in place (ADR 0104). */
export function isPicturePath(path: string): boolean {
  return isUploadPath(path) && uploadName(path) === null;
}
