import { useContext, useEffect, useState } from "react";
import { FileText, Globe, LayoutTemplate } from "lucide-react";

import { fetchArtifactMetadata } from "@/lib/api";
import { FilePreviewContext } from "@/lib/file-preview-context";
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

export function ArtifactCard({ path, designboard, onOpen }: { path: string; designboard?: string; onOpen?: () => void }) {
  const { title, sub, Icon } = describe(path, designboard);
  return (
    <button type="button" disabled={!onOpen} onClick={onOpen} aria-label={`Open ${title}`} title={path}
      className="flex w-full max-w-lg min-w-0 items-center gap-3 rounded-xl border bg-card p-2.5 text-left transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none disabled:opacity-70">
      <span className="grid h-12 w-[4.5rem] shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground"><Icon className="size-5" aria-hidden="true" /></span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
        <span className="truncate text-sm font-medium">{title}</span>
        <span className="truncate text-xs text-muted-foreground">{sub}</span>
      </span>
      {onOpen && <span className="shrink-0 px-1 text-xs text-muted-foreground">Open</span>}
    </button>
  );
}

/** Cards for a turn's artifacts; HTML ones ask the bridge once whether they are designboards. */
export function ArtifactCards({ paths }: { paths: readonly string[] }) {
  const viewer = useContext(MediaViewerContext);
  const openFile = useContext(FilePreviewContext);
  const [titles, setTitles] = useState<ReadonlyMap<string, string>>(new Map());
  const html = paths.filter(isHtml).slice(0, 20);
  const key = JSON.stringify(html);
  const paneId = viewer?.paneId;
  const session = viewer?.session;
  useEffect(() => {
    const wanted: string[] = JSON.parse(key);
    if (!paneId || !wanted.length) return;
    const controller = new AbortController();
    fetchArtifactMetadata(paneId, wanted, session, controller.signal)
      .then((found) => setTitles(new Map(found.map((entry) => [entry.path, entry.title]))))
      .catch(() => {});
    return () => controller.abort();
  }, [paneId, session, key]);
  if (!paths.length) return null;
  return (
    <div className="flex flex-col gap-2" aria-label="Artifacts">
      {paths.map((path) => <ArtifactCard key={path} path={path} designboard={titles.get(path)}
        onOpen={viewer ? () => viewer.open([{ kind: "file", path }]) : openFile ? () => openFile(path) : undefined} />)}
    </div>
  );
}
