import { useContext, useState } from "react";
import { ImageIcon } from "lucide-react";

import { FileMediaContext, FilePreviewContext } from "@/lib/file-preview-context";
import { localImageUrl } from "@/lib/local-sends";
import { imageLabel } from "@/lib/message-images";
import type { TranscriptImagePart } from "@/lib/types";
import { cn } from "@/lib/utils";
import { MediaViewerContext, type PreviewItem } from "./file-preview-provider";

export interface StripImage { src?: string; label: string; item: PreviewItem }

/** Thumbnails that open together as one gallery, so previous and next walk the same set. */
export function ImageStrip({ images, size = "md", className, label = "Images", max }: {
  images: readonly StripImage[];
  size?: "sm" | "md";
  className?: string;
  label?: string;
  /** Show this many and a "+N" tile that opens the rest, so a long turn stays one row. */
  max?: number;
}) {
  const viewer = useContext(MediaViewerContext);
  const openFile = useContext(FilePreviewContext);
  if (!images.length) return null;
  const shown = max !== undefined && images.length > max + 1 ? images.slice(0, max) : images;
  const more = images.length - shown.length;
  const open = (index: number) => {
    if (viewer) return () => viewer.open(images.map((image) => image.item), index);
    const item = images[index]!.item;
    return item.kind === "file" && openFile ? () => openFile(item.path) : undefined;
  };
  return (
    <ul className={cn("flex flex-wrap gap-2", className)} aria-label={label}>
      {shown.map((image, index) => (
        <li key={`${index}:${image.item.kind === "file" ? image.item.path : `${image.item.entry}:${image.item.index}`}`}>
          <Thumbnail src={image.src} label={image.label} size={size} onOpen={open(index)} />
        </li>
      ))}
      {more > 0 && <li><button type="button" onClick={open(shown.length)} aria-label={`Open ${more} more images`}
        className={cn("grid min-h-11 place-items-center rounded-lg border border-border/60 bg-muted text-xs text-muted-foreground", size === "sm" ? "size-10" : "size-20")}>+{more}</button></li>}
    </ul>
  );
}

/**
 * The images a sent (or queued) message carries, as labelled thumbnails — never as paths. An image
 * this client uploaded shows from its local copy, so a just-sent message never flashes a broken
 * preview while the journal catches up; anything else comes through the pane's file preview.
 */
export function MessageImages({ paths, size = "md", className }: { paths: readonly string[]; size?: "sm" | "md"; className?: string }) {
  const url = useContext(FileMediaContext);
  return <ImageStrip size={size} className={className} images={paths.map((path, index) => ({
    src: localImageUrl(path) ?? url?.(path),
    label: imageLabel(index),
    item: { kind: "file", path },
  }))} />;
}

/** Images the journal holds inline for one entry (a pasted screenshot, what a tool showed the agent). */
export function JournalImages({ entry, images, size = "md", className, label }: { entry: string; images: readonly Pick<TranscriptImagePart, "index">[]; size?: "sm" | "md"; className?: string; label?: string }) {
  const viewer = useContext(MediaViewerContext);
  return <ImageStrip size={size} className={className} label={label} images={images.map(({ index }, i) => ({
    src: viewer?.journalUrl(entry, index),
    label: imageLabel(i),
    item: { kind: "journal", entry, index, label: imageLabel(i) },
  }))} />;
}

function Thumbnail({ src, label, size, onOpen }: { src?: string; label: string; size: "sm" | "md"; onOpen?: () => void }) {
  const [failed, setFailed] = useState(false);
  const box = size === "sm" ? "size-10" : "size-20";
  const content = (
    <>
      <span className={cn("grid place-items-center overflow-hidden rounded-lg border border-border/60 bg-muted", box)}>
        {src && !failed ? (
          <img src={src} alt={label} loading="lazy" decoding="async" className="size-full object-cover" onError={() => setFailed(true)} />
        ) : (
          <ImageIcon aria-label={label} className="size-4 text-muted-foreground" />
        )}
      </span>
      {size === "md" && <span className="text-[11px] text-muted-foreground">{label}</span>}
    </>
  );
  const shape = "flex flex-col items-start gap-1";
  return onOpen ? (
    <button type="button" className={cn(shape, "min-h-11 rounded-lg")} onClick={onOpen} aria-label={`Open ${label}`}>
      {content}
    </button>
  ) : (
    <span className={shape}>{content}</span>
  );
}
