// Phone photos are 3-8 MB at 4000+ px; the agent gains nothing past a couple of thousand pixels, and
// the upload, the uploads directory and the model's image budget all pay for the rest. So a large
// picture is redrawn at a bounded long edge before it leaves the device. Anything this cannot
// improve (a GIF, which may animate; a small image; a browser without the APIs) goes up untouched.

/** Long edge, in pixels, an upload is scaled down to. */
export const MAX_UPLOAD_EDGE = 2048;

/** The size a `width`×`height` image is drawn at so its long edge is at most `max`; null to keep it. */
export function scaledSize(width: number, height: number, max = MAX_UPLOAD_EDGE): { width: number; height: number } | null {
  const edge = Math.max(width, height);
  if (!(edge > max)) return null;
  const scale = max / edge;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function canvasBlob(bitmap: ImageBitmap, size: { width: number; height: number }, type: string): Promise<Blob | null> {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const context = canvas.getContext("2d");
  if (!context) return Promise.resolve(null);
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, size.width, size.height);
  return new Promise((resolve) => canvas.toBlob(resolve, type, 0.88));
}

/**
 * The file to upload: `file` itself, or a re-encoded copy whose long edge is `max`. PNG stays PNG
 * (screenshots keep sharp text and transparency); everything else becomes JPEG. A downscaled copy is
 * used only when it is actually smaller.
 */
export async function downscaleImage(file: File, max = MAX_UPLOAD_EDGE): Promise<File> {
  if (!/^image\/(png|jpeg|webp|heic|heif)$/.test(file.type) || typeof createImageBitmap !== "function") return file;
  let bitmap: ImageBitmap | undefined;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    // HEIC is re-encoded even at full size: the bridge accepts only PNG, JPEG, GIF and WebP.
    const heic = /hei[cf]$/.test(file.type);
    const size = scaledSize(bitmap.width, bitmap.height, max) ?? (heic ? { width: bitmap.width, height: bitmap.height } : null);
    if (!size) return file;
    const type = file.type === "image/png" ? "image/png" : "image/jpeg";
    const blob = await canvasBlob(bitmap, size, type);
    if (!blob || (!heic && blob.size >= file.size)) return file;
    const name = file.name.replace(/\.[^./]*$/, "") + (type === "image/png" ? ".png" : ".jpg");
    return new File([blob], name, { type, lastModified: file.lastModified });
  } catch {
    return file;
  } finally {
    bitmap?.close();
  }
}
