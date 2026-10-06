import { useContext, useState } from "react";
import { ImageIcon } from "lucide-react";

import { FileMediaContext, FilePreviewContext } from "@/lib/file-preview-context";
import { localImageUrl } from "@/lib/local-sends";
import { imageLabel } from "@/lib/message-images";
import { cn } from "@/lib/utils";

/**
 * The images a sent (or queued) message carries, as labelled thumbnails — never as paths. An image
 * this client uploaded shows from its local copy, so a just-sent message never flashes a broken
 * preview while the journal catches up; anything else comes through the pane's file preview.
 */
export function MessageImages({ paths, size = "md", className }: { paths: readonly string[]; size?: "sm" | "md"; className?: string }) {
  const url = useContext(FileMediaContext);
  const open = useContext(FilePreviewContext);
  if (!paths.length) return null;
  return (
    <ul className={cn("flex flex-wrap gap-2", className)} aria-label="Images">
      {paths.map((path, index) => (
        <li key={path}>
          <Thumbnail src={localImageUrl(path) ?? url?.(path)} label={imageLabel(index)} size={size} onOpen={open ? () => open(path) : undefined} />
        </li>
      ))}
    </ul>
  );
}

function Thumbnail({ src, label, size, onOpen }: { src?: string; label: string; size: "sm" | "md"; onOpen?: () => void }) {
  const [failed, setFailed] = useState(false);
  const box = size === "sm" ? "size-10" : "size-20";
  const content = (
    <>
      <span className={cn("grid place-items-center overflow-hidden rounded-lg border border-border/60 bg-muted", box)}>
        {src && !failed ? (
          <img src={src} alt={label} loading="lazy" className="size-full object-cover" onError={() => setFailed(true)} />
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
