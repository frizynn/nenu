import { useContext, useMemo, useState } from "react";
import {
  FileMediaContext,
  FilePreviewContext,
} from "@/lib/file-preview-context";
import { filePathsInText } from "@/lib/chat-files";
import { splitMessageImages } from "@/lib/message-images";
import { MessageImages } from "./message-images";

export function ChatMedia({ text, compact = false }: { text: string; compact?: boolean }) {
  const url = useContext(FileMediaContext);
  const open = useContext(FilePreviewContext);
  const paths = useMemo(
    () =>
      [...new Set(filePathsInText(text))]
        .filter((path) =>
          /\.(png|jpe?g|gif|webp|mp4|m4v|mov|webm)$/i.test(path),
        )
        .slice(0, 12),
    [text],
  );
  if (!url) return null;
  // The operator's own message: its images read as "Image 1…N" thumbnails, not as files.
  const images = compact ? splitMessageImages(text).images : [];
  return (
    <div className="space-y-2">
      <MessageImages paths={images} className="pt-1" />
      {paths.filter((path) => !images.includes(path)).map((path) => (
        <Media
          key={path}
          path={path}
          compact={compact}
          url={url(path)}
          open={() => open?.(path)}
        />
      ))}
    </div>
  );
}
function Media({
  path,
  url,
  open,
  compact,
}: {
  path: string;
  url: string;
  open: () => void;
  compact: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const name = path.split("/").at(-1) ?? path;
  if (failed)
    return (
      <button
        type="button"
        onClick={open}
        className="min-h-11 text-xs text-primary underline"
      >
        Open {name}
      </button>
    );
  return (
    <figure className={`my-2 overflow-hidden rounded-lg border border-border/50 ${compact ? "max-w-40" : "max-w-lg"}`}>
      {/\.(mp4|m4v|mov|webm)$/i.test(path) ? (
        <video
          src={url}
          controls
          playsInline
          preload="metadata"
          aria-label={name}
          className="max-h-80 w-full"
          onError={() => setFailed(true)}
        />
      ) : (
        <button
          type="button"
          onClick={open}
          aria-label={`Open ${name}`}
          className="block w-full"
        >
          <img
            src={url}
            alt={name}
            loading="lazy"
            className={`${compact ? "max-h-32" : "max-h-80"} w-full object-contain`}
            onError={() => setFailed(true)}
          />
        </button>
      )}
      <figcaption className="truncate px-2 py-1 text-xs text-muted-foreground">
        {name}
      </figcaption>
    </figure>
  );
}
