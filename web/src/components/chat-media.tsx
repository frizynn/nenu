import { useContext, useMemo, useState } from "react";
import {
  FileMediaContext,
  FilePreviewContext,
} from "@/lib/file-preview-context";
import { filePathsInText, markdownImagePaths } from "@/lib/chat-files";
import { IMAGE_EXTENSION, splitMessageImages } from "@/lib/message-images";
import { FoundFileCards, useFoundFiles } from "./artifact-card";
import { FileLink } from "./file-link";
import { MediaViewerContext } from "./file-preview-provider";
import { MessageImages } from "./message-images";

const VIDEO = /\.(mp4|m4v|mov|webm)$/i;

export function ChatMedia({ text, compact = false, uploads = true }: { text: string; compact?: boolean; uploads?: boolean }) {
  const url = useContext(FileMediaContext);
  const viewer = useContext(MediaViewerContext);
  const openFile = useContext(FilePreviewContext);
  const { carried, named, pages } = useMemo(() => {
    const inline = new Set(markdownImagePaths(text));
    const paths = [...new Set(filePathsInText(text))].filter((path) => !inline.has(path));
    // The operator's own message: its images read as "Image 1…N" thumbnails, not as files.
    const carried = compact ? splitMessageImages(text).images : [];
    return {
      carried,
      named: paths.filter((path) => (IMAGE_EXTENSION.test(path) || VIDEO.test(path)) && !carried.includes(path)).slice(0, 12),
      pages: compact ? [] : paths.filter((path) => /\.html?$/i.test(path)).slice(0, 6),
    };
  }, [text, compact]);
  // Nothing is offered before the bridge finds it: a name with nothing behind it draws nothing.
  const found = useFoundFiles(url ? [...named, ...pages] : []);
  if (!url) return null;
  const images = uploads ? carried : [];
  const media = named.flatMap((path) => found.get(path) ?? []);
  // A picture shows from where the bridge found it; one beyond the folder opens only from its card.
  const shown = media.flatMap((file) => file.state === "preview" ? [file.resolved ?? file.path] : []);
  const cards = [...media.filter((file) => file.state === "outside"), ...pages.flatMap((path) => found.get(path) ?? [])];
  // Nothing to show draws nothing: every message runs through here, and most name no media.
  if (!images.length && !shown.length && !cards.length) return null;
  const gallery = shown.filter((path) => !VIDEO.test(path));
  const open = (path: string) => {
    if (viewer && gallery.includes(path)) viewer.open(gallery.map((p) => ({ kind: "file", path: p })), gallery.indexOf(path));
    else openFile?.(path);
  };
  return (
    <div className="space-y-2">
      <MessageImages paths={images} className="pt-1" />
      {shown.map((path) => (
        <Media
          key={path}
          path={path}
          compact={compact}
          url={url(path)}
          open={() => open(path)}
        />
      ))}
      <FoundFileCards files={cards} />
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
      <FileLink path={path} onOpen={open} className="inline-flex min-h-11 items-center text-xs text-primary underline">
        Open {name}
      </FileLink>
    );
  return (
    <figure className={`my-2 overflow-hidden rounded-lg border border-border/50 ${compact ? "max-w-40" : "max-w-lg"}`}>
      {VIDEO.test(path) ? (
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
        <FileLink path={path} onOpen={open} label={`Open ${name}`} className="block w-full">
          <img
            src={url}
            alt={name}
            loading="lazy"
            decoding="async"
            className={`${compact ? "max-h-32" : "max-h-80"} w-full object-contain`}
            onError={() => setFailed(true)}
          />
        </FileLink>
      )}
      <figcaption className="truncate px-2 py-1 text-xs text-muted-foreground">
        {name}
      </figcaption>
    </figure>
  );
}
