import { useState } from "react";
import { fileIcon } from "@/components/ui/file-icon";
import { ChevronRight, FileText, ImageIcon, LayoutTemplate, Lock } from "@/components/ui/icon";

import { ArtifactRow, isClaudeLink } from "@/components/activity/artifact-list";
import { FileOpenButton } from "@/components/file-open-dialog";
import { useArtifactMetadata } from "@/hooks/use-artifact-metadata";
import { formatClock, type ActivityArtifact } from "@/lib/activity";
import { paneFileUrl } from "@/lib/api";
import { artifactCandidate, artifactSections, fileExtension, type ChatFileReference } from "@/lib/chat-files";
import { cn } from "@/lib/utils";
import { FileLink } from "./file-link";

const ROW = "flex min-h-14 w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-inset focus-visible:ring-ring";
const TILE = "flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground";
const KIND_LABEL: Record<string, string> = { md: "Markdown", markdown: "Markdown", mdx: "Markdown", pdf: "PDF", html: "HTML page", htm: "HTML page" };

/** The time of day for today's turns, the date for older ones. */
function when(timestamp: string): string {
  const at = Date.parse(timestamp);
  if (Number.isNaN(at)) return "";
  return new Date(at).toDateString() === new Date().toDateString()
    ? formatClock(at)
    : new Date(at).toLocaleDateString([], { month: "short", day: "numeric" });
}

const caption = (...parts: string[]) => parts.filter(Boolean).join(" · ");

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return <section aria-label={title} className="mb-3">
    <h3 className="px-2 pb-1 text-xs text-muted-foreground">{title} <span className="tabular-nums text-muted-foreground/70">{count}</span></h3>
    {children}
  </section>;
}

/**
 * What the agent made and handed over in one conversation: pages it published on claude.ai, files
 * it delivered or linked, its designboards, and its images. A thumbnail is drawn only for an image
 * the bridge said it can serve; one beyond the pane's folder waits in a row of its own behind the
 * confirmed Open (ADR 0063). Holds no history of its own, so a sheet or a side panel can mount it
 * over the references it already scanned.
 */
export function ArtifactsPanel({ paneId, session, references, published = [], ready, onOpen }: {
  paneId: string;
  session?: string;
  /** Every file the conversation names ({@link chatFileReferences}). */
  references: ChatFileReference[];
  /** The session's claude.ai pages, as Activity reads them. */
  published?: ActivityArtifact[];
  /** The references are complete enough to ask the bridge about. */
  ready: boolean;
  onOpen: (path: string) => void;
}) {
  const candidates = references.filter(artifactCandidate).sort((a, b) => b.lastSeen.order - a.lastSeen.order).map((file) => file.path);
  const metadata = useArtifactMetadata(paneId, session, candidates, ready);
  const found = new Map(metadata.found.map((item) => [item.path, item]));
  const sections = artifactSections(references, found);
  // A thumbnail that fails after all (the file went away since) becomes a plain row, never a grey card.
  const [broken, setBroken] = useState<ReadonlySet<string>>(new Set());
  const [outsideOpen, setOutsideOpen] = useState(false);
  const images = sections.images.filter((file) => !broken.has(file.path));
  const delivered = [...sections.delivered, ...sections.images.filter((file) => broken.has(file.path))];
  const claude = published.filter((artifact) => isClaudeLink(artifact.url));
  const empty = claude.length + delivered.length + images.length + sections.outside.length === 0;

  return <>
    {metadata.loading && <p role="status" className="mb-2 px-2 text-xs text-muted-foreground">Checking files…</p>}
    {metadata.error && <p role="status" className="mb-2 px-2 text-xs text-muted-foreground">Some files could not be checked.<button type="button" className="min-h-11 px-2 underline" onClick={metadata.retry}>Retry</button></p>}

    <Section title="From Claude" count={claude.length}>
      <ul>{claude.map((artifact) => <li key={artifact.id}><ArtifactRow artifact={artifact} className="px-2" /></li>)}</ul>
    </Section>

    <Section title="Delivered by the agent" count={delivered.length}>
      <ul>{delivered.map((file) => {
        const known = found.get(file.path);
        const board = known?.state === "preview" ? known.designboard : undefined;
        const Icon = board ? LayoutTemplate : fileIcon(file.name);
        const kind = board ? "Designboard" : KIND_LABEL[fileExtension(file)] ?? fileExtension(file).toUpperCase();
        const target = known && known.state !== "missing" ? known.resolved ?? file.path : file.path;
        return <li key={file.path}>
          <FileLink path={target} onOpen={() => onOpen(target)} label={`Open ${board ?? file.name}`} title={file.path} className={ROW}>
            <span className={cn(TILE, board && "text-primary")}><Icon aria-hidden="true" className="size-4" /></span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-footnote font-medium">{board ?? file.name}</span>
              <span className="block truncate text-xs text-muted-foreground">{caption(kind, when(file.lastSeen.timestamp))}</span>
            </span>
          </FileLink>
        </li>;
      })}</ul>
    </Section>

    <Section title="Images" count={images.length}>
      <div className="grid grid-cols-2 gap-3 px-2 sm:grid-cols-3">
        {images.map((file) => <FileLink key={file.path} path={file.src} onOpen={() => onOpen(file.src)} label={`Open ${file.name}`} title={file.path}
          className="group block min-w-0 text-left focus-visible:outline-none">
          <span className="block aspect-[4/3] overflow-hidden rounded-xl border bg-muted transition-colors group-hover:border-primary/40 group-focus-visible:ring-[3px] group-focus-visible:ring-ring">
            <img src={paneFileUrl(paneId, file.src, session)} alt="" loading="lazy" className="size-full object-contain"
              onError={() => setBroken((known) => new Set(known).add(file.path))} />
          </span>
          <span className="mt-1.5 block truncate text-footnote font-medium">{file.name}</span>
          <span className="block truncate text-xs text-muted-foreground">{caption(fileExtension(file).toUpperCase(), when(file.lastSeen.timestamp))}</span>
        </FileLink>)}
      </div>
    </Section>

    {sections.outside.length > 0 && <div className="mx-2 mb-3 rounded-xl border border-dashed">
      <button type="button" aria-expanded={outsideOpen} onClick={() => setOutsideOpen((open) => !open)} className={cn(ROW, "px-3")}>
        <Lock aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1">
          <span className="block text-footnote">{sections.outside.length} {sections.outside.length === 1 ? "image" : "images"} named outside the pane's folder</span>
          <span className="block text-xs text-muted-foreground">No preview. Open asks you first.</span>
        </span>
        <ChevronRight aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", outsideOpen && "rotate-90")} />
      </button>
      {outsideOpen && <ul className="border-t border-dashed px-1 py-1">{sections.outside.map((file) => <li key={file.path}>
        <FileOpenButton paneId={paneId} session={session} path={file.path} label={`Open ${file.name}`} className={ROW}>
          <span className={TILE}><ImageIcon aria-hidden="true" className="size-4" /></span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-footnote font-medium">{file.name}</span>
            <span className="block truncate font-mono text-caption text-muted-foreground">{file.path}</span>
          </span>
        </FileOpenButton>
      </li>)}</ul>}
    </div>}

    {metadata.more && <button type="button" className="mx-2 min-h-11 text-xs underline" onClick={metadata.loadMore}>Check older files</button>}

    {empty && ready && !metadata.loading && <div className="rounded-xl border border-dashed px-5 py-10 text-center">
      <FileText aria-hidden="true" className="mx-auto mb-3 size-7 text-muted-foreground/60" />
      <p className="text-footnote font-medium">No artifacts in this conversation</p>
      <p className="mt-1 text-xs text-muted-foreground">Files the agent sends or links, its designboards and claude.ai pages show up here. Project and Files list the rest.</p>
    </div>}
  </>;
}
