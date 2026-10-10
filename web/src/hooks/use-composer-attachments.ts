import { useEffect, useRef, useState } from "react";

import { downscaleImage } from "@/lib/image-downscale";
import { isLocalImageUrl, localImageUrl, rememberLocalImage } from "@/lib/local-sends";
import type { UploadResponse } from "@/lib/types";

// Images attached to the draft, kept as structured state beside the text — the textarea never shows
// a path. Each one is uploaded as soon as it is picked; the message only carries the server paths
// (lib/message-images.ts serializeMessage) when it is sent.

export type AttachmentStatus = "uploading" | "ready" | "error";

export interface Attachment {
  id: string;
  /** What the thumbnail shows: a local object URL, or the server preview for a restored draft. */
  url: string;
  status: AttachmentStatus;
  /** Server path, once uploaded. */
  path?: string;
  error?: string;
  file?: File;
}

export const MAX_ATTACHMENTS = 10;

export function isImageFile(file: File): boolean {
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

function restored(path: string, previewUrl: (path: string) => string): Attachment {
  return { id: crypto.randomUUID(), url: localImageUrl(path) ?? previewUrl(path), status: "ready", path };
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
    if (item.file && !isLocalImageUrl(item.url)) URL.revokeObjectURL(item.url);
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
      rememberLocalImage(result.path, item.url);
      patch(id, { status: "ready", path: result.path, error: undefined });
    } else patch(id, { status: "error", error: result.error });
  }

  /** Attach and upload. Returns how many files were refused (not images, or over the limit). */
  function add(files: Iterable<File>): number {
    const list = [...files];
    const room = MAX_ATTACHMENTS - itemsRef.current.length;
    const accepted = list.filter(isImageFile).slice(0, Math.max(0, room));
    const added = accepted.map((file) => ({ id: crypto.randomUUID(), url: URL.createObjectURL(file), status: "uploading" as const, file }));
    if (added.length) commit([...itemsRef.current, ...added]);
    added.forEach((item) => void start(item.id, item.file));
    return list.length - accepted.length;
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
