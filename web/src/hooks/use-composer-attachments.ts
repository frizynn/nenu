import { useEffect, useRef, useState } from "react";

import { downscaleImage } from "@/lib/image-downscale";
import { isLocalImageUrl, localImageUrl, rememberLocalImage } from "@/lib/local-sends";
import { serializeDraft, uploadName } from "@/lib/message-images";
import type { UploadResponse } from "@/lib/types";

// Files attached to the draft, kept as structured state beside the text — the textarea never shows
// a path, only a numbered chip where each picture goes. Each one is uploaded as soon as it is picked;
// the message only carries the server paths (lib/message-images.ts serializeDraft) when it is sent.
// Only an image gets a preview. A picture's number is its place among the pictures here, from 1.

export type AttachmentStatus = "uploading" | "ready" | "error";

export interface Attachment {
  id: string;
  /** Whether it previews: a picked image, or a restored upload the bridge named by its image bytes. */
  image: boolean;
  /** An image's thumbnail: a local object URL, or the server preview for a restored draft. */
  url?: string;
  /** What it was called when attached; a restored image has none and shows as "Image N". */
  name?: string;
  size?: number;
  status: AttachmentStatus;
  /** Server path, once uploaded. */
  path?: string;
  error?: string;
  file?: File;
}

export const MAX_ATTACHMENTS = 10;
/** One file, at most (bridge/uploads.ts MAX_UPLOAD_BYTES); a bigger one is refused before it uploads. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

/** What `add` turned away: files over the size limit, by name, and how many found no room. */
export interface AttachRefusal {
  tooLarge: string[];
  overLimit: number;
}

/** What `add` took: how many of the files were pictures, numbered after the ones already there. */
export interface AttachResult extends AttachRefusal {
  images: number;
}

function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

interface Options {
  upload: (file: File) => Promise<UploadResponse>;
  /** Thumbnail for a path restored from a saved draft (no local file behind it). */
  previewUrl: (path: string) => string;
  /** Every change to the set of uploaded paths, for draft persistence. */
  onPathsChange?: (paths: string[]) => void;
  /** Uploads restored with the saved draft on mount. */
  initialPaths?: readonly string[];
}

export function readyPaths(list: readonly Attachment[]): string[] {
  return list.flatMap((item) => (item.status === "ready" && item.path ? [item.path] : []));
}

/** The pictures, in number order: picture n is `pictures(list)[n - 1]`. */
export function pictures(list: readonly Attachment[]): Attachment[] {
  return list.filter((item) => item.image);
}

/** The draft's wire text: each chip its picture's path, the other files after the prose. */
export function draftWire(text: string, list: readonly Attachment[]): string {
  if (!list.length) return text;
  const path = (item: Attachment) => (item.status === "ready" && item.path ? item.path : null);
  return serializeDraft(text, pictures(list).map(path), list.filter((item) => !item.image).flatMap((item) => path(item) ?? []));
}

/** What tells each picture apart for draftFromWire: its path once uploaded, else its id (never a path). */
export function pictureKeys(list: readonly Attachment[]): string[] {
  return pictures(list).map((item) => item.path ?? item.id);
}

function restored(path: string, previewUrl: (path: string) => string): Attachment {
  const name = uploadName(path);
  if (name !== null) return { id: crypto.randomUUID(), image: false, name, status: "ready", path };
  return { id: crypto.randomUUID(), image: true, url: localImageUrl(path) ?? previewUrl(path), status: "ready", path };
}

export function useComposerAttachments({ upload, previewUrl, onPathsChange, initialPaths = [] }: Options) {
  const [items, setItems] = useState<Attachment[]>(() => initialPaths.map((path) => restored(path, previewUrl)));
  const itemsRef = useRef(items);
  const alive = useRef(true);
  const options = useRef({ upload, previewUrl, onPathsChange });
  options.current = { upload, previewUrl, onPathsChange };

  function commit(next: Attachment[]) {
    const before = readyPaths(itemsRef.current).join("\n");
    itemsRef.current = next;
    setItems(next);
    const after = readyPaths(next);
    if (after.join("\n") !== before) options.current.onPathsChange?.(after);
  }

  function patch(id: string, change: Partial<Attachment>) {
    commit(itemsRef.current.map((item) => (item.id === id ? { ...item, ...change } : item)));
  }

  /** A local object URL nobody else owns is revoked; one handed to the sent-image cache is not. */
  function release(item: Attachment) {
    if (item.file && item.url && !isLocalImageUrl(item.url)) URL.revokeObjectURL(item.url);
  }

  async function start(id: string, file: File) {
    let result: UploadResponse;
    try {
      result = await options.current.upload(await downscaleImage(file));
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    // Removed while uploading, or the composer is gone: its URL was released then.
    if (!item || !alive.current) return;
    if (result.ok) {
      if (item.url) rememberLocalImage(result.path, item.url);
      patch(id, { status: "ready", path: result.path, error: undefined });
    } else patch(id, { status: "error", error: result.error });
  }

  /** Attach and upload. Returns how many pictures went in, and what was refused: too large, or past the count limit. */
  function add(files: Iterable<File>): AttachResult {
    const list = [...files];
    const fitting = list.filter((file) => file.size <= MAX_ATTACHMENT_BYTES);
    const accepted = fitting.slice(0, Math.max(0, MAX_ATTACHMENTS - itemsRef.current.length));
    const added = accepted.map((file): Attachment & { file: File } => {
      const image = isImageFile(file);
      // Only an image is read into the page, for its thumbnail; a PDF or an archive never is.
      return { id: crypto.randomUUID(), image, url: image ? URL.createObjectURL(file) : undefined, name: file.name, size: file.size, status: "uploading", file };
    });
    if (added.length) commit([...itemsRef.current, ...added]);
    added.forEach((item) => void start(item.id, item.file));
    return {
      images: added.filter((item) => item.image).length,
      tooLarge: list.filter((file) => file.size > MAX_ATTACHMENT_BYTES).map((file) => file.name),
      overLimit: fitting.length - accepted.length,
    };
  }

  function retry(id: string) {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (!item?.file || item.status !== "error") return;
    patch(id, { status: "uploading", error: undefined });
    void start(id, item.file);
  }

  function remove(id: string) {
    const item = itemsRef.current.find((candidate) => candidate.id === id);
    if (item) release(item);
    commit(itemsRef.current.filter((candidate) => candidate.id !== id));
  }

  /** Add already-uploaded paths (a message coming back into the composer). */
  function append(paths: readonly string[]) {
    const known = new Set(readyPaths(itemsRef.current));
    const fresh = paths.filter((path) => !known.has(path));
    if (fresh.length) commit([...itemsRef.current, ...fresh.map((path) => restored(path, options.current.previewUrl))]);
  }

  /** Replace everything with already-uploaded paths (a restored draft, or none to clear). */
  function reset(paths: readonly string[] = []) {
    itemsRef.current.forEach(release);
    commit(paths.map((path) => restored(path, options.current.previewUrl)));
  }

  // Leaving the pane: free what nothing else holds, and orphan in-flight uploads so a late answer
  // cannot hand an already-revoked URL to the sent-image cache.
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      itemsRef.current.forEach(release);
    };
  }, []);

  return {
    items,
    paths: readyPaths(items),
    uploading: items.some((item) => item.status === "uploading"),
    failed: items.some((item) => item.status === "error"),
    add,
    retry,
    remove,
    append,
    reset,
    /** Read without waiting for a render (send() runs from event handlers). */
    current: () => itemsRef.current,
  };
}
