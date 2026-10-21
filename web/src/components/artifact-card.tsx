import { useContext, useEffect, useState } from "react";
import { FileText, Globe, LayoutTemplate } from "@/components/ui/icon";

import { fetchArtifactMetadata, type ArtifactMetadata } from "@/lib/api";
import { FilePreviewContext } from "@/lib/file-preview-context";
import { cn } from "@/lib/utils";
import { FileLink } from "./file-link";
import { MediaViewerContext } from "./file-preview-provider";

// A file the agent made or delivered, as a card in the chat. The card never mounts the document:
// an HTML page only runs once the operator opens the viewer, so a long thread full of artifacts
// costs no renderer and no request beyond one small metadata read.

const isHtml = (path: string) => /\.html?$/i.test(path);

function describe(path: string, designboard: string | undefined): { title: string; sub: string; Icon: typeof Globe } {
  const name = path.split("/").at(-1) ?? path;
  if (designboard) return { title: designboard, sub: `designboard · ${name}`, Icon: LayoutTemplate };
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")).split("/").at(-1) : "";
  const kind = isHtml(path) ? "HTML page" : (name.split(".").at(-1) ?? "file").toUpperCase();
  return { title: name, sub: folder ? `${kind} · ${folder}/` : kind, Icon: isHtml(path) ? Globe : FileText };
}

/** A file's card: `open` opens `path` (the file the bridge found), the card shows `name` as the chat says it. */
export function ArtifactCard({ path, name = path, designboard, open }: { path: string; name?: string; designboard?: string; open?: () => void }) {
  const { title, sub, Icon } = describe(name, designboard);
  const body = <>
    <span className="grid h-12 w-[4.5rem] shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground"><Icon className="size-5" aria-hidden="true" /></span>
    <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
      <span className="truncate text-footnote font-medium">{title}</span>
      <span className="truncate text-xs text-muted-foreground">{sub}</span>
    </span>
    {open && <span className="shrink-0 px-1 text-xs text-muted-foreground">Open</span>}
  </>;
  const className = "flex w-full max-w-lg min-w-0 items-center gap-3 rounded-xl border bg-card p-2.5 text-left transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none";
  return open
    ? <FileLink path={path} onOpen={open} label={`Open ${title}`} title={path} className={className}>{body}</FileLink>
    : <div title={path} className={cn(className, "opacity-70")}>{body}</div>;
}

/** A name the bridge found a file behind. */
export type FoundFile = Exclude<ArtifactMetadata, { state: "missing" }>;

/**
 * The files of `paths` the bridge found, by the name the chat used, once it has answered. A name it
 * found nothing behind, or has not answered for yet, is absent: the chat offers only what opens.
 */
export function useFoundFiles(paths: readonly string[]): ReadonlyMap<string, FoundFile> {
  const viewer = useContext(MediaViewerContext);
  const [found, setFound] = useState<ReadonlyMap<string, FoundFile>>(new Map());
  const key = JSON.stringify(paths);
  const paneId = viewer?.paneId;
  const session = viewer?.session;
  useEffect(() => {
    const wanted: string[] = JSON.parse(key);
    if (!paneId || !wanted.length) return;
    const controller = new AbortController();
    // Twenty names a request keeps its URL short; a turn that hands over more still gets every card.
    const batches = Array.from({ length: Math.ceil(wanted.length / 20) }, (_, i) => wanted.slice(i * 20, i * 20 + 20));
    Promise.all(batches.map((batch) => fetchArtifactMetadata(paneId, batch, session, controller.signal))).then((answers) => setFound((known) => new Map([
      ...known,
      ...answers.flat().flatMap((entry) => entry.state === "missing" ? [] : [[entry.path, entry] as const]),
    ])), () => {});
    return () => controller.abort();
  }, [paneId, session, key]);
  return found;
}

/** Cards for found files, each opening the file the bridge found under its name. */
export function FoundFileCards({ files }: { files: readonly FoundFile[] }) {
  const viewer = useContext(MediaViewerContext);
  const openFile = useContext(FilePreviewContext);
  if (!files.length) return null;
  const open = (path: string) => viewer ? viewer.open([{ kind: "file", path }]) : openFile?.(path);
  return (
    <div className="flex flex-col gap-2" aria-label="Artifacts">
      {files.map((file) => {
        const target = file.resolved ?? file.path;
        return <ArtifactCard key={file.path} path={target} name={file.path}
          designboard={file.state === "preview" ? file.designboard : undefined}
          open={viewer || openFile ? () => open(target) : undefined} />;
      })}
    </div>
  );
}

/** Cards for a turn's artifacts, once the bridge finds each one. */
export function ArtifactCards({ paths }: { paths: readonly string[] }) {
  const found = useFoundFiles(paths);
  return <FoundFileCards files={paths.flatMap((path) => found.get(path) ?? [])} />;
}
