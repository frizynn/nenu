import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";

import { cn } from "@/lib/utils";
import { ImageViewer, reducedMotion, type ViewerImage } from "./image-viewer";
import "./file-preview.css";

/**
 * A report's captures, large: the file preview's own image viewer and layer, stepping through one
 * card's pictures, each named by its caption. Loaded only when a capture is opened.
 */
export default function CaptureViewer({ images, start, onClose }: { images: readonly ViewerImage[]; start: number; onClose: () => void }) {
  const [index, setIndex] = useState(start);
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
  const [leaving, setLeaving] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const exit = useRef(0);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus({ preventScroll: true });
    return () => {
      window.clearTimeout(exit.current);
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  const current = images[index]!;
  const step = (by: number) => setIndex((at) => Math.min(images.length - 1, Math.max(0, at + by)));
  /** Leave with the layer still mounted for its fade, as the file preview does. */
  const close = () => {
    if (exit.current) return;
    setLeaving(true);
    exit.current = window.setTimeout(onClose, reducedMotion() ? 120 : 150);
  };
  const mark = (src: string, broken: boolean) => setFailed((set) => {
    if (set.has(src) === broken) return set;
    const next = new Set(set);
    if (broken) next.add(src);
    else next.delete(src);
    return next;
  });
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    } else if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      event.preventDefault();
      step(event.key === "ArrowLeft" ? -1 : 1);
    }
  };
  return createPortal(
    <div className={cn("file-preview-backdrop", "file-preview-backdrop--image")} data-leaving={leaving ? "" : undefined}
      onClick={(event) => { if (event.target === event.currentTarget) close(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-label={current.label} tabIndex={-1} onKeyDown={onKeyDown} className="file-preview-panel file-preview-panel--image">
        <ImageViewer images={images} index={index} name={current.label} downloadUrl={current.src}
          error={failed.has(current.src) ? <p className="p-4 text-sm">Could not load this picture.</p> : undefined}
          onStep={step} onClose={close} onDismissed={onClose} onImageError={(src) => mark(src, true)} onImageLoad={(src) => mark(src, false)} />
      </div>
    </div>,
    document.body,
  );
}
