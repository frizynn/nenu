import { useCallback, useContext, useEffect, useState } from "react";
import { FileText, Globe, LayoutTemplate } from "lucide-react";

import { fetchArtifactMetadata, type ArtifactMetadata } from "@/lib/api";
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

/** `missing`: the bridge found nothing by that name; a tap asks it again rather than opening a 404. */
export function ArtifactCard({ path, designboard, missing = false, onOpen }: { path: string; designboard?: string; missing?: boolean; onOpen?: () => void }) {
  const { title, sub, Icon } = describe(path, designboard);
  return (
    <button type="button" disabled={!onOpen} onClick={onOpen} aria-label={missing ? `${title}: file not found` : `Open ${title}`} title={path}
      className="flex w-full max-w-lg min-w-0 items-center gap-3 rounded-xl border bg-card p-2.5 text-left transition-colors hover:bg-accent/30 focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:outline-none disabled:opacity-70">
      <span className="grid h-12 w-[4.5rem] shrink-0 place-items-center rounded-md border bg-muted text-muted-foreground"><Icon className="size-5" aria-hidden="true" /></span>
      <span className="flex min-w-0 flex-1 flex-col gap-0.5 leading-tight">
        <span className={`truncate text-sm font-medium${missing ? " text-muted-foreground line-through" : ""}`}>{title}</span>
        <span className="truncate text-xs text-muted-foreground">{sub}</span>
      </span>
      {onOpen && <span className="shrink-0 px-1 text-xs text-muted-foreground">{missing ? "Not found" : "Open"}</span>}
    </button>
  );
}

/**
 * Cards for a turn's artifacts. The bridge says where each name leads before the card offers it:
 * a name relative to another folder opens at the file it found, and a name with nothing behind it
 * says so instead of opening a 404.
 */
export function ArtifactCards({ paths }: { paths: readonly string[] }) {
  const viewer = useContext(MediaViewerContext);
  const openFile = useContext(FilePreviewContext);
  const [found, setFound] = useState<ReadonlyMap<string, ArtifactMetadata>>(new Map());
  const key = JSON.stringify(paths.slice(0, 20));
  const paneId = viewer?.paneId;
  const session = viewer?.session;
  const ask = useCallback(async (wanted: string[], signal?: AbortSignal) => {
    if (!paneId || !wanted.length) return [];
    const answers = await fetchArtifactMetadata(paneId, wanted, session, signal);
    setFound((known) => new Map([...known, ...answers.map((entry) => [entry.path, entry] as const)]));
    return answers;
  }, [paneId, session]);
  useEffect(() => {
    const controller = new AbortController();
    ask(JSON.parse(key), controller.signal).catch(() => {});
    return () => controller.abort();
  }, [ask, key]);
  if (!paths.length) return null;
  const canOpen = Boolean(viewer || openFile);
  const show = (path: string) => viewer ? viewer.open([{ kind: "file", path }]) : openFile?.(path);
  return (
    <div className="flex flex-col gap-2" aria-label="Artifacts">
      {paths.map((path) => {
        const known = found.get(path);
        if (known?.state !== "missing") return <ArtifactCard key={path} path={path}
          designboard={known?.state === "preview" ? known.designboard : undefined}
          onOpen={canOpen ? () => show(known?.resolved ?? path) : undefined} />;
        // Named before it was written, or removed since: look again, and open only what is there.
        const recheck = () => void ask([path]).then(([answer]) => {
          if (answer && answer.state !== "missing") show(answer.resolved ?? path);
        }, () => {});
        return <ArtifactCard key={path} path={path} missing onOpen={canOpen ? recheck : undefined} />;
      })}
    </div>
  );
}
